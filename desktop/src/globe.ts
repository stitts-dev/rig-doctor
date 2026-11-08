// Dark globe. Land as fine outlines, routes as 3D arcs that lift off the globe and cast a faint
// shadow on the ground under them. Light grey = the path packets take today, with a glow and a pulse
// running from this machine to the server. White = the relay route. Dim = every other traced
// destination, so the globe shows the machine's whole footprint.
// Every node is a small lit server box with a bright border, kept the same size on screen at any zoom.
// Labels are HTML cards, so text is crisp at any zoom. Nothing overlaps: for the current camera,
// boxes that would touch merge into one, routes that share a segment draw it once, and each card
// goes beside, above or below its box, wherever it clears every other card, every box and every line.

import Globe, { type GlobeInstance } from "globe.gl";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import ConicPolygonGeometry from "three-conic-polygon-geometry";
import GeoJsonGeometry from "three-geojson-geometry";

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
  /** Milliseconds this leg adds, measured or estimated. Packets crawl along slow legs and race along fast ones. */
  ms?: number;
}

type Rank = 0 | 1 | 2;

/** Which arc wins a shared segment: 0 relay route (white), 1 selected route (dashed), 2 any other route. */
const rankOf = (a: ArcDatum): Rank => (Array.isArray(a.color) || a.color === "#ffffff" ? 0 : a.dash ? 1 : 2);

/** Dash pattern for a route leg spanning `ang` radians, as fractions of the leg's length. */
const routeDash = (ang: number): { dashLen: number; dashGap: number } => {
  const n = Math.min(40, Math.max(6, Math.round((ang * 180) / Math.PI / 2)));
  return { dashLen: 0.6 / n, dashGap: 0.4 / n };
};

/** How long a packet takes to cross a leg on screen: about 90 ms per measured ms, so a +50 ms leg visibly crawls. */
const pulseMs = (ms: number | undefined): number => (ms == null ? 2200 : Math.min(7000, Math.max(700, ms * 90)));

/** An arc as drawn: endpoints snapped to the merged boxes, height and width for this zoom. */
interface DrawnArc extends ArcDatum {
  rank: Rank;
  /** What this tube is: the route itself, its glow, the pulse running along it, or its ground shadow. */
  layer: "main" | "glow" | "pulse" | "shadow";
  dashLen: number;
  dashGap: number;
  dashMs: number;
  dashStart: number;
}

/** A network's territory: a low raised plate over the places where a route's hops sit inside it. */
export interface Territory {
  /** Closed ring of [lng, lat] points. */
  ring: [number, number][];
  /** 0 to 1: how bright this network's plate is, so neighbouring networks read apart in greys. */
  shade: number;
  /** Stacking order along the route, so overlapping plates sit at slightly different heights. */
  lift: number;
  /** Trusted HTML for the hover tooltip: callers escape every external value. */
  label: string;
}

interface TerritoryFeature {
  type: "Feature";
  terr: Territory;
  geometry: { type: "Polygon"; coordinates: [number, number][][] };
}

const terrOf = (d: object): Territory => (d as TerritoryFeature).terr;

// globe.gl tests the pointer against the scene 20 times a second. The globe spheres (32k
// triangles) and the atmosphere shell were 3.2 of the 5 ms a check took: the atmosphere never
// answers hover, and a sphere hit only needs the ray-sphere maths, not every triangle.
const NO_HOVER = 1;
const hitSphere = new THREE.Sphere();
const hitPoint = new THREE.Vector3();
function sphereRaycast(this: THREE.Mesh, rc: THREE.Raycaster, hits: THREE.Intersection[]): void {
  const g = this.geometry as THREE.SphereGeometry;
  this.getWorldPosition(hitSphere.center);
  hitSphere.radius = g.parameters.radius * this.getWorldScale(hitPoint).x;
  if (!rc.ray.intersectSphere(hitSphere, hitPoint)) return;
  const distance = rc.ray.origin.distanceTo(hitPoint);
  if (distance >= rc.near && distance <= rc.far) hits.push({ distance, point: hitPoint.clone(), object: this });
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
  /** A reference point, not measured: its card keeps its "Reference" kicker or is not shown. */
  ref?: boolean;
}

/**
 * Where a label sits against its box: beside it (right, left), beside it but a line higher or
 * lower (right-up and so on), or centred below or above it. Every side placement is drawn as a
 * right-anchored three-globe label whose anchor is moved.
 */
type Orient = "right" | "left" | "bottom" | "top" | "right-up" | "right-down" | "left-up" | "left-down";

/** A card as placed: its lines, the node it belongs to, and its offset in px from the node's screen centre. */
interface Card {
  n: Node;
  lines: CardLine[];
  kind: NodeKind;
  orient: Orient;
  dx: number;
  dy: number;
  w: number;
  h: number;
  q: Pt[];
  /** How far the card stands off its box. Past the normal gap it gets a leader line back to the box. */
  gap?: number;
}

/** One line of a card: an optional small caps kicker (the network) over a title (the place). */
interface CardLine {
  k?: string;
  t: string;
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
// Altitude change that counts as a zoom, so float noise in the camera does not rescale every frame.
const ALT_EPS = 0.002;
// Arc peak height per radian of ground distance, so a short hop stays low and a long one arches high over the globe.
const ARC_ALT_PER_RAD = 0.38;
const ARC_ALT_MIN = 0.006;
const ARC_ALT_MAX = 0.22;
// Shadow height: just above the land outlines, so it reads as the arc's footprint on the ground.
const SHADOW_ALT = 0.0045;
// Tube width in degrees per unit of camera altitude (about 2.6, 2.4 and 1.2 px on screen).
const STROKE_PER_ALT: Record<Rank, number> = { 0: 0.115, 1: 0.105, 2: 0.05 };
// Glow width as a multiple of the tube width.
const GLOW_X = 5;
// Route colours by rank: relay white, current path light grey, other routes grey. [start, end].
const ACCENT = "#ffffff";
const ROUTE_COLORS: Record<Rank, [string, string]> = { 0: ["rgba(255,255,255,0.75)", ACCENT], 1: ["rgba(208,208,208,0.55)", "#d0d0d0"], 2: ["rgba(138,138,138,0.7)", "rgba(138,138,138,0.7)"] };
const GLOW_COLORS: Record<Rank, string> = { 0: "rgba(255,255,255,0.16)", 1: "rgba(255,255,255,0.08)", 2: "rgba(0,0,0,0)" };
// Space between a card and its box, in px. Cards keep CARD_PAD px clear of lines and other cards.
const CARD_GAP = 8;
const CARD_PAD = 4;
// Space kept between boxes, in px.
const NODE_GAP_PX = 3;
// Right of the box reads best, so it is tried first, then above, below and finally left.
const ORIENTS: Orient[] = ["right", "right-up", "right-down", "top", "bottom", "left", "left-up", "left-down"];
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
// Faces shaded as if lit from above: top lightest, sides darker, so the box reads as a solid.
// BoxGeometry face order: +x, -x, +y, -y, +z (top), -z.
const shade = (side: number, top: number) =>
  [[side, 1], [side, 0.8], [side, 0.9], [side, 0.7], [top, 1], [0x000000, 1]].map(([c, k]) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k) }));
const FACES_BRIGHT = shade(0x1a1a1a, 0x2e2e2e);
const FACES_DIM = shade(0x0c0c0c, 0x161616);
const LINE_BRIGHT = new THREE.LineBasicMaterial({ color: 0xffffff });
const LINE_DIM = new THREE.LineBasicMaterial({ color: 0x5a5a5a });
const LINE_HOME = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1 });
const LINE_RELAY = new THREE.LineBasicMaterial({ color: ACCENT });
// Status light on the front edge of the top face, and the ring that spreads from home.
const LED = new THREE.PlaneGeometry(0.16, 0.08);
const LED_ON = new THREE.MeshBasicMaterial({ color: 0xffffff });
const LED_RELAY = new THREE.MeshBasicMaterial({ color: ACCENT });
const RING = new THREE.RingGeometry(0.9, 1, 64);
const RING_MAT = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true });

// three.js draws a transparent double-sided material in two passes and flags it for a shader
// recompile check on each pass, every frame. With one material per country that was ~1,100
// program lookups a frame while idle. Caps are flat, so one pass looks the same; share one
// material per white level instead of one per polygon.
const CAPS = new Map<number, THREE.MeshBasicMaterial>();
function capMaterial(opacity: number): THREE.MeshBasicMaterial {
  let m = CAPS.get(opacity);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity, side: THREE.DoubleSide, forceSinglePass: true });
    CAPS.set(opacity, m);
  }
  return m;
}

// Land. three-globe's polygon layer gave each of the 288 land polygons its own cap mesh and
// border line, up to ~580 draw calls a frame. Every country looks the same, so all caps are one
// mesh and all borders one line set: 2 draw calls. Same geometry, height and colours three-globe
// built. Land never answers hover, so it sits outside the globe.gl layers the pointer is tested on.
const LAND_ALT = 0.003;
const LAND_BORDER = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });

type Ring = [number, number][];
type LandGeometry = { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };

// three.js draws see-through meshes back to front by the centre of each one's bounds. A network
// plate's mesh reaches down to the globe's centre, so plates always drew before the land and hid
// the borders under them. Land is now one mesh centred on the globe, so that order is set here:
// plates first, then three.js's usual order (WebGLRenderLists reversePainterSortStable).
const isPlate = (it: THREE.RenderItem): number => ((it.object.parent as { __globeObjType?: string } | null)?.__globeObjType === "polygon" ? 0 : 1);
function platesFirst(a: THREE.RenderItem, b: THREE.RenderItem): number {
  return isPlate(a) - isPlate(b) || a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || (a.z !== b.z ? b.z - a.z : a.id - b.id);
}

function landObject(features: { geometry: LandGeometry }[], R: number): THREE.Group {
  const caps: THREE.BufferGeometry[] = [];
  const borders: THREE.BufferGeometry[] = [];
  for (const { geometry: g } of features) {
    for (const rings of g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : []) {
      caps.push(new ConicPolygonGeometry(rings, 0, R, false, true, false, 5));
      borders.push(new GeoJsonGeometry({ type: "Polygon", coordinates: rings }, R, 5));
    }
  }
  const merged = (parts: THREE.BufferGeometry[]): THREE.BufferGeometry => {
    const m = mergeGeometries(parts.filter((p) => p.index && p.getAttribute("position")));
    for (const p of parts) p.dispose();
    // Bounded by the globe itself, so three.js sorts land with the other globe-centred layers
    // (after the atmosphere, before arcs and boxes on the near side) from any view.
    m.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R);
    return m;
  };
  // Borders sit 0.01 above the caps, closer than the depth buffer can tell apart when zoomed out,
  // so a cap drawn first can hide them. Made first, borders draw first (same sort depth, lower id)
  // and the caps only tint them.
  const border = new THREE.LineSegments(merged(borders), LAND_BORDER);
  border.scale.setScalar(1 + LAND_ALT + 1e-4);
  const cap = new THREE.Mesh(merged(caps), capMaterial(0.025));
  cap.scale.setScalar(1 + LAND_ALT);
  const land = new THREE.Group();
  land.name = "land";
  land.add(border, cap);
  return land;
}

function serverNode(d: PointDatum): THREE.Object3D {
  const line = d.kind === "home" ? LINE_HOME : d.kind === "relay" ? LINE_RELAY : d.bright ? LINE_BRIGHT : LINE_DIM;
  const g = new THREE.Group();
  g.add(new THREE.Mesh(BOX, d.bright || d.kind !== "hop" ? FACES_BRIGHT : FACES_DIM), new THREE.LineSegments(EDGES, line), new THREE.LineSegments(BAYS, line));
  if (d.bright || d.kind !== "hop") {
    const led = new THREE.Mesh(LED, d.kind === "relay" ? LED_RELAY : LED_ON);
    led.position.set(0.36, -0.22, 0.252);
    g.add(led);
  }
  g.position.z = 0.25; // sit on the surface instead of half inside it
  const wrap = new THREE.Group();
  wrap.add(g);
  if (d.kind === "home") {
    const ring = new THREE.Mesh(RING, RING_MAT);
    ring.position.z = 0.01;
    ring.userData.ring = true;
    wrap.add(ring);
  }
  wrap.userData.kind = d.kind;
  wrap.userData.factor = nodeFactor(d);
  return wrap;
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
  private land?: THREE.Group;
  private terrs: TerritoryFeature[] = [];
  /** Set once the globe and atmosphere meshes have their cheap hover test. */
  private hoverTuned = false;
  /** Px the picture is moved down, so a route seen tilted from the south sits mid-window. */
  private yShift = 0;
  private shiftAnim = 0;
  private layoutAlt = 1;
  private layoutDir = new THREE.Vector3(0, 0, 1);
  private lastAlt = 0;
  private lastDir = new THREE.Vector3(0, 0, 1);
  private overlay: HTMLDivElement;
  private measurer: HTMLDivElement;
  private cards: { c: Card; el: HTMLDivElement; lead?: HTMLDivElement }[] = [];
  private sizes = new Map<string, [number, number]>();

  constructor(private el: HTMLElement) {
    const reduce = reduceMotion();
    this.g = new Globe(el, { animateIn: false })
      .backgroundColor("#000000")
      .showAtmosphere(true)
      .atmosphereColor("#ffffff")
      .atmosphereAltitude(0.1)
      .showGraticules(false)
      .globeImageUrl(null as unknown as string)
      // The polygon layer holds only the network plates; land is one mesh of its own (loadLand).
      .polygonCapMaterial((d: object) => capMaterial(+(0.035 + 0.075 * terrOf(d).shade).toFixed(3)))
      .polygonSideColor((d: object) => `rgba(255,255,255,${(0.05 + 0.1 * terrOf(d).shade).toFixed(3)})`)
      .polygonStrokeColor((d: object) => `rgba(255,255,255,${(0.25 + 0.4 * terrOf(d).shade).toFixed(3)})`)
      .polygonAltitude((d: object) => 0.006 + 0.003 * terrOf(d).lift)
      .polygonLabel((d: object) => terrOf(d).label)
      .polygonsTransitionDuration(0)
      .arcStartLat((d: object) => (d as ArcDatum).sLat)
      .arcStartLng((d: object) => (d as ArcDatum).sLng)
      .arcEndLat((d: object) => (d as ArcDatum).eLat)
      .arcEndLng((d: object) => (d as ArcDatum).eLng)
      .arcColor((d: object) => (d as ArcDatum).color)
      .arcStroke((d: object) => (d as DrawnArc).stroke)
      .arcAltitude((d: object) => (d as DrawnArc).alt)
      .arcCurveResolution(96)
      .arcDashLength((d: object) => (d as DrawnArc).dashLen)
      .arcDashGap((d: object) => (d as DrawnArc).dashGap)
      .arcDashInitialGap((d: object) => (d as DrawnArc).dashStart)
      .arcDashAnimateTime((d: object) => (reduce ? 0 : (d as DrawnArc).dashMs))
      // The glow and pulse sit over the line and are wider, so the pointer meets them first: they show
      // the route's tooltip too. Only the ground shadow stays silent.
      .arcLabel((d: object) => ((d as DrawnArc).layer !== "shadow" && (d as ArcDatum).label ? `<div class="tooltip">${(d as ArcDatum).label}</div>` : ""))
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
      // Arcs are rebuilt on zoom: a grow-in tween would replay each time.
      .arcsTransitionDuration(0)
      .onZoom(() => this.onCamera());

    const mat = this.g.globeMaterial() as unknown as { color: { set(c: string): void }; emissive: { set(c: string): void }; shininess: number };
    mat.color.set("#000000");
    mat.emissive.set("#000000");
    mat.shininess = 0;

    const ctl = this.g.controls() as unknown as { autoRotateSpeed: number; autoRotate: boolean; enableDamping: boolean; dampingFactor: number };
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.08;
    ctl.autoRotateSpeed = 0.5;

    this.overlay = document.createElement("div");
    this.overlay.className = "gcards";
    this.measurer = document.createElement("div");
    this.measurer.className = "gcards measure";
    el.append(this.overlay, this.measurer);

    this.g.camera().layers.enable(NO_HOVER);
    this.g.renderer().setTransparentSort(platesFirst);

    this.alt = this.g.pointOfView().altitude;
    this.fit();
    new ResizeObserver(() => this.fit()).observe(el);
    this.pulseHome();
  }

  async loadLand(url: string): Promise<void> {
    const res = await fetch(url);
    const geo = (await res.json()) as { features: { geometry: LandGeometry }[] };
    const land = landObject(geo.features, this.g.getGlobeRadius());
    if (this.land) {
      this.g.scene().remove(this.land);
      for (const o of this.land.children) (o as THREE.Mesh).geometry.dispose();
    }
    this.land = land;
    this.g.scene().add(land);
  }

  /** Raise each network's territory under the selected route. */
  setTerritories(ts: Territory[]): void {
    this.terrs = ts.map((terr) => ({ type: "Feature", terr, geometry: { type: "Polygon", coordinates: [terr.ring] } }));
    this.g.polygonsData(this.terrs);
  }

  setData(arcs: ArcDatum[], points: PointDatum[], wants: LabelWant[] = []): void {
    this.raw = { arcs, points, wants };
    this.layout();
  }

  /**
   * Look at a point. With a tilt (degrees), the camera sits south of it and looks across, so arcs
   * leaving the point show their height instead of reading as flat spokes; the point stays mid-window.
   */
  flyTo(lat: number, lng: number, altitude = 0.4, ms = 900, tilt = 0): void {
    const pov = { lat: lat - tilt, lng, altitude };
    this.g.pointOfView(pov, reduceMotion() ? 0 : ms);
    this.centreOn(pov, lat, lng, reduceMotion() ? 0 : ms);
  }

  /** Shift the picture so (lat, lng) lands mid-window for a camera at `pov`. */
  private centreOn(pov: { lat: number; lng: number; altitude: number }, lat: number, lng: number, ms: number): void {
    const sy = this.screenYFrom(pov, lat, lng);
    const h = this.el.clientHeight;
    this.shiftTo(sy == null ? 0 : Math.max(0, Math.min(h * 0.3, h / 2 - sy)), ms);
  }

  private applyShift(): void {
    const cam = this.g.camera() as THREE.PerspectiveCamera;
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    if (Math.abs(this.yShift) < 0.5 || !w || !h) cam.clearViewOffset();
    else cam.setViewOffset(w, h, 0, -this.yShift, w, h);
  }

  /** Glide the picture's vertical shift alongside a camera move. */
  private shiftTo(target: number, ms: number): void {
    cancelAnimationFrame(this.shiftAnim);
    const from = this.yShift;
    if (ms <= 0 || Math.abs(target - from) < 0.5) {
      this.yShift = target;
      this.applyShift();
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      this.yShift = from + (target - from) * e;
      this.applyShift();
      if (k < 1) this.shiftAnim = requestAnimationFrame(step);
    };
    this.shiftAnim = requestAnimationFrame(step);
  }

  /** Where (lat, lng) lands on screen, in px from the top, for a camera at the given point of view and no shift. */
  private screenYFrom(pov: { lat: number; lng: number; altitude: number }, lat: number, lng: number): number | undefined {
    const h = this.el.clientHeight;
    if (!h) return undefined;
    const cam = (this.g.camera() as THREE.PerspectiveCamera).clone();
    cam.clearViewOffset();
    cam.aspect = this.el.clientWidth / h;
    cam.updateProjectionMatrix();
    const c = this.g.getCoords(pov.lat, pov.lng, pov.altitude);
    cam.position.set(c.x, c.y, c.z);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const p = this.g.getCoords(lat, lng, 0);
    const q = new THREE.Vector3(p.x, p.y, p.z).project(cam);
    return ((1 - q.y) / 2) * h;
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
    const altitude = Math.min(2.5, Math.max(0.3, spread / 14));
    // Look at the route from the south at an angle instead of straight down, so the arcs show their height.
    const tilt = Math.min(12, 5 + spread * 0.35);
    const pov = { lat: lat - tilt, lng, altitude: altitude * 1.05 };
    this.g.pointOfView(pov, reduceMotion() ? 0 : 900);
    // The tilt puts the route above the middle of the window; move the picture down to bring it back.
    this.centreOn(pov, lat, lng, reduceMotion() ? 0 : 900);
  }

  toggleSpin(): boolean {
    this.spinning = !this.spinning;
    (this.g.controls() as unknown as { autoRotate: boolean }).autoRotate = this.spinning;
    return this.spinning;
  }

  private scaleNode(o: THREE.Object3D): void {
    o.scale.setScalar(Math.max(0.15, this.alt * NODE_PER_ALT * (o.userData.factor as number)));
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
    const cam = this.syncedCamera();
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
      const h = Math.min(ARC_ALT_MAX, Math.max(ARC_ALT_MIN, ang * ARC_ALT_PER_RAD)) * (a.rank === 0 ? 1.25 : 1);
      // Colour by rank, start to end. A dimmed other route stays dimmer than an earlier path of the selected one.
      const dimmed = a.rank === 2 && a.color === "#303030";
      // The relay's onward leg is an estimate: main.ts fades its end, so it fades here too.
      const fade = a.rank === 0 && Array.isArray(a.color);
      const [c0, c1] = dimmed ? ["rgba(48,48,48,0.9)", "rgba(48,48,48,0.9)"] : ROUTE_COLORS[a.rank];
      arcs.set(k, {
        ...a,
        sLat: s.lat,
        sLng: s.lng,
        eLat: e.lat,
        eLng: e.lng,
        alt: h,
        stroke: alt * STROKE_PER_ALT[a.rank],
        color: [c0, fade ? "rgba(255,255,255,0.3)" : c1],
        label: prev ? `${a.label}<br>${prev.label}` : a.label,
        layer: "main",
        // The selected route is dashed so it reads apart from the solid relay route in one colour.
        // About one dash per 2 degrees of ground, at least 6, so short and long legs look alike.
        ...(a.rank === 1 ? routeDash(ang) : { dashLen: 1, dashGap: 0 }),
        dashMs: 0,
        dashStart: 0,
      });
    }
    // Depth cues for every line: a shadow on the ground under it. The selected and relay routes
    // also get a soft glow and a short bright pulse that runs from this machine towards the server.
    const drawn: DrawnArc[] = [];
    for (const a of arcs.values()) {
      if (a.rank < 2 || a.color[0] !== "rgba(48,48,48,0.9)")
        drawn.push({ ...a, layer: "shadow", alt: SHADOW_ALT, stroke: a.stroke * 0.7, color: a.rank === 0 ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.09)", label: "" });
      if (a.rank < 2) {
        drawn.push({ ...a, layer: "glow", stroke: a.stroke * GLOW_X, color: GLOW_COLORS[a.rank] }); // keeps the main line's dashes
        drawn.push({ ...a, layer: "pulse", stroke: a.stroke * 1.5, color: ["rgba(255,255,255,0)", "#ffffff"], dashLen: 0.18, dashGap: 0.95, dashMs: pulseMs(a.ms) });
      }
      drawn.push(a);
    }
    // Each line as screen segments, on the same curve three-globe draws: a cubic Bezier from the
    // start to the end, with control points a quarter and three quarters along the great circle,
    // raised to 1.5 times the arc's height.
    const segs: [Pt, Pt][] = [];
    for (const a of drawn.filter((d) => d.layer === "main" || d.layer === "shadow")) {
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

    // 3. Cards. Each want tries every side of its box, full text first, then shorter forms.
    const cards: Card[] = [];
    const inView = (q: Pt[]) => q.every(([x, y]) => x >= 4 && y >= 4 && x <= W - 4 && y <= H - 4);
    const clash = (q: Pt[], skip?: Card) =>
      !inView(q) ||
      cards.some((c) => c !== skip && quadsHit(c.q, q)) ||
      nodes.some((n) => n.hull && quadsHit(n.hull, q)) ||
      segs.some(([a, b]) => segHitsQuad(a, b, q));
    const placeCard = (n: Node, lines: CardLine[], kind: NodeKind, skip?: Card, gap = CARD_GAP): Card | null => {
      if (!n.s || !n.hull) return null;
      const [w, h] = this.measure(lines, kind);
      const xs = n.hull.map((p) => p[0]);
      const ys = n.hull.map((p) => p[1]);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const at: Record<Orient, Pt> = {
        right: [x1 + gap, cy - h / 2],
        "right-up": [x1 + gap, y0 - h - gap / 2],
        "right-down": [x1 + gap, y1 + gap / 2],
        top: [cx - w / 2, y0 - gap - h],
        bottom: [cx - w / 2, y1 + gap],
        left: [x0 - gap - w, cy - h / 2],
        "left-up": [x0 - gap - w, y0 - h - gap / 2],
        "left-down": [x0 - gap - w, y1 + gap / 2],
      };
      for (const orient of ORIENTS) {
        const [x, y] = at[orient];
        const p = CARD_PAD;
        const q: Pt[] = [[x - p, y - p], [x + w + p, y - p], [x + w + p, y + h + p], [x - p, y + h + p]];
        if (!clash(q, skip)) return { n, lines, kind, orient, dx: x - n.s[0], dy: y - n.s[1], w, h, q, gap };
      }
      return null;
    };
    const kicker = (kind: NodeKind) => (kind === "home" ? "This PC" : kind === "relay" ? "Relay" : undefined);
    for (const w of [...this.raw.wants].sort((a, b) => a.prio - b.prio)) {
      const n = nodeOf.get(w.p);
      if (!n) continue;
      const kind = n.p.kind;
      const parts = w.text.split(" · ");
      const line: CardLine = parts.length > 1 ? { k: parts[0], t: parts.slice(1).join(" · ") } : { k: kicker(w.p.kind), t: w.text };
      // A second want for the same box adds a line to its card, if the taller card still fits.
      const mine = cards.find((c) => c.n === n);
      if (mine) {
        if (w.prio > 2 || mine.lines.some((l) => l.t === line.t)) continue;
        const grown = placeCard(n, [...mine.lines, line], kind, mine);
        if (grown) Object.assign(mine, grown);
        continue;
      }
      const short = line.t.split(",")[0];
      const tries: CardLine[][] = w.ref ? [[line]] : [[line], [{ k: line.k, t: short }], [{ t: short }]];
      // Home, a relay and a route end must show: when crowded they may stand a little further off their box.
      const gaps = w.prio <= 2 ? [CARD_GAP, CARD_GAP * 3, CARD_GAP * 6] : [CARD_GAP];
      found: for (const gap of gaps)
        for (const lines of tries) {
          const c = placeCard(n, lines, kind, undefined, gap);
          if (c) {
            cards.push(c);
            break found;
          }
        }
    }
    this.renderCards(cards);

    this.layoutAlt = alt;
    this.layoutDir = camDir;
    this.nodes.clear();
    this.g
      .arcsData(drawn)
      .objectsData(nodes.map((n) => n.p));
  }

  /** Card size in px for these lines, measured once in the hidden measuring layer. */
  private measure(lines: CardLine[], kind: NodeKind): [number, number] {
    const k = `${kind}|${lines.map((l) => `${l.k ?? ""}/${l.t}`).join("|")}`;
    let sz = this.sizes.get(k);
    if (!sz) {
      const el = this.cardEl(lines, kind);
      this.measurer.appendChild(el);
      sz = [Math.ceil(el.offsetWidth), Math.ceil(el.offsetHeight)];
      el.remove();
      this.sizes.set(k, sz);
    }
    return sz;
  }

  private cardEl(lines: CardLine[], kind: NodeKind): HTMLDivElement {
    const el = document.createElement("div");
    el.className = `gcard ${kind}`;
    el.innerHTML = lines.map((l) => `<div class="ln">${l.k ? `<span class="k">${esc(l.k)}</span>` : ""}<span class="t">${esc(l.t)}</span></div>`).join("");
    return el;
  }

  private renderCards(cards: Card[]): void {
    this.overlay.replaceChildren();
    this.cards = cards.map((c) => {
      const el = this.cardEl(c.lines, c.kind);
      el.dataset.orient = c.orient;
      // A card pushed further off than usual gets a hairline back to its box, so it is clear whose it is.
      let lead: HTMLDivElement | undefined;
      if ((c.gap ?? CARD_GAP) > CARD_GAP) {
        lead = document.createElement("div");
        lead.className = "glead";
        this.overlay.appendChild(lead);
      }
      this.overlay.appendChild(el);
      return { c, el, lead };
    });
    this.positionCards();
  }

  /** Cards follow their box on screen between layouts, and hide when it turns behind the globe. */
  private positionCards(): void {
    if (!this.cards.length) return;
    const cam = this.syncedCamera();
    const R = this.g.getGlobeRadius();
    const camDir = cam.position.clone().normalize();
    const rim = R / cam.position.length();
    const W = this.g.width();
    const H = this.g.height();
    for (const { c, el, lead } of this.cards) {
      const v = this.world(c.n.p.lat, c.n.p.lng, 0.002);
      const visible = v.clone().normalize().dot(camDir) > rim;
      const q = v.project(cam);
      if (!visible || Math.abs(q.z) >= 1) {
        el.style.visibility = "hidden";
        if (lead) lead.style.visibility = "hidden";
        continue;
      }
      const sx = ((q.x + 1) / 2) * W;
      const sy = ((1 - q.y) / 2) * H;
      const x = sx + c.dx;
      const y = sy + c.dy;
      el.style.visibility = "";
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
      if (lead) {
        // From the box to the nearest point of the card, starting a few px out so it does not cross the box.
        const ex = Math.min(Math.max(sx, x), x + c.w);
        const ey = Math.min(Math.max(sy, y), y + c.h);
        const len = Math.hypot(ex - sx, ey - sy);
        const skip = Math.min(6, len / 2);
        const ang = Math.atan2(ey - sy, ex - sx);
        lead.style.visibility = len > 12 ? "" : "hidden";
        lead.style.width = `${(len - skip).toFixed(1)}px`;
        lead.style.transform = `translate(${(sx + Math.cos(ang) * skip).toFixed(1)}px, ${(sy + Math.sin(ang) * skip).toFixed(1)}px) rotate(${ang.toFixed(4)}rad)`;
      }
    }
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
      if (!this.hoverTuned) this.tuneHover();
      this.onCamera();
      this.positionCards();
      const still = reduceMotion();
      LINE_HOME.opacity = still ? 1 : 0.55 + 0.45 * Math.cos((t / 1500) * Math.PI * 2);
      // The home ring spreads out and fades every 2.4 s.
      const ph = still ? 0.5 : (t % 2400) / 2400;
      RING_MAT.opacity = 0.55 * (1 - ph);
      for (const o of this.nodes) for (const ch of o.children) if (ch.userData.ring) ch.scale.setScalar(0.6 + 2.4 * ph);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** globe.gl builds the globe and atmosphere a tick after init, so this retries until both exist. */
  private tuneHover(): void {
    let globe = 0;
    let atmo = 0;
    this.g.scene().traverse((o) => {
      let type: string | undefined;
      for (let x: THREE.Object3D | null = o; x && !type; x = x.parent) type = (x as { __globeObjType?: string }).__globeObjType;
      if (type === "atmosphere") {
        o.layers.set(NO_HOVER);
        atmo++;
      } else if (type === "globe" && (o as THREE.Mesh).geometry instanceof THREE.SphereGeometry) {
        o.raycast = sphereRaycast;
        globe++;
      }
    });
    this.hoverTuned = globe > 0 && atmo > 0;
  }

  /**
   * The camera as the next frame will draw it. After a resize globe.gl only updates the camera's
   * aspect on its next render, so a layout run before then would place cards for the old shape.
   */
  private syncedCamera(): THREE.PerspectiveCamera {
    const cam = this.g.camera() as THREE.PerspectiveCamera;
    const aspect = this.g.width() / this.g.height();
    if (Math.abs(cam.aspect - aspect) > 1e-6) {
      cam.aspect = aspect;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
    return cam;
  }

  /** Follow the element's size. A new size moves every box on screen, so cards are placed again. */
  private fit(): void {
    this.g.width(this.el.clientWidth).height(this.el.clientHeight);
    this.applyShift();
    if (this.raw.points.length || this.raw.arcs.length) requestAnimationFrame(() => this.layout());
  }
}
