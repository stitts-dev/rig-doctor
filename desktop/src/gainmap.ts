// The ISP gain map: the relay's gain table (relay_gain_map) laid out by region. One box per region,
// one line per ISP network in it. A number is quoted only once MIN_PLAYERS players reported it, the
// rule the relay card uses (gain.rs view): in-game numbers first, gain check estimates after.

import { placeOf, type Place } from "./regions";

/** A row of the relay's table (gain.rs Row). `region` null covers the whole network. */
export interface GainRow {
  source: "in_game" | "estimate";
  asn: number;
  region: string | null;
  players: number;
  median_gain_ms: number;
  gaining: number;
  median_direct_ms: number;
  median_relay_ms: number;
}

/** relay_gain_map (gain.rs GainMap). */
export interface GainMap {
  relay: string;
  bar_ms: number;
  min_players: number;
  rows: GainRow[];
  own: { asn: number; isp: string | null; region: string | null } | null;
  fetched_ms: number;
}

/** One network in one region, as the map words it. */
export interface GainCell {
  asn: number;
  region: string | null;
  /** "gain", "none", "worse" once a row has enough players, else "few". */
  kind: "gain" | "none" | "worse" | "few";
  /** The row quoted, or null while too few players reported. */
  source: GainRow["source"] | null;
  players: number;
  gain_ms: number | null;
  /** The quoted row's medians, for the tooltip. */
  row: GainRow | null;
  own: boolean;
}

/** A region with a place on the map and the networks reported in it. */
export interface GainRegion {
  region: string;
  place: Place;
  cells: GainCell[];
}

export interface GainLayout {
  placed: GainRegion[];
  /** Cells the map has no place for: a whole network (no region), or a region it does not know. */
  unplaced: GainCell[];
}

/** Quoted cells first, the biggest gain first, then the ones still counting players, most first. */
const order = (a: GainCell, b: GainCell): number => (a.gain_ms == null ? 1 : 0) - (b.gain_ms == null ? 1 : 0) || (b.gain_ms ?? 0) - (a.gain_ms ?? 0) || b.players - a.players || a.asn - b.asn;

/** The table's rows as one cell per network and region. */
export function cellsOf(m: GainMap): GainCell[] {
  const groups = new Map<string, GainRow[]>();
  for (const r of m.rows) {
    const k = `${r.asn}|${r.region ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const kind = (g: number): GainCell["kind"] => (g >= m.bar_ms ? "gain" : g <= -m.bar_ms ? "worse" : "none");
  const out: GainCell[] = [];
  for (const rows of groups.values()) {
    const { asn, region } = rows[0];
    const own = m.own?.asn === asn;
    const find = (s: GainRow["source"]) => rows.find((r) => r.source === s);
    const quoted = [find("in_game"), find("estimate")].find((r) => r && r.players >= m.min_players);
    if (quoted) out.push({ asn, region, kind: kind(quoted.median_gain_ms), source: quoted.source, players: quoted.players, gain_ms: quoted.median_gain_ms, row: quoted, own });
    else out.push({ asn, region, kind: "few", source: null, players: Math.max(...rows.map((r) => r.players)), gain_ms: null, row: null, own });
  }
  return out.sort(order);
}

/** Cells grouped by the region they sit in, with the place each region goes. */
export function layout(m: GainMap, countries: Map<string, [number, number]>): GainLayout {
  const placed = new Map<string, GainRegion>();
  const unplaced: GainCell[] = [];
  for (const c of cellsOf(m)) {
    const place = c.region ? placeOf(c.region, countries) : null;
    if (!c.region || !place) {
      unplaced.push(c);
      continue;
    }
    const g = placed.get(c.region) ?? { region: c.region, place, cells: [] };
    g.cells.push(c);
    placed.set(c.region, g);
  }
  return { placed: [...placed.values()].sort((a, b) => order(a.cells[0], b.cells[0])), unplaced };
}

/** "AS7922", or "Your ISP (AS7922)" for this machine's network. */
export const netName = (c: GainCell): string => (c.own ? `Your ISP (AS${c.asn})` : `AS${c.asn}`);

/** What a cell measured, short: "gains 14 ms", "no gain", "2 of 3 players". */
export function cellValue(c: GainCell, minPlayers: number): string {
  if (c.gain_ms == null) return `${c.players} of ${minPlayers} players`;
  const est = c.source === "estimate" ? "est. " : "";
  const g = Math.round(c.gain_ms);
  return est + (c.kind === "gain" ? `gains ${g} ms` : c.kind === "worse" ? `loses ${-g} ms` : g > 0 ? `+${g} ms, no gain` : g < 0 ? `${g} ms, no gain` : "no gain");
}

/** The card on a region's box: the region, then its best network, and how many others. */
export function cardText(g: GainRegion, minPlayers: number): string {
  const top = g.cells[0];
  const more = g.cells.length > 1 ? ` · +${g.cells.length - 1} more` : "";
  return `${g.place.name} · ${netName(top)} ${cellValue(top, minPlayers)}${more}`;
}

/** A region box is lit when a network in it gains the bar in game. */
export const lit = (g: GainRegion): boolean => g.cells.some((c) => c.kind === "gain" && c.source === "in_game");
