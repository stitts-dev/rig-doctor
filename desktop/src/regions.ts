// Where the gain map puts a region from the relay's gain table. The table files players by the
// region of the offline GeoIP database, "Pennsylvania, United States", or the country alone.
// A state or province sits at its geographic centre (rounded public figures). A country alone sits
// at the middle of its largest land polygon. Anything else is listed, never guessed onto the map.

/** Geographic centres of US states and DC, as [lat, lng]. */
const US: Record<string, [number, number]> = {
  Alabama: [32.79, -86.83], Alaska: [64.73, -152.47], Arizona: [34.27, -111.66], Arkansas: [34.89, -92.44],
  California: [37.18, -119.47], Colorado: [38.99, -105.55], Connecticut: [41.62, -72.73], Delaware: [38.99, -75.51],
  "District of Columbia": [38.9, -77.03], Florida: [28.63, -82.45], Georgia: [32.64, -83.44], Hawaii: [20.29, -156.37],
  Idaho: [44.35, -114.61], Illinois: [40.04, -89.2], Indiana: [39.89, -86.28], Iowa: [42.08, -93.5],
  Kansas: [38.49, -98.38], Kentucky: [37.53, -85.3], Louisiana: [31.07, -92.0], Maine: [45.37, -69.24],
  Maryland: [39.06, -76.8], Massachusetts: [42.26, -71.81], Michigan: [44.35, -85.41], Minnesota: [46.28, -94.31],
  Mississippi: [32.74, -89.67], Missouri: [38.36, -92.46], Montana: [47.05, -109.63], Nebraska: [41.54, -99.8],
  Nevada: [39.33, -116.63], "New Hampshire": [43.68, -71.58], "New Jersey": [40.19, -74.67], "New Mexico": [34.41, -106.11],
  "New York": [42.95, -75.53], "North Carolina": [35.56, -79.39], "North Dakota": [47.45, -100.47], Ohio: [40.29, -82.79],
  Oklahoma: [35.59, -97.49], Oregon: [43.93, -120.56], Pennsylvania: [40.88, -77.8], "Rhode Island": [41.68, -71.56],
  "South Carolina": [33.92, -80.9], "South Dakota": [44.44, -100.23], Tennessee: [35.86, -86.35], Texas: [31.48, -99.33],
  Utah: [39.31, -111.67], Vermont: [44.07, -72.67], Virginia: [37.52, -78.85], Washington: [47.38, -120.45],
  "West Virginia": [38.64, -80.62], Wisconsin: [44.62, -89.99], Wyoming: [43.0, -107.55],
};

/** Geographic centres of Canadian provinces and territories, as [lat, lng]. */
const CA: Record<string, [number, number]> = {
  Alberta: [55.0, -115.0], "British Columbia": [53.73, -127.65], Manitoba: [55.0, -97.0], "New Brunswick": [46.5, -66.25],
  "Newfoundland and Labrador": [53.14, -57.66], "Nova Scotia": [45.0, -63.0], Ontario: [50.0, -85.0], "Prince Edward Island": [46.25, -63.0],
  Quebec: [52.94, -73.55], Saskatchewan: [55.0, -106.0], "Northwest Territories": [64.83, -124.85], Nunavut: [70.3, -83.1], Yukon: [64.28, -135.0],
};

const SUBDIVISIONS: Record<string, Record<string, [number, number]>> = { "United States": US, Canada: CA };

/** The database's country names where the land file spells them another way. */
const LAND_NAME: Record<string, string> = { "United States": "United States of America", "Dominican Republic": "Dominican Rep.", "Bosnia and Herzegovina": "Bosnia and Herz.", "North Macedonia": "Macedonia" };

export interface Place {
  lat: number;
  lng: number;
  /** The card's name: the state alone, or the country. */
  name: string;
  /** "state" when placed at a subdivision's centre, "country" at a country's. */
  level: "state" | "country";
}

type Ring = [number, number][];
interface LandFeature {
  properties: { name: string };
  geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
}

/** Middle of a country's largest polygon (by bounding box), as [lat, lng]. */
function countryCentre(f: LandFeature): [number, number] | null {
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  let best: [number, number] | null = null;
  let bestArea = -1;
  for (const p of polys) {
    const ring = p[0];
    if (!ring?.length) continue;
    const lngs = ring.map((c) => c[0]);
    const lats = ring.map((c) => c[1]);
    const [x0, x1, y0, y1] = [Math.min(...lngs), Math.max(...lngs), Math.min(...lats), Math.max(...lats)];
    const area = (x1 - x0) * (y1 - y0);
    if (area > bestArea) [bestArea, best] = [area, [(y0 + y1) / 2, (x0 + x1) / 2]];
  }
  return best;
}

/** Country centres from the land file the globe draws. */
export function countryCentres(land: { features: LandFeature[] }): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  for (const f of land.features) {
    const c = countryCentre(f);
    if (c && f.properties?.name) out.set(f.properties.name, c);
  }
  return out;
}

/** Where a table region goes on the map, or null when the app has no place for it. */
export function placeOf(region: string, countries: Map<string, [number, number]>): Place | null {
  const parts = region.split(",").map((s) => s.trim());
  if (parts.length === 1) {
    const c = countries.get(LAND_NAME[parts[0]] ?? parts[0]);
    return c ? { lat: c[0], lng: c[1], name: parts[0], level: "country" } : null;
  }
  const country = parts[parts.length - 1];
  const sub = parts.slice(0, -1).join(", ");
  const at = SUBDIVISIONS[country]?.[sub];
  return at ? { lat: at[0], lng: at[1], name: sub, level: "state" } : null;
}
