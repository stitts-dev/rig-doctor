// Monochrome globe. Black sphere, land as fine white outlines, routes as 3D tubes that bend
// with the globe. Grey dashed = the path packets take today. White solid = the best relay route.
// Dim = every other traced destination, so the globe shows the machine's whole footprint.
// Every node is a small server box with a white border, kept the same size on screen at any zoom.
// Nothing overlaps: for the current camera, boxes that would touch merge into one, routes that
// share a segment draw it once, and each label goes right of, below or above its box, wherever
// it clears every other label, every box (its own included) and every line.

import Globe, { type GlobeInstance } from "globe.gl";
import * as THREE from "three";

export interface ArcDatum {
  sLat: number;
  sLng: number;
  eLat: number;
  eLng: number;
  color: string | string[];
  /** Ignored: width comes from the zoom and the route's rank. */
  stroke: number;
  /** Ignored: height comes from the arc's ground distance. */
  alt: number;
  dash: boolean;
  label: string;
}

type Rank = 0 | 1 | 2;

/** Which arc wins a shared segment: 0 relay route (white), 1 selected route (dashed), 2 any other route. */
const rankOf = (a: ArcDatum): Rank => (Array.isArray(a.color) || a.color === "#ffffff" ? 0 : a.dash ? 1 : 2);

/** An arc as drawn: endpoints snapped to the merged boxes, height and width for this zoom. */
interface DrawnArc extends ArcDatum {
  rank: Rank;
}

export type NodeKind = "home" | "relay" | "hop";

export interface PointDatum {
  lat: number;
  lng: number;
  /** Plain text. Escaped before it reaches the tooltip. */
  label: string;
  /** Trusted HTML: callers escape every external value they put in it. */
  detail: string;
  kind: NodeKind;
  /** Selected route or relay: bright border and full size. */
  bright: boolean;
}

/** A label a node asks for. Priority 0-2 (home, relay, route end) never vanish: when crowded they join a neighbour's label. */
export interface LabelWant {
  p: PointDatum;
  text: string;
  prio: number;
}

/**
 * Where a label sits against its box: beside it (right, left), beside it but a line higher or
 * lower (right-up and so on), or centred below or above it. Every side placement is drawn as a
 * right-anchored three-globe label whose anchor is moved.
 */
type Orient = "right" | "left" | "bottom" | "top" | "right-up" | "right-down" | "left-up" | "left-down";

interface LabelDatum {
  /** Where three-globe anchors the text: beside, below or above the box. */
  lat: number;
  lng: number;
  text: string;
  orient: Orient;
  /** What three-globe is told. */
  dot: "right" | "bottom" | "top";
  /** Degrees to turn the text so it reads level on screen. */
  rot: number;
}

/** A box as drawn: one or more nodes that sit too close on screen to show apart. */
interface Node {
  p: PointDatum;
  /** Screen centre and half width in px; null when on the far side of the globe. */
  s: [number, number] | null;
  r: number;
  /** Screen outline of the whole box (all 8 corners), padded by NODE_GAP_PX; null when not on screen. */
  hull?: Pt[] | null;
}

type Pt = [number, number];

// Node box size in globe units per unit of camera altitude, so a node keeps its size on screen.
const NODE_PER_ALT = 1.1;
const SCALE: Record<NodeKind, number> = { home: 1.3, relay: 1.15, hop: 1 };
// Label text height in degrees per unit of camera altitude.
const LABEL_PER_ALT = 0.75;
// Label font metrics as fractions of text height, measured from three-globe's TextGeometry:
// average glyph advance, and the glyph box below and above the label's latitude.
const CHAR_W = 0.67;
const TEXT_BELOW = 0.81;
const TEXT_ABOVE = 0.54;
// Altitude change that counts as a zoom, so float noise in the camera does not rescale every frame.
const ALT_EPS = 0.002;
const LABEL_ALT = 0.012;
// Arc peak height per radian of ground distance, so a short hop stays low and a long one bends over the globe.
const ARC_ALT_PER_RAD = 0.25;
const ARC_ALT_MIN = 0.004;
const ARC_ALT_MAX = 0.16;
// Tube width in degrees per unit of camera altitude (about 3.2, 2.6 and 1.4 px on screen).
const STROKE_PER_ALT: Record<Rank, number> = { 0: 0.14, 1: 0.115, 2: 0.062 };
// Space kept between boxes, in px.
const NODE_GAP_PX = 3;
// Padding around label text, in text heights (about 4 px).
const LABEL_PAD = 0.25;
// Right of the box reads best, so it is tried first, then above, below and finally left.
const ORIENTS: Orient[] = ["right", "right-up", "right-down", "top", "bottom", "left", "left-up", "left-down"];
// How far away, in px, a crowded label may join another one.
const JOIN_PX = 120;
// Steepest a label's baseline may lean on screen, in radians (6 degrees).
const MAX_TILT = (6 * Math.PI) / 180;
const RANK: Record<NodeKind, number> = { home: 0, relay: 1, hop: 2 };
const nodeFactor = (d: PointDatum): number => SCALE[d.kind] * (d.bright || d.kind !== "hop" ? 1 : 0.6);
const key = (lat: number, lng: number): string => `${lat.toFixed(2)},${lng.toFixed(2)}`;

const reduceMotion = (): boolean => matchMedia("(prefers-reduced-motion: reduce)").matches;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Shared geometry and materials, so redrawing never leaks GPU memory.
const BOX = new THREE.BoxGeometry(1, 0.62, 0.5); // x wide, y deep, z up from the surface
const EDGES = new THREE.EdgesGeometry(BOX);
// Two drive-bay lines across the top face.
const BAYS = new THREE.BufferGeometry().setAttribute(
  "position",
  new THREE.Float32BufferAttribute([-0.38, -0.1, 0.251, 0.38, -0.1, 0.251, -0.38, 0.1, 0.251, 0.38, 0.1, 0.251], 3),
);
const FILL = new THREE.MeshBasicMaterial({ color: 0x000000 });
const LINE_BRIGHT = new THREE.LineBasicMaterial({ color: 0xffffff });
const LINE_DIM = new THREE.LineBasicMaterial({ color: 0x5a5a5a });
const LINE_HOME = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });

function serverNode(d: PointDatum): THREE.Object3D {
  const line = d.kind === "home" ? LINE_HOME : d.bright ? LINE_BRIGHT : LINE_DIM;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(BOX, FILL), new THREE.LineSegments(EDGES, line), new THREE.LineSegments(BAYS, line));
  g.position.z = 0.25; // sit on the surface instead of half inside it
  const wrap = new THREE.Group();
  wrap.add(g);
  wrap.userData.kind = d.kind;
  wrap.userData.factor = nodeFactor(d);
  return wrap;
}

/** Inverse of RouteGlobe.world for a point's direction. */
function latLng(v: THREE.Vector3): { lat: number; lng: number } {
  const r = v.length();
  return { lat: 90 - (Math.acos(v.y / r) * 180) / Math.PI, lng: 90 - (Math.atan2(v.z, v.x) * 180) / Math.PI };
}

/** Separating axis test for two convex quads. */
function quadsHit(A: Pt[], B: Pt[]): boolean {
  for (const P of [A, B]) {
    for (let i = 0; i < P.length; i++) {
      const [px, py] = P[i];
      const [qx, qy] = P[(i + 1) % P.length];
      const nx = qy - py;
      const ny = px - qx;
      const pa = A.map(([x, y]) => x * nx + y * ny);
      const pb = B.map(([x, y]) => x * nx + y * ny);
      if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
    }
  }
  return true;
}

/** Convex hull of screen points, counter-clockwise (monotone chain). */
function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [];
  const up: Pt[] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Whether a screen segment touches a convex quad. */
function segHitsQuad(a: Pt, b: Pt, q: Pt[]): boolean {
  return quadsHit([a, b], q);
}

export class RouteGlobe {
  private g: GlobeInstance;
  private spinning = false;
  private nodes = new Set<THREE.Object3D>();
  private raw: { arcs: ArcDatum[]; points: PointDatum[]; wants: LabelWant[] } = { arcs: [], points: [], wants: [] };
  private alt = 2.5;
  private layoutAlt = 1;
  private layoutDir = new THREE.Vector3(0, 0, 1);
  private lastAlt = 0;
  private lastDir = new THREE.Vector3(0, 0, 1);

  constructor(private el: HTMLElement) {
    const reduce = reduceMotion();
    this.g = new Globe(el, { animateIn: false })
      .backgroundColor("#000000")
      .showAtmosphere(true)
      .atmosphereColor("#ffffff")
      .atmosphereAltitude(0.1)
      .showGraticules(false)
      .globeImageUrl(null as unknown as string)
      .polygonCapColor(() => "rgba(255,255,255,0.025)")
      .polygonSideColor(() => "rgba(0,0,0,0)")
      .polygonStrokeColor(() => "rgba(255,255,255,0.5)")
      .polygonAltitude(0.003)
      .arcStartLat((d: object) => (d as ArcDatum).sLat)
      .arcStartLng((d: object) => (d as ArcDatum).sLng)
      .arcEndLat((d: object) => (d as ArcDatum).eLat)
      .arcEndLng((d: object) => (d as ArcDatum).eLng)
      .arcColor((d: object) => (d as ArcDatum).color)
      .arcStroke((d: object) => (d as DrawnArc).stroke)
      .arcAltitude((d: object) => (d as DrawnArc).alt)
      .arcCurveResolution(96)
      .arcDashLength((d: object) => ((d as ArcDatum).dash ? 0.3 : 1))
      .arcDashGap((d: object) => ((d as ArcDatum).dash ? 0.12 : 0))
      .arcDashAnimateTime((d: object) => ((d as ArcDatum).dash && !reduce ? 1600 : 0))
      .arcLabel((d: object) => `<div class="tooltip">${(d as ArcDatum).label}</div>`)
      .objectLat((d: object) => (d as PointDatum).lat)
      .objectLng((d: object) => (d as PointDatum).lng)
      .objectAltitude(0.002)
      .objectFacesSurface(true)
      .objectThreeObject((d: object) => {
        const o = serverNode(d as PointDatum);
        this.nodes.add(o);
        this.scaleNode(o);
        return o;
      })
      .objectLabel((d: object) => {
        const p = d as PointDatum;
        return `<div class="tooltip"><b>${esc(p.label)}</b><br><span class="m">${p.detail}</span></div>`;
      })
      .labelLat((d: object) => (d as LabelDatum).lat)
      .labelLng((d: object) => (d as LabelDatum).lng)
      .labelText((d: object) => (d as LabelDatum).text)
      .labelSize(() => this.labelSize())
      .labelDotRadius(0)
      .labelDotOrientation((d: object) => (d as LabelDatum).dot)
      .labelRotation((d: object) => (d as LabelDatum).rot)
      .labelColor(() => "rgba(255,255,255,0.85)")
      .labelAltitude(LABEL_ALT)
      .labelResolution(3)
      // Labels are rebuilt on zoom and on every redraw: a scale-in tween would hide them each time.
      .labelsTransitionDuration(0)
      .onZoom(() => this.onCamera());

    const mat = this.g.globeMaterial() as unknown as { color: { set(c: string): void }; emissive: { set(c: string): void }; shininess: number };
    mat.color.set("#000000");
    mat.emissive.set("#000000");
    mat.shininess = 0;

    const ctl = this.g.controls() as unknown as { autoRotateSpeed: number; autoRotate: boolean; enableDamping: boolean; dampingFactor: number };
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.08;
    ctl.autoRotateSpeed = 0.5;

    this.alt = this.g.pointOfView().altitude;
    this.fit();
    new ResizeObserver(() => this.fit()).observe(el);
    this.pulseHome();
  }

  async loadLand(url: string): Promise<void> {
    const res = await fetch(url);
    const geo = (await res.json()) as { features: object[] };
    this.g.polygonsData(geo.features);
  }

  setData(arcs: ArcDatum[], points: PointDatum[], wants: LabelWant[] = []): void {
    this.raw = { arcs, points, wants };
    this.layout();
  }

  flyTo(lat: number, lng: number, altitude = 0.4, ms = 900): void {
    this.g.pointOfView({ lat, lng, altitude }, reduceMotion() ? 0 : ms);
  }

  /** Frame a set of points: centroid plus an altitude from their spread. Longitudes are averaged on the circle. */
  fitPoints(pts: { lat: number; lng: number }[]): void {
    if (!pts.length) return;
    const toR = Math.PI / 180;
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const x = pts.reduce((s, p) => s + Math.cos(p.lng * toR), 0);
    const y = pts.reduce((s, p) => s + Math.sin(p.lng * toR), 0);
    const lng = Math.atan2(y, x) / toR;
    const dLng = (a: number) => ((((a - lng) % 360) + 540) % 360) - 180;
    const spread = Math.max(...pts.map((p) => Math.hypot(p.lat - lat, dLng(p.lng) * Math.cos(lat * toR))));
    const altitude = Math.min(2.5, Math.max(0.55, spread / 12));
    this.g.pointOfView({ lat, lng, altitude }, reduceMotion() ? 0 : 900);
  }

  toggleSpin(): boolean {
    this.spinning = !this.spinning;
    (this.g.controls() as unknown as { autoRotate: boolean }).autoRotate = this.spinning;
    return this.spinning;
  }

  private scaleNode(o: THREE.Object3D): void {
    o.scale.setScalar(Math.max(0.15, this.alt * NODE_PER_ALT * (o.userData.factor as number)));
  }

  private labelSize(): number {
    return Math.max(0.08, this.alt * LABEL_PER_ALT);
  }

  /** Where three-globe puts a lat/lng/altitude in world space. */
  private world(lat: number, lng: number, alt: number): THREE.Vector3 {
    const r = this.g.getGlobeRadius() * (1 + alt);
    const phi = ((90 - lat) * Math.PI) / 180;
    const theta = ((90 - lng) * Math.PI) / 180;
    return new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }

  /**
   * Lay out boxes, lines and labels for the current camera, then hand them to globe.gl.
   * 1. Boxes whose screen footprints would touch merge into the highest ranked one.
   * 2. Lines snap to the merged boxes. A segment several routes share is drawn once, by the
   *    highest ranked route. Height grows with ground distance, so every line bends with the globe.
   * 3. Each label tries right of, below and above its box, and takes the first spot that clears
   *    every placed label, every box (its own included) and every line. Home, relay and route-end labels that
   *    find no spot join the label they collide with. Any other label that finds none is dropped.
   */
  private layout(): void {
    const alt = this.g.pointOfView().altitude;
    this.alt = alt;
    const R = this.g.getGlobeRadius();
    const degW = (R * Math.PI) / 180; // world units per degree of ground
    const cam = this.g.camera();
    cam.updateMatrixWorld();
    const camDist = cam.position.length();
    const camDir = cam.position.clone().normalize();
    const W = this.g.width();
    const H = this.g.height();
    const screen = (v: THREE.Vector3, label = false): Pt | null => {
      // Behind the horizon: hidden by the globe, so it takes up no screen space.
      // A label must sit clearly in front of it, or it shows edge-on and mirrored at the rim.
      const rim = R / camDist; // dot product at the horizon
      if (v.clone().normalize().dot(camDir) <= (label ? rim + 0.3 * (1 - rim) : rim - 0.02)) return null;
      const q = v.clone().project(cam);
      // Behind the camera: a long line can arc up past a low camera, and such points project mirrored.
      if (Math.abs(q.z) >= 1) return null;
      return [((q.x + 1) / 2) * W, ((1 - q.y) / 2) * H];
    };
    const frame = (v: THREE.Vector3) => {
      const n = v.clone().normalize();
      const east = new THREE.Vector3(0, 1, 0).cross(n).normalize();
      return { east, north: n.clone().cross(east) };
    };

    // 1. Boxes.
    const nodes: Node[] = [];
    const nodeOf = new Map<PointDatum, Node>();
    const order = (p: PointDatum) => RANK[p.kind] * 2 + (p.bright ? 0 : 1);
    for (const p of [...this.raw.points].sort((a, b) => order(a) - order(b))) {
      const c = this.world(p.lat, p.lng, 0.002);
      const s = screen(c);
      let r = 0;
      if (s) {
        const edge = screen(c.clone().addScaledVector(frame(c).east, Math.max(0.15, alt * NODE_PER_ALT * nodeFactor(p)) * 0.5));
        r = edge ? Math.hypot(edge[0] - s[0], edge[1] - s[1]) : 0;
      }
      const near = s ? nodes.find((n) => n.s && Math.hypot(n.s[0] - s[0], n.s[1] - s[1]) < n.r + r + NODE_GAP_PX) : undefined;
      if (near) {
        if (!near.p.detail.includes(p.detail)) near.p.detail += `<br>${p.detail}`;
        nodeOf.set(p, near);
      } else {
        const n: Node = { p: { ...p }, s, r };
        nodes.push(n);
        nodeOf.set(p, n);
      }
    }

    // Each box's real screen outline. Boxes stand up from the surface and labels float above it,
    // so zoomed in, perspective moves them apart on screen: a label can only be checked against
    // the box as drawn, its own box included. Matches how three-globe places and turns an object.
    const D = Math.PI / 180;
    for (const n of nodes) {
      if (!n.s) continue;
      const o = new THREE.Object3D();
      o.position.copy(this.world(n.p.lat, n.p.lng, 0.002));
      o.setRotationFromEuler(new THREE.Euler(-n.p.lat * D, n.p.lng * D, 0, "YXZ"));
      o.updateMatrixWorld();
      // The box (1 x 0.62 x 0.5, standing on the surface), grown so it keeps NODE_GAP_PX clear.
      const k = Math.max(0.15, alt * NODE_PER_ALT * nodeFactor(n.p)) * (1 + NODE_GAP_PX / Math.max(1, n.r));
      const pts: (Pt | null)[] = [];
      for (const x of [-0.5, 0.5]) for (const y of [-0.31, 0.31]) for (const z of [0, 0.5]) pts.push(screen(new THREE.Vector3(x * k, y * k, z * k).applyMatrix4(o.matrixWorld)));
      // Near the horizon some corners can fail to project: keep the outline of the ones that do,
      // or at least the square around the box's centre, so a label never lands on a visible box.
      const seen = pts.filter((q): q is Pt => !!q);
      n.hull = seen.length >= 3 ? hull(seen) : [[n.s[0] - n.r, n.s[1] - n.r], [n.s[0] + n.r, n.s[1] - n.r], [n.s[0] + n.r, n.s[1] + n.r], [n.s[0] - n.r, n.s[1] + n.r]];
    }

    // 2. Lines.
    const byKey = new Map(this.raw.points.map((p) => [key(p.lat, p.lng), p]));
    const ids = new Map<unknown, number>();
    const idOf = (x: unknown) => ids.get(x) ?? (ids.set(x, ids.size), ids.size - 1);
    const end = (lat: number, lng: number) => {
      const p = byKey.get(key(lat, lng));
      const n = p && nodeOf.get(p);
      return n ? { id: idOf(n), lat: n.p.lat, lng: n.p.lng } : { id: idOf(key(lat, lng)), lat, lng };
    };
    const arcs = new Map<string, DrawnArc>();
    for (const a0 of this.raw.arcs) {
      const a = { ...a0, rank: rankOf(a0) };
      const s = end(a.sLat, a.sLng);
      const e = end(a.eLat, a.eLng);
      if (s.id === e.id) continue;
      const k = [s.id, e.id].sort((x, y) => x - y).join("|");
      const prev = arcs.get(k);
      if (prev && prev.rank <= a.rank) {
        if (!prev.label.includes(a.label)) prev.label += `<br>${a.label}`;
        continue;
      }
      const ang = this.world(s.lat, s.lng, 0).angleTo(this.world(e.lat, e.lng, 0));
      const h = Math.min(ARC_ALT_MAX, Math.max(ARC_ALT_MIN, ang * ARC_ALT_PER_RAD)) * (a.rank === 0 ? 1.3 : 1);
      arcs.set(k, { ...a, sLat: s.lat, sLng: s.lng, eLat: e.lat, eLng: e.lng, alt: h, stroke: alt * STROKE_PER_ALT[a.rank], label: prev ? `${a.label}<br>${prev.label}` : a.label });
    }
    // Each line as screen segments, on the same curve three-globe draws: a cubic Bezier from the
    // start to the end, with control points a quarter and three quarters along the great circle,
    // raised to 1.5 times the arc's height.
    const segs: [Pt, Pt][] = [];
    for (const a of arcs.values()) {
      const u = this.world(a.sLat, a.sLng, 0).normalize();
      const v = this.world(a.eLat, a.eLng, 0).normalize();
      const ang = u.angleTo(v);
      const along = (t: number, h: number) => (ang < 1e-6 ? u.clone() : u.clone().multiplyScalar(Math.sin((1 - t) * ang)).addScaledVector(v, Math.sin(t * ang)).divideScalar(Math.sin(ang))).multiplyScalar(R * (1 + h));
      const curve = new THREE.CubicBezierCurve3(along(0, 0), along(0.25, a.alt * 1.5), along(0.75, a.alt * 1.5), along(1, 0));
      let last: Pt | null = null;
      for (const pt3 of curve.getPoints(48)) {
        const pt = screen(pt3);
        if (pt && last) segs.push([last, pt]);
        last = pt;
      }
    }

    // 3. Labels.
    const th = this.labelSize() * degW; // text height, world units
    const placeFor = (n: Node, text: string, orient: Orient): { d: LabelDatum; q: Pt[] | null } => {
      const p = n.p;
      const half = Math.max(0.15, alt * NODE_PER_ALT * nodeFactor(p)) * 0.5;
      const w = text.length * CHAR_W;
      const c = this.world(p.lat, p.lng, LABEL_ALT);
      const sc = screen(c);
      const none = { d: { lat: p.lat, lng: p.lng, text, orient, dot: "right" as const, rot: 0 }, q: null };
      if (!sc) return none;
      // Turn the text so it reads level on screen: measure how far local east leans on screen and undo it.
      const { east, north } = frame(c);
      const se = screen(c.clone().addScaledVector(east, half));
      if (!se) return none;
      const lean = Math.atan2(se[1] - sc[1], se[0] - sc[0]);
      // On screen (y down) east points along (cos, sin) of the lean and north along (sin, -cos),
      // so these two point level right and straight up.
      const ex = east.clone().multiplyScalar(Math.cos(lean)).addScaledVector(north, Math.sin(lean));
      const ny = east.clone().multiplyScalar(-Math.sin(lean)).addScaledVector(north, Math.cos(lean));
      // Anchor just outside the box: right or left of it (optionally a line higher or lower),
      // or below or above its half depth (0.31 of its width).
      const side = orient !== "top" && orient !== "bottom";
      const lift = orient.endsWith("-up") ? 1 : orient.endsWith("-down") ? -1 : 0;
      const along = orient.startsWith("right") ? half * 1.6 : orient.startsWith("left") ? -(half * 1.6 + (1 + w) * th) : 0;
      const up = side ? lift * (half * 0.62 + th * 0.9) : (orient === "top" ? 1 : -1) * half * 0.62;
      const anchor = c.clone().addScaledVector(ex, along).addScaledVector(ny, up).setLength(c.length());
      const sa = screen(anchor);
      if (!sa) return none;
      // The text plane sits at the anchor, so level it against the anchor's own east.
      const { east: ae, north: an } = frame(anchor);
      const sae = screen(anchor.clone().addScaledVector(ae, half));
      if (!sae) return none;
      const tilt = Math.atan2(sae[1] - sa[1], sae[0] - sa[0]);
      const d: LabelDatum = { ...latLng(anchor), text, orient, dot: side ? "right" : (orient as "top" | "bottom"), rot: (-tilt * 180) / Math.PI }; // three-globe turns by rotateZ(-rot)
      // three-globe puts text half a text height right of a "right" anchor, and centres it
      // one text height below or above a "bottom" or "top" anchor.
      // The glyph box (0.81 below to 0.54 above the baseline line, 1.35 tall when centred),
      // padded by LABEL_PAD so labels keep a few px from each other, boxes and lines.
      const m = LABEL_PAD;
      const [x0, x1, y0, y1] =
        side
          ? [0.5 - m, 0.5 + w + m, -TEXT_BELOW - m, TEXT_ABOVE + m]
          : orient === "top"
            ? [-w / 2 - m, w / 2 + m, 0.325 - m, 1.675 + m]
            : [-w / 2 - m, w / 2 + m, -1.675 - m, -0.325 + m];
      const aex = ae.clone().multiplyScalar(Math.cos(tilt)).addScaledVector(an, Math.sin(tilt));
      const any = ae.clone().multiplyScalar(-Math.sin(tilt)).addScaledVector(an, Math.cos(tilt));
      const q = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => screen(anchor.clone().addScaledVector(aex, x * th).addScaledVector(any, y * th), true));
      return { d, q: q.every(Boolean) ? (q as Pt[]) : null };
    };
    const placed: { n: Node; d: LabelDatum; q: Pt[] | null }[] = [];
    const hits = (c: { labels: number; other: number }) => c.labels + c.other > 0;
    /** Append text to a placed label, trying each side again, and keep it only if it still overlaps nothing. */
    const grow = (x: (typeof placed)[number], text: string): boolean => {
      const t = `${x.d.text} · ${text}`;
      for (const o of [x.d.orient, ...ORIENTS.filter((o) => o !== x.d.orient)]) {
        const c = placeFor(x.n, t, o);
        if (c.q && !hits(clash(c.q, x))) {
          Object.assign(x, c);
          return true;
        }
      }
      return false;
    };
    const clash = (q: Pt[] | null, skip?: (typeof placed)[number]) => {
      if (!q) return { labels: 0, other: 0 };
      // A label cut off by the edge of the view counts as a clash too, and so does one that would
      // read tilted: a long label far from the view centre leaves the curve and leans in perspective.
      if (q.some(([x, y]) => x < 4 || y < 4 || x > W - 4 || y > H - 4)) return { labels: 0, other: 1 };
      if (Math.abs(Math.atan2(q[1][1] - q[0][1], q[1][0] - q[0][0])) > MAX_TILT) return { labels: 0, other: 1 };
      const labels = placed.filter((x) => x !== skip && x.q && quadsHit(x.q, q)).length;
      const boxes = nodes.filter((n) => n.hull && quadsHit(n.hull, q)).length;
      const lines = segs.filter(([a, b]) => segHitsQuad(a, b, q)).length;
      return { labels, other: boxes + lines };
    };
    for (const w of [...this.raw.wants].sort((a, b) => a.prio - b.prio)) {
      const n = nodeOf.get(w.p);
      if (!n) continue;
      // A second label for the same box joins the first, if the longer label still fits.
      const mine = placed.find((x) => x.n === n);
      if (mine) {
        if (w.prio <= 2 && !mine.d.text.split(" · ").includes(w.text)) grow(mine, w.text);
        continue;
      }
      // The full text first, then its short form ("Greensburg" for "Greensburg, Pennsylvania").
      const texts = [...new Set([w.text, w.text.split(",")[0]])];
      const tries = texts.flatMap((t) => ORIENTS.map((o) => placeFor(n, t, o)));
      const clean = tries.find((t) => t.q && !hits(clash(t.q)));
      if (clean) {
        placed.push({ n, d: clean.d, q: clean.q });
        continue;
      }
      // Home, a relay or a route end with no free spot joins a label close by on screen that can take it,
      // so the joined label still reads as that place. Anything else, and anything that cannot join
      // without overlapping, is not shown at this zoom.
      if (w.prio > 2 || !n.s || n.s[0] < 0 || n.s[1] < 0 || n.s[0] > W || n.s[1] > H) continue;
      const dist = (x: (typeof placed)[number]) => Math.hypot(x.n.s![0] - n.s![0], x.n.s![1] - n.s![1]);
      const near = placed.filter((x) => x.n.s && dist(x) < JOIN_PX).sort((a, b) => dist(a) - dist(b));
      for (const x of near) if (!x.d.text.split(" · ").includes(w.text) && texts.some((t) => grow(x, t))) break;
    }

    this.layoutAlt = alt;
    this.layoutDir = camDir;
    this.nodes.clear();
    this.g
      .arcsData([...arcs.values()])
      .objectsData(nodes.map((n) => n.p))
      .labelsData(placed.map((x) => x.d));
  }

  /** Follow the camera: node size on any zoom, a new layout once zoom or view direction has moved enough. */
  private onCamera(): void {
    const altitude = this.g.pointOfView().altitude;
    if (Math.abs(altitude - this.alt) >= ALT_EPS) {
      this.alt = altitude;
      for (const o of this.nodes) this.scaleNode(o);
    }
    const dir = this.g.camera().position.clone().normalize();
    const still = Math.abs(altitude - this.lastAlt) < 1e-4 && dir.dot(this.lastDir) > 0.999999;
    this.lastAlt = altitude;
    this.lastDir = dir;
    if (!this.raw.points.length && !this.raw.arcs.length) return;
    // Layout rebuilds meshes: while the camera moves, redo it only once zoom has moved by 15%
    // or the view by about 4 degrees. Once it stops, lay out for exactly where it stopped.
    const zoom = Math.abs(altitude - this.layoutAlt) / this.layoutAlt;
    const turn = dir.dot(this.layoutDir);
    if (zoom > 0.15 || turn < 0.9975 || (still && (zoom > 0.001 || turn < 0.9999999))) this.layout();
  }

  /**
   * Per frame: the home node's border breathes (off under reduced motion), and node size follows
   * the camera. globe.gl only reports zoom on a controls change, which its pointOfView tween
   * (Home, Fit, a hop click) never fires, so the altitude is read from the camera every frame.
   */
  private pulseHome(): void {
    const tick = (t: number) => {
      this.onCamera();
      LINE_HOME.opacity = reduceMotion() ? 1 : 0.55 + 0.45 * Math.cos((t / 1500) * Math.PI * 2);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private fit(): void {
    this.g.width(this.el.clientWidth).height(this.el.clientHeight);
  }
}
