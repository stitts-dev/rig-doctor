// Monochrome globe. Black sphere, land as fine white outlines, routes as arcs.
// Grey dashed = the path packets take today. White solid = the best relay route.
// Dim = every other traced destination, so the globe shows the machine's whole footprint.
// Every node is a small server box with a white border, kept the same size on screen at any zoom.

import Globe, { type GlobeInstance } from "globe.gl";
import * as THREE from "three";

export interface ArcDatum {
  sLat: number;
  sLng: number;
  eLat: number;
  eLng: number;
  color: string | string[];
  stroke: number;
  alt: number;
  dash: boolean;
  label: string;
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

interface LabelDatum {
  lat: number;
  lng: number;
  kind: NodeKind;
  text: string;
  prio: number;
}

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
  wrap.userData.factor = SCALE[d.kind] * (d.bright || d.kind !== "hop" ? 1 : 0.6);
  return wrap;
}

export class RouteGlobe {
  private g: GlobeInstance;
  private spinning = false;
  private nodes = new Set<THREE.Object3D>();
  private wants: LabelWant[] = [];
  private alt = 2.5;
  private labelAlt = 1;
  private labelDir = new THREE.Vector3(0, 0, 1);
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
      .arcStroke(null)
      .arcAltitude((d: object) => (d as ArcDatum).alt)
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
      .labelLng((d: object) => this.labelLng(d as LabelDatum))
      .labelText((d: object) => (d as LabelDatum).text)
      .labelSize(() => this.labelSize())
      .labelDotRadius(0)
      .labelDotOrientation(() => "right")
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
    this.nodes.clear();
    this.wants = wants;
    this.g.arcsData(arcs).objectsData(points).labelsData(this.placeLabels());
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

  /** Put the text just right of its node box. */
  private labelLng(p: { lat: number; lng: number; kind: NodeKind }): number {
    const halfBoxDeg = (this.alt * NODE_PER_ALT * SCALE[p.kind] * 0.5) / ((this.g.getGlobeRadius() * Math.PI) / 180);
    return p.lng + (halfBoxDeg * 1.6) / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
  }

  /** Where three-globe puts a lat/lng/altitude in world space. */
  private world(lat: number, lng: number, alt: number): THREE.Vector3 {
    const r = this.g.getGlobeRadius() * (1 + alt);
    const phi = ((90 - lat) * Math.PI) / 180;
    const theta = ((90 - lng) * Math.PI) / 180;
    return new THREE.Vector3(r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
  }

  /**
   * Choose which labels show for the current camera. Each label is a flat text mesh laid along
   * the local east direction at its anchor, so a long label leaves its line of latitude.
   * Its node and text are rebuilt as a quad in that plane and projected to the screen, and
   * labels collide only when those screen quads intersect.
   */
  private placeLabels(): LabelDatum[] {
    const th = this.labelSize() * ((this.g.getGlobeRadius() * Math.PI) / 180); // text height, world units
    const cam = this.g.camera();
    const camDir = cam.position.clone().normalize();
    const W = this.g.width();
    const H = this.g.height();
    type Quad = [number, number][] | null;
    const quad = (d: LabelDatum): Quad => {
      const anchor = this.world(d.lat, this.labelLng(d), LABEL_ALT);
      const n = anchor.clone().normalize();
      if (n.dot(camDir) <= 0.05) return null; // on the far side: never in anyone's way
      const east = new THREE.Vector3(0, 1, 0).cross(n).normalize();
      if (!Number.isFinite(east.x) || east.lengthSq() < 1e-9) return null;
      const north = n.clone().cross(east);
      const box = this.alt * NODE_PER_ALT * SCALE[d.kind];
      // Glyphs start half a text height right of the anchor. The node box sits left of it.
      const x0 = -box * 1.4;
      const x1 = th * (0.5 + d.text.length * CHAR_W);
      const y0 = -th * (TEXT_BELOW + 0.1);
      const y1 = th * (TEXT_ABOVE + 0.1);
      return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => {
        const v = anchor.clone().addScaledVector(east, x).addScaledVector(north, y).project(cam);
        return [((v.x + 1) / 2) * W, ((1 - v.y) / 2) * H] as [number, number];
      });
    };
    // Separating axis test for two convex quads.
    const hit = (A: Quad, B: Quad): boolean => {
      if (!A || !B) return false;
      for (const P of [A, B]) {
        for (let i = 0; i < 4; i++) {
          const [px, py] = P[i];
          const [qx, qy] = P[(i + 1) % 4];
          const nx = qy - py;
          const ny = px - qx;
          const pa = A.map(([x, y]) => x * nx + y * ny);
          const pb = B.map(([x, y]) => x * nx + y * ny);
          if (Math.max(...pa) <= Math.min(...pb) || Math.max(...pb) <= Math.min(...pa)) return false;
        }
      }
      return true;
    };
    const placed: { d: LabelDatum; p: PointDatum; q: Quad }[] = [];
    for (const w of [...this.wants].sort((a, b) => a.prio - b.prio)) {
      const d: LabelDatum = { lat: w.p.lat, lng: w.p.lng, kind: w.p.kind, text: w.text, prio: w.prio };
      const q = quad(d);
      const near = placed.find((x) => x.p === w.p) ?? placed.find((x) => hit(x.q, q));
      if (!near) {
        placed.push({ d, p: w.p, q });
      } else if (w.prio <= 2 && !near.d.text.split(" · ").includes(w.text)) {
        near.d.text += ` · ${w.text}`;
        near.q = quad(near.d);
      }
    }
    this.labelAlt = this.g.pointOfView().altitude;
    this.labelDir = camDir;
    return placed.map((x) => x.d);
  }

  /** Follow the camera: node size on any zoom, label placement once zoom or view direction has moved enough. */
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
    if (!this.wants.length) return;
    // Labels are text meshes: while the camera moves, rebuild them only once zoom has moved by 15%
    // or the view by about 4 degrees. Once it stops, place them for exactly where it stopped.
    const zoom = Math.abs(altitude - this.labelAlt) / this.labelAlt;
    const turn = dir.dot(this.labelDir);
    if (zoom > 0.15 || turn < 0.9975 || (still && (zoom > 0.005 || turn < 0.99999))) this.g.labelsData(this.placeLabels());
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
