// No-overlap check for the route globe, measured from the rendered meshes.
// Needs Playwright with Chromium, which the app does not depend on: `npm i -g playwright`,
// `npx playwright install chromium`, then point Node at the global install:
// `export NODE_PATH="$(npm root -g)"` (PowerShell: `$env:NODE_PATH = (npm root -g)`).
// Run against the replay backend: `pnpm dev`, then `node qa/overlap-check.cjs [outDir]`.
// Set VIEWPORT=WxH@scale for another window size, for example VIEWPORT=1100x700@1.5.
// For each view it takes every visible label card's box, every server box (all 8 corners)
// and every route tube triangle to screen, and counts label-label, label-box (own box included),
// label-line and box-box overlaps. Exit code 1 if any view has one.
// The short-route case adds an 8-hop route that never leaves the Pittsburgh area. Its addresses
// are documentation addresses (198.51.100.0/24), not real hosts.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.env.GLOBE_URL || 'http://127.0.0.1:1420/';
const OUT = path.resolve(process.argv[2] || 'qa-out');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHORT = '198.51.100.20';
const SHORT_PATCH = `
;GEO["${SHORT}"] = { city: "Pittsburgh", regionName: "Pennsylvania", country: "United States", lat: 40.441, lon: -79.996, isp: "Cloudflare", as: "AS13335 Cloudflare, Inc." };
TRACES["${SHORT}"] = [...COMCAST_HEAD, ["96.110.42.165", [15, 16, 17]], ["${SHORT}", [18, 18, 19]]];
CONNS.push({ pid: 8100, process: "warp-svc", proto: "tcp", local: "10.0.0.106:53000", remote_ip: "${SHORT}", remote_port: 443, state: "ESTABLISHED" });
`;

async function open(browser) {
  // VIEWPORT=1100x700@1.5 checks a smaller window at Windows' 150% scaling.
  const [, w, h, dpr] = (process.env.VIEWPORT || '1480x920@1').match(/^(\d+)x(\d+)@([\d.]+)$/) || [, 1480, 920, 1];
  const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +dpr });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.route('**/src/main.ts*', async (route) => {
    const r = await route.fetch();
    route.fulfill({ response: r, body: (await r.text()) + '\n;window.__state = state; window.__globe = globe;' });
  });
  await page.route('**/src/backend.ts*', async (route) => {
    const r = await route.fetch();
    route.fulfill({ response: r, body: (await r.text()).replace('const PING', SHORT_PATCH + '\nconst PING') });
  });
  await page.goto(URL);
  await page.waitForFunction(() => window.__state && window.__state.home && window.__state.conns.length > 0, null, { timeout: 30000 });
  return { ctx, page, errors };
}

async function select(page, ip) {
  await page.locator(`#dests li[data-key*=":${ip}:"]`).first().click();
  await page.waitForFunction((ip) => window.__state.traces.get(ip)?.done, ip, { timeout: 20000 });
  await sleep(600);
}

async function view(page, pov) {
  await page.evaluate((p) => window.__globe.g.pointOfView(p, 0), pov);
  // Let the camera settle and the final layout run.
  await sleep(700);
}

/** Measure overlaps in the current frame, from the meshes three-globe drew. */
function measure() {
  const g = window.__globe.g;
  const cam = g.camera();
  cam.updateMatrixWorld();
  const scene = g.scene();
  scene.updateMatrixWorld(true);
  const W = g.width(), H = g.height();
  const R = g.getGlobeRadius();
  const camDir = cam.position.clone().normalize();
  const rim = R / cam.position.length();
  const V = cam.position.constructor;
  // In front of the horizon and in front of the camera: a long line can arc up past a low camera,
  // and points behind it project mirrored.
  const visible = (v) => v.clone().normalize().dot(camDir) > rim && Math.abs(v.clone().project(cam).z) < 1;
  const proj = (v) => { const q = v.clone().project(cam); return [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H]; };
  const hull = (pts) => {
    const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  };
  // Separating axis test with 0.5 px tolerance, so shapes that only touch do not count.
  const hit = (A, B) => {
    for (const P of [A, B]) for (let i = 0; i < P.length; i++) {
      const [px, py] = P[i], [qx, qy] = P[(i + 1) % P.length];
      let nx = qy - py, ny = px - qx; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      const pa = A.map(([x, y]) => x * nx + y * ny), pb = B.map(([x, y]) => x * nx + y * ny);
      if (Math.max(...pa) <= Math.min(...pb) + 0.5 || Math.max(...pb) <= Math.min(...pa) + 0.5) return false;
    }
    return true;
  };
  const labels = [], boxes = [], tris = [];
  // Labels are HTML cards over the globe: measure each visible card as laid out on screen.
  const host = g.renderer().domElement.getBoundingClientRect();
  for (const el of document.querySelectorAll('.gcards:not(.measure) .gcard')) {
    if (el.style.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const [x0, y0, x1, y1] = [r.left - host.left, r.top - host.top, r.right - host.left, r.bottom - host.top];
    labels.push({ text: el.textContent, q: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
  }
  scene.traverse((o) => {
    if (o.__globeObjType === 'object') {
      const mesh = o.children[0]?.children?.[0]?.children?.find((m) => m.isMesh);
      if (!mesh) return;
      mesh.geometry.computeBoundingBox();
      const b = mesh.geometry.boundingBox;
      const c = [];
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) c.push(new V(x, y, z).applyMatrix4(mesh.matrixWorld));
      if (!c.some(visible)) return;
      boxes.push({ name: o.__data?.label ?? '', q: hull(c.map(proj)) });
    } else if (o.__globeObjType === 'arc') {
      // A route's glow and the pulse running along it are light, not lines: only the route and its shadow count.
      if (o.__data?.layer === 'glow' || o.__data?.layer === 'pulse') return;
      o.traverse((m) => {
        if (!m.isMesh || !m.geometry?.attributes?.position) return;
        const pos = m.geometry.attributes.position, idx = m.geometry.index;
        const n = idx ? idx.count : pos.count;
        const v = (i) => new V().fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m.matrixWorld);
        for (let i = 0; i + 2 < n; i += 3) {
          const t = [v(i), v(i + 1), v(i + 2)];
          if (!t.every(visible)) continue;
          tris.push(t.map(proj));
        }
      });
    }
  });
  const out = { labels: labels.length, boxes: boxes.length, labelLabel: [], labelBox: [], labelLine: [], boxBox: 0, offscreen: [] };
  for (let i = 0; i < labels.length; i++) {
    const L = labels[i];
    if (L.q.some(([x, y]) => x < 0 || y < 0 || x > W || y > H)) out.offscreen.push(L.text);
    for (let j = i + 1; j < labels.length; j++) if (hit(L.q, labels[j].q)) out.labelLabel.push(`${L.text} / ${labels[j].text}`);
    for (const b of boxes) if (hit(L.q, b.q)) out.labelBox.push(`${L.text} / ${b.name}`);
    const lines = tris.filter((t) => hit(L.q, t)).length;
    if (lines) out.labelLine.push(`${L.text} (${lines} tris)`);
  }
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) if (hit(boxes[i].q, boxes[j].q)) out.boxBox++;
  return out;
}

const PGH = { lat: 40.38, lng: -79.85 };
const CASES = [
  { name: 'lol', ip: '192.207.0.5', views: [{ alt: 3.5 }, { alt: 1.2 }, { alt: 0.5 }, { alt: 0.25, ...PGH }, { alt: 0.12, ...PGH }] },
  { name: 'hillsboro', ip: '15.235.53.110', views: [{ alt: 2.5 }, { alt: 0.9 }, { alt: 0.3, ...PGH }] },
  { name: 'chrome', ip: '104.16.120.50', views: [{ alt: 0.6 }, { alt: 0.2, ...PGH }] },
  // Short route: every hop within about 40 km. Fit view first, then every zoom from wide to street level.
  { name: 'short', ip: SHORT, views: [{ fit: true }, { alt: 2.5, ...PGH }, { alt: 1, ...PGH }, { alt: 0.55, ...PGH }, { alt: 0.35, ...PGH }, { alt: 0.2, ...PGH }, { alt: 0.12, ...PGH }, { alt: 0.07, ...PGH }, { alt: 0.04, ...PGH }, { alt: 0.025, ...PGH },
    // Zoomed in with the route off centre: labels float above the boxes, so perspective pushes them sideways.
    { alt: 0.1, lat: 40.38, lng: -78.5 }, { alt: 0.1, lat: 40.38, lng: -81.2 }, { alt: 0.1, lat: 41.4, lng: -79.85 }, { alt: 0.1, lat: 39.4, lng: -79.85 },
    { alt: 0.05, lat: 39.9, lng: -79.1 }, { alt: 0.05, lat: 40.9, lng: -80.6 }] },
  // GeoIP files two Comcast routers in Philadelphia and New York (backend.ts MISPLACED). The RTT check
  // must pull them back next to their neighbours, so the drawn path stays local.
  { name: 'misplaced', ip: '198.51.100.30', maxPathKm: 100, estimated: 2, views: [{ fit: true }, { alt: 0.35, ...PGH }, { alt: 0.12, ...PGH }, { alt: 0.04, ...PGH }] },
  // Peak log open: the globe shrinks to the top half and draws the path picked in the drawer.
  ...[0, 1, 2].map((i) => ({ name: `peak-${'ABC'[i]}`, peak: i, views: [{ fit: true }, { alt: 1.2 }, { alt: 0.5 }, { alt: 0.25, ...PGH }] })),
  // Relay proof open: the direct route and the route via the relay drawn together. The replay serves
  // a gain first (direct via Ashburn), then no gain (direct via Chicago, sharing the relay's Riot hops).
  ...['gain', 'same'].map((name, i) => ({ name: `proof-${name}`, proof: i, views: [{ fit: true }, { alt: 1.2 }, { alt: 0.5 }, { alt: 0.25, ...PGH }, { alt: 0.12, lat: 41.6, lng: -87.9 }] })),
];

// SWEEP=n adds n seeded random views of the short route (zoom 0.02 to 1.5, centre up to most of a view away).
// CASES=short,lol limits the run to those cases.
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
for (let i = 0; i < +(process.env.SWEEP || 0); i++) {
  const alt = 0.02 * Math.pow(75, rnd());
  const span = alt * 25; // about half a view, in degrees
  CASES.find((c) => c.name === 'short').views.push({ alt: +alt.toFixed(3), lat: +(PGH.lat + (rnd() - 0.5) * span).toFixed(3), lng: +(PGH.lng + (rnd() - 0.5) * span * 1.3).toFixed(3) });
}
const ONLY = process.env.CASES ? process.env.CASES.split(',') : null;

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const { page, errors } = await open(browser);
  const rows = [];
  let focused = true;
  for (const c of CASES.filter((c) => !ONLY || ONLY.includes(c.name))) {
    if (c.name !== 'lol' && focused) {
      // Deselect the focused process so every destination is listed.
      await page.locator('#procs li[data-key="League of Legends"] .primary').click();
      await sleep(200);
      focused = false;
    }
    if (c.peak != null) {
      if ((await page.getAttribute('#viewPeak', 'aria-pressed')) !== 'true') await page.click('#viewPeak');
      await page.waitForFunction(() => window.__state.peak.summary?.paths.length, null, { timeout: 20000 });
    } else if (c.proof != null) {
      if ((await page.getAttribute('#viewProof', 'aria-pressed')) !== 'true') await page.click('#viewProof');
      await page.click('#proofRun');
      await page.waitForFunction(() => window.__state.proof.result && !window.__state.proof.running, null, { timeout: 30000 });
    } else await select(page, c.ip);
    if (c.maxPathKm != null) {
      const got = await page.evaluate((ip) => {
        const t = window.__state.traces.get(ip);
        return { km: Number(document.querySelectorAll('#routeStats b')[1]?.textContent), estimated: [...t.hops.values()].filter((h) => h.estimated).length };
      }, c.ip);
      const ok = got.km <= c.maxPathKm && got.estimated === c.estimated;
      console.log(ok ? 'PASS' : 'FAIL', `${c.name} path ${got.km} km (max ${c.maxPathKm}), ${got.estimated} estimated hops (want ${c.estimated})`);
      rows.push({ id: `${c.name}-geo`, ...got, pass: ok });
    }
    for (const v of c.views) {
      if (v.fit && c.peak != null) {
        // Picking a path in the drawer frames it.
        await page.locator('#peakPaths .r').nth(c.peak).click();
        await sleep(1600);
      } else if (v.fit && c.proof != null) {
        // Finishing a comparison frames both routes.
        await sleep(1600);
      } else if (v.fit) {
        await page.locator('#viewFit').click();
        await sleep(1600);
      } else {
        const cur = await page.evaluate(() => window.__globe.g.pointOfView());
        await view(page, { lat: v.lat ?? cur.lat, lng: v.lng ?? cur.lng, altitude: v.alt });
      }
      // A re-trace of the selected route clears its hops until they come back: measure a full route.
      if (c.peak == null && c.proof == null) await page.waitForFunction((ip) => window.__state.traces.get(ip)?.done, c.ip, { timeout: 20000 });
      // Wait for the layout to catch up with the camera (slow software rendering can take a while).
      await page.waitForFunction(() => { const g = window.__globe; const a = g.g.pointOfView().altitude; return Math.abs(g.layoutAlt - a) / a < 0.01; }, null, { timeout: 15000 }).catch(() => {});
      await sleep(300);
      const alt = (await page.evaluate(() => window.__globe.g.pointOfView())).altitude;
      const layoutAlt = await page.evaluate(() => window.__globe.layoutAlt);
      const m = await page.evaluate(measure);
      const id = `${c.name}-${v.fit ? 'fit' : v.alt}${v.lat != null && (v.lat !== PGH.lat || v.lng !== PGH.lng) ? `@${v.lat},${v.lng}` : ''}`;
      await page.screenshot({ path: path.join(OUT, `${id}.png`) });
      // The layout must be for the camera as it is now, or labels keep the size of another zoom.
      const stale = Math.abs(layoutAlt - alt) / alt > 0.01;
      // A view with no boxes measured means rendering or mesh discovery broke, not a clean view.
      if (!m.boxes) m.offscreen.push('(no boxes measured)');
      const bad = m.labelLabel.length + m.labelBox.length + m.labelLine.length + m.boxBox + m.offscreen.length + (stale ? 1 : 0);
      rows.push({ id, alt: +alt.toFixed(3), layoutAlt: +layoutAlt.toFixed(3), ...m, pass: bad === 0 });
      console.log(bad ? 'FAIL' : 'PASS', id, `alt ${alt.toFixed(3)}`, `layout ${layoutAlt.toFixed(3)}`, `labels ${m.labels}`, `boxes ${m.boxes}`, bad ? JSON.stringify({ labelLabel: m.labelLabel, labelBox: m.labelBox, labelLine: m.labelLine, boxBox: m.boxBox, offscreen: m.offscreen, stale }) : '');
    }
  }
  if (errors.length) console.log('console errors:', errors);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ rows, errors }, null, 2));
  await browser.close();
  const failed = rows.filter((r) => !r.pass).length;
  console.log(`${rows.length - failed}/${rows.length} views clean`);
  process.exit(failed || errors.length ? 1 : 0);
})();
