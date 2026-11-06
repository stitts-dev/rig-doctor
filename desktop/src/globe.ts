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
  text?: string;
}

// Node box size in globe units per unit of camera altitude, so a node keeps its size on screen.
const NODE_PER_ALT = 1.1;
const SCALE: Record<NodeKind, number> = { home: 1.3, relay: 1.15, hop: 1 };
// Label text height in degrees per unit of camera altitude.
const LABEL_PER_ALT = 0.75;

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
  private labels: PointDatum[] = [];
  private alt = 2.5;
  private labelAlt = 0;

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
      .labelLat((d: object) => (d as PointDatum).lat)
      .labelLng((d: object) => this.labelLng(d as PointDatum))
      .labelText((d: object) => (d as PointDatum).text ?? "")
      .labelSize(() => this.labelSize())
      .labelDotRadius(0)
      .labelDotOrientation(() => "right")
      .labelColor(() => "rgba(255,255,255,0.85)")
      .labelAltitude(0.012)
      .labelResolution(3)
      .onZoom((pov) => this.onZoom(pov.altitude));

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

  setData(arcs: ArcDatum[], points: PointDatum[]): void {
    this.nodes.clear();
    this.labels = points.filter((p) => p.text);
    this.labelAlt = this.alt;
    this.g.arcsData(arcs).objectsData(points).labelsData(this.labels);
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
  private labelLng(p: PointDatum): number {
    const halfBoxDeg = (this.alt * NODE_PER_ALT * SCALE[p.kind] * 0.5) / ((this.g.getGlobeRadius() * Math.PI) / 180);
    return p.lng + (halfBoxDeg * 1.6) / Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
  }

  private onZoom(altitude: number): void {
    this.alt = altitude;
    for (const o of this.nodes) this.scaleNode(o);
    // Labels are text meshes: rebuild them only once zoom has moved by more than 15%.
    if (this.labels.length && Math.abs(altitude - this.labelAlt) / this.labelAlt > 0.15) {
      this.labelAlt = altitude;
      this.g.labelsData([...this.labels]);
    }
  }

  /** The home node's border breathes instead of a ring pulse. Off under reduced motion. */
  private pulseHome(): void {
    const tick = (t: number) => {
      LINE_HOME.opacity = reduceMotion() ? 1 : 0.55 + 0.45 * Math.cos((t / 1500) * Math.PI * 2);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  private fit(): void {
    this.g.width(this.el.clientWidth).height(this.el.clientHeight);
  }
}
