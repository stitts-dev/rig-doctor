export interface Conn {
  pid: number;
  process: string;
  proto: "tcp" | "udp";
  local: string;
  remote_ip: string;
  remote_port: number;
  state: string;
}

export interface HopEvent {
  id: string;
  hop: number;
  ip: string | null;
  rtts: (number | null)[];
  avg: number | null;
}

export interface RdnsEvent {
  id: string;
  hop: number;
  ip: string;
  name: string;
}

export interface DoneEvent {
  id: string;
  ok: boolean;
  error: string | null;
}

export interface PingStats {
  host: string;
  sent: number;
  received: number;
  min: number | null;
  avg: number | null;
  max: number | null;
  p95: number | null;
  jitter: number | null;
}

export interface Geo {
  query: string;
  status: string;
  city?: string | null;
  regionName?: string | null;
  country?: string | null;
  lat?: number | null;
  lon?: number | null;
  isp?: string | null;
  as?: string | null;
}

export interface Relay {
  name: string;
  host: string;
  lat?: number | null;
  lng?: number | null;
}

export interface Config {
  relays: Relay[];
  focus?: string | null;
  peak?: PeakConfig | null;
}

/** Peak-hour trace log settings. Times are local "HH:MM"; end "24:00" is midnight. */
export interface PeakConfig {
  target: string;
  start: string;
  end: string;
  every_min: number;
  days: number;
  /** When the scheduled run stops, local "YYYY-MM-DDTHH:MM:SS". */
  until?: string | null;
}

export interface PeakHop {
  hop: number;
  ip: string | null;
  rtts: (number | null)[];
  avg: number | null;
  rdns?: string;
}

/** One line of peak-log.jsonl. */
export interface PeakSample {
  ts: number;
  target: string;
  hops: PeakHop[];
  ping: PingStats | null;
  ok: boolean;
  error?: string | null;
}

export interface PeakStatus {
  scheduled: boolean;
  log_path: string;
  samples: number;
}

export interface SchedulePlan {
  start_boundary: string;
  end_boundary: string;
  every_min: number;
  duration_min: number;
}

export interface TsPeer {
  name: string;
  ip: string;
  online: boolean;
  exit_node_option: boolean;
}

/** A hop after location resolution. */
export interface Hop {
  hop: number;
  ip: string | null;
  rtts: (number | null)[];
  avg: number | null;
  rdns?: string;
  lat?: number;
  lng?: number;
  place?: string;
  source?: "home" | "rdns" | "geo";
  detour?: boolean;
  /** Set when the only location on offer is too far away for the hop's RTT. */
  implausible?: string;
  /** Set when GeoIP's place did not fit the neighbouring hops' RTTs, so the hop sits at the last trusted one. Says why. */
  estimated?: string;
}

export interface Trace {
  id: string;
  target: string;
  hops: Map<number, Hop>;
  done: boolean;
  error?: string;
  startedAt: number;
  /** The finished trace a re-run replaces; restored if the re-run comes back worse. */
  previous?: Trace;
  /** Shown under the route, such as why an earlier run was kept. */
  note?: string;
  /** Distinct paths seen across runs to this destination, carried over by every re-trace. */
  variants?: RouteVariant[];
}

/** One path a destination has been reached by. */
export interface RouteVariant {
  /** Networks and cities in order, from route.pathKey. */
  key: string[];
  hops: Hop[];
  /** Destination RTT, or the last answering hop's when the destination is silent. */
  rtt?: number;
  destReplied: boolean;
  runs: number;
  lastSeen: number;
}

export interface Dest {
  key: string;
  ip: string;
  port: number;
  proto: "tcp" | "udp";
  processes: Set<string>;
  count: number;
}

export interface RelayMeasure {
  relay: Relay;
  rtt: number | null;
  lat?: number;
  lng?: number;
  legEst?: number;
  total?: number;
  /** Why the relay has no location, when GeoIP placed it too far for its ping (anycast). */
  geoNote?: string;
}

/** One route's measurement in a relay comparison, raw from the backend. */
export interface RouteMeasure {
  sent: number;
  received: number;
  /** Every ping in order, null when it was lost. */
  rtts: (number | null)[];
  min: number | null;
  median: number | null;
  p90: number | null;
  /** Mean absolute difference between consecutive replies. */
  jitter: number | null;
  /** Traceroute of the route. Through the tunnel, the relay answers first from its tunnel address. */
  hops: PeakHop[];
}

/** Result of `relay_compare`: the same target measured direct and through the relay, back to back. */
export interface RelayComparison {
  target: string;
  relay_host: string;
  started_at: number;
  finished_at: number;
  direct: RouteMeasure;
  /** Null when the relay could not be measured (tunnel down); `error` says why. */
  relay: RouteMeasure | null;
  error: string | null;
  /** The record the backend judged and saved for this run. */
  record?: import("./proof").JudgedRecord;
  /** Why the record could not be saved, when it could not. */
  log_error?: string;
}

/** Optional `compare:progress` event while `relay_compare` runs. */
export interface CompareProgress {
  phase: "direct" | "relay";
  done: number;
  total: number;
}
