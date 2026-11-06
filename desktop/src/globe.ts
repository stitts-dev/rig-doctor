// Monochrome globe. Black sphere, land as fine white hex dots, routes as arcs.
// Grey dashed = the path packets take today. White solid = the best relay route.
// Dim = every other traced destination, so the globe shows the machine's whole footprint.

import Globe, { type GlobeInstance } from "globe.gl";

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

export interface PointDatum {
  lat: number;
  lng: number;
  label: string;
  detail: string;
  radius: number;
  color: string;
  text?: string;
}

export interface RingDatum {
  lat: number;
  lng: number;
}

export class RouteGlobe {
  private g: GlobeInstance;
  private spinning = false;

  constructor(private el: HTMLElement) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
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
      .pointLat((d: object) => (d as PointDatum).lat)
      .pointLng((d: object) => (d as PointDatum).lng)
      .pointColor((d: object) => (d as PointDatum).color)
      .pointAltitude(0.006)
      .pointRadius((d: object) => (d as PointDatum).radius)
      .pointLabel((d: object) => {
        const p = d as PointDatum;
        return `<div class="tooltip"><b>${p.label}</b><br><span class="m">${p.detail}</span></div>`;
      })
      .labelLat((d: object) => (d as PointDatum).lat)
      .labelLng((d: object) => (d as PointDatum).lng)
      .labelText((d: object) => (d as PointDatum).text ?? "")
      .labelSize(0.14)
      .labelDotRadius(0)
      .labelColor(() => "rgba(255,255,255,0.85)")
      .labelAltitude(0.012)
      .labelResolution(3)
      .ringLat((d: object) => (d as RingDatum).lat)
      .ringLng((d: object) => (d as RingDatum).lng)
      .ringColor(() => (t: number) => `rgba(255,255,255,${0.7 * (1 - t)})`)
      .ringMaxRadius(1.4)
      .ringPropagationSpeed(0.9)
      .ringRepeatPeriod(1500);

    const mat = this.g.globeMaterial() as unknown as { color: { set(c: string): void }; emissive: { set(c: string): void }; shininess: number };
    mat.color.set("#000000");
    mat.emissive.set("#000000");
    mat.shininess = 0;

    const ctl = this.g.controls() as unknown as { autoRotateSpeed: number; autoRotate: boolean; enableDamping: boolean; dampingFactor: number };
    ctl.enableDamping = true;
    ctl.dampingFactor = 0.08;
    ctl.autoRotateSpeed = 0.5;

    this.fit();
    new ResizeObserver(() => this.fit()).observe(el);
  }

  async loadLand(url: string): Promise<void> {
    const res = await fetch(url);
    const geo = (await res.json()) as { features: object[] };
    this.g.polygonsData(geo.features);
  }

  setData(arcs: ArcDatum[], points: PointDatum[], rings: RingDatum[]): void {
    this.g.arcsData(arcs).pointsData(points).labelsData(points.filter((p) => p.text)).ringsData(rings);
  }

  flyTo(lat: number, lng: number, altitude = 0.4, ms = 900): void {
    this.g.pointOfView({ lat, lng, altitude }, ms);
  }

  /** Frame a set of points: centroid plus an altitude from their spread. */
  fitPoints(pts: { lat: number; lng: number }[]): void {
    if (!pts.length) return;
    const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;
    const spread = Math.max(...pts.map((p) => Math.hypot(p.lat - lat, (p.lng - lng) * Math.cos((lat * Math.PI) / 180))));
    const altitude = Math.min(2.5, Math.max(0.55, spread / 12));
    this.g.pointOfView({ lat, lng, altitude }, 900);
  }

  toggleSpin(): boolean {
    this.spinning = !this.spinning;
    (this.g.controls() as unknown as { autoRotate: boolean }).autoRotate = this.spinning;
    return this.spinning;
  }

  private fit(): void {
    this.g.width(this.el.clientWidth).height(this.el.clientHeight);
  }
}
