// Locating hops. Reverse DNS beats IP geolocation for backbone routers, because
// carriers write the city into the router name and GeoIP databases usually put
// backbone addresses at the company HQ. So: rDNS city first, GeoIP second.

export interface Place {
  name: string;
  lat: number;
  lng: number;
}

const CITY: Record<string, Place> = {
  // Comcast-style "city.state" tokens
  "bethelpark.pa": { name: "Bethel Park, PA", lat: 40.327, lng: -80.037 },
  "mckeesport.pa": { name: "McKeesport, PA", lat: 40.348, lng: -79.864 },
  "pittsburgh.pa": { name: "Pittsburgh, PA", lat: 40.441, lng: -79.996 },
  "ashburn.va": { name: "Ashburn, VA", lat: 39.044, lng: -77.488 },
  "350ecermak.il": { name: "Chicago, IL (350 E Cermak)", lat: 41.853, lng: -87.618 },
  "chicago.il": { name: "Chicago, IL", lat: 41.878, lng: -87.63 },
  "newyork.ny": { name: "New York, NY", lat: 40.713, lng: -74.006 },
  "111eighthave.ny": { name: "New York, NY (111 8th Ave)", lat: 40.741, lng: -74.004 },
  "60hudson.ny": { name: "New York, NY (60 Hudson)", lat: 40.717, lng: -74.009 },
  "atlanta.ga": { name: "Atlanta, GA", lat: 33.749, lng: -84.388 },
  "56marietta.ga": { name: "Atlanta, GA (56 Marietta)", lat: 33.757, lng: -84.391 },
  "dallas.tx": { name: "Dallas, TX", lat: 32.777, lng: -96.797 },
  "houston.tx": { name: "Houston, TX", lat: 29.76, lng: -95.37 },
  "denver.co": { name: "Denver, CO", lat: 39.739, lng: -104.99 },
  "seattle.wa": { name: "Seattle, WA", lat: 47.606, lng: -122.332 },
  "sanjose.ca": { name: "San Jose, CA", lat: 37.339, lng: -121.895 },
  "losangeles.ca": { name: "Los Angeles, CA", lat: 34.052, lng: -118.244 },
  "miami.fl": { name: "Miami, FL", lat: 25.762, lng: -80.192 },
  "boston.ma": { name: "Boston, MA", lat: 42.36, lng: -71.059 },
  "philadelphia.pa": { name: "Philadelphia, PA", lat: 39.953, lng: -75.165 },
  "cleveland.oh": { name: "Cleveland, OH", lat: 41.499, lng: -81.694 },
  "detroit.mi": { name: "Detroit, MI", lat: 42.331, lng: -83.046 },
  "minneapolis.mn": { name: "Minneapolis, MN", lat: 44.978, lng: -93.265 },
  "saltlakecity.ut": { name: "Salt Lake City, UT", lat: 40.761, lng: -111.891 },
  "phoenix.az": { name: "Phoenix, AZ", lat: 33.448, lng: -112.074 },
  "sacramento.ca": { name: "Sacramento, CA", lat: 38.582, lng: -121.494 },
  "portland.or": { name: "Portland, OR", lat: 45.515, lng: -122.678 },
  "nashville.tn": { name: "Nashville, TN", lat: 36.163, lng: -86.782 },
  "charlotte.nc": { name: "Charlotte, NC", lat: 35.227, lng: -80.843 },
  "washington.dc": { name: "Washington, DC", lat: 38.907, lng: -77.037 },
};

// Airport-style codes used by Riot Direct, GTT, Cogent, Zayo and most transit carriers.
const CODE: Record<string, Place> = {
  was: { name: "Washington, DC", lat: 38.907, lng: -77.037 },
  iad: { name: "Ashburn, VA", lat: 39.044, lng: -77.488 },
  dca: { name: "Washington, DC", lat: 38.907, lng: -77.037 },
  chi: { name: "Chicago, IL", lat: 41.878, lng: -87.63 },
  ord: { name: "Chicago, IL", lat: 41.878, lng: -87.63 },
  nyc: { name: "New York, NY", lat: 40.713, lng: -74.006 },
  jfk: { name: "New York, NY", lat: 40.713, lng: -74.006 },
  ewr: { name: "Newark, NJ", lat: 40.736, lng: -74.172 },
  lax: { name: "Los Angeles, CA", lat: 34.052, lng: -118.244 },
  sjc: { name: "San Jose, CA", lat: 37.339, lng: -121.895 },
  sfo: { name: "San Francisco, CA", lat: 37.775, lng: -122.419 },
  sea: { name: "Seattle, WA", lat: 47.606, lng: -122.332 },
  dfw: { name: "Dallas, TX", lat: 32.777, lng: -96.797 },
  dal: { name: "Dallas, TX", lat: 32.777, lng: -96.797 },
  iah: { name: "Houston, TX", lat: 29.76, lng: -95.37 },
  atl: { name: "Atlanta, GA", lat: 33.749, lng: -84.388 },
  mia: { name: "Miami, FL", lat: 25.762, lng: -80.192 },
  den: { name: "Denver, CO", lat: 39.739, lng: -104.99 },
  phx: { name: "Phoenix, AZ", lat: 33.448, lng: -112.074 },
  bos: { name: "Boston, MA", lat: 42.36, lng: -71.059 },
  phl: { name: "Philadelphia, PA", lat: 39.953, lng: -75.165 },
  pit: { name: "Pittsburgh, PA", lat: 40.441, lng: -79.996 },
  cle: { name: "Cleveland, OH", lat: 41.499, lng: -81.694 },
  det: { name: "Detroit, MI", lat: 42.331, lng: -83.046 },
  msp: { name: "Minneapolis, MN", lat: 44.978, lng: -93.265 },
  slc: { name: "Salt Lake City, UT", lat: 40.761, lng: -111.891 },
  tor: { name: "Toronto, ON", lat: 43.651, lng: -79.383 },
  yyz: { name: "Toronto, ON", lat: 43.651, lng: -79.383 },
  lhr: { name: "London", lat: 51.507, lng: -0.128 },
  lon: { name: "London", lat: 51.507, lng: -0.128 },
  ams: { name: "Amsterdam", lat: 52.37, lng: 4.895 },
  fra: { name: "Frankfurt", lat: 50.111, lng: 8.682 },
  par: { name: "Paris", lat: 48.857, lng: 2.352 },
  cdg: { name: "Paris", lat: 48.857, lng: 2.352 },
  tok: { name: "Tokyo", lat: 35.676, lng: 139.65 },
  nrt: { name: "Tokyo", lat: 35.676, lng: 139.65 },
  hkg: { name: "Hong Kong", lat: 22.319, lng: 114.17 },
  sin: { name: "Singapore", lat: 1.352, lng: 103.82 },
  syd: { name: "Sydney", lat: -33.869, lng: 151.209 },
  sao: { name: "São Paulo", lat: -23.551, lng: -46.633 },
  gru: { name: "São Paulo", lat: -23.551, lng: -46.633 },
};

/** Try to place a router from its reverse DNS name. */
export function placeFromRdns(name: string): Place | undefined {
  const n = name.toLowerCase();
  // Comcast: po-57-rur301.bethelpark.pa.pitt.comcast.net  /  be-4112-pe12.ashburn.va.ibone.comcast.net
  const m1 = n.match(/\.([a-z0-9]+)\.([a-z]{2})\.(?:ibone|pitt|[a-z]+)\.comcast\.net$/);
  if (m1) {
    const key = `${m1[1]}.${m1[2]}`;
    if (CITY[key]) return CITY[key];
  }
  // Generic "city.state" anywhere in the name
  for (const key of Object.keys(CITY)) {
    if (n.includes(`.${key}.`)) return CITY[key];
  }
  // Airport codes as a label, optionally followed by digits: er02.was01.riotdirect.net, cr1.ord6.scnet.net, ae2.cr3-lax2.ip4.gtt.net
  const parts = n.split(/[.\-]/);
  for (const p of parts) {
    const m = p.match(/^([a-z]{3})\d{0,3}$/);
    if (m && CODE[m[1]]) return CODE[m[1]];
  }
  return undefined;
}

export function isPrivateIp(ip: string): boolean {
  if (ip.includes(":")) return /^(fe80|fc|fd|::1)/i.test(ip);
  const o = ip.split(".").map(Number);
  if (o.length !== 4) return false;
  return (
    o[0] === 10 ||
    o[0] === 127 ||
    (o[0] === 192 && o[1] === 168) ||
    (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
    (o[0] === 100 && o[1] >= 64 && o[1] <= 127) ||
    (o[0] === 169 && o[1] === 254)
  );
}

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLat = toR(bLat - aLat);
  const dLng = toR(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(aLat)) * Math.cos(toR(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Round trip over fiber is close to 1 ms per 100 km of route, plus a floor for the last hop and queueing. */
export function estimateLegMs(km: number): number {
  return Math.max(2, km * 0.0105 + 1);
}

export interface RttBound {
  /** Distance covered per millisecond of round trip. */
  kmPerMs: number;
  /** Slack for GeoIP and home-location error. */
  slackKm: number;
}

/**
 * The hard limit: light in fibre covers about 100 km of distance per millisecond of RTT
 * (200 km/ms each way). For places from a router name or a relay, which are usually right
 * or anycast, and should only be refused when physically impossible.
 */
export const PHYSICAL: RttBound = { kmPerMs: 100, slackKm: 200 };

/**
 * The realistic limit for GeoIP, which often files ISP backbone addresses at a company office:
 * real routes run about 1.6 times the straight-line distance, so about 60 km per ms, counted
 * after the access network's own delay (the RTT to the ISP's first router).
 */
export const REALISTIC: RttBound = { kmPerMs: 60, slackKm: 150 };

/**
 * Whether a place can be this far from home given a measured round trip.
 * `baselineMs` is the delay before the packet leaves the access network, which covers no distance.
 * A hop answering in 23 ms cannot sit 3,400 km away under either limit; a Comcast backbone address
 * at 17 ms with a 10 ms access delay cannot be in Woburn, MA, 730 km away, under the realistic one.
 */
export function plausibleForRtt(homeLat: number, homeLng: number, lat: number, lng: number, minRttMs: number, bound: RttBound = PHYSICAL, baselineMs = 0): boolean {
  return haversineKm(homeLat, homeLng, lat, lng) <= Math.max(0, minRttMs - baselineMs) * bound.kmPerMs + bound.slackKm;
}
