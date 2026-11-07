# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Tauri 2 desktop app (Windows primary, macOS second). The UI is a web view, so web rules apply; there is no native design language to follow.

## Users

League of Legends NA players on Windows (macOS second) who suspect their route to Riot's Chicago game server costs them ping. They open the app before or between matches, glance at it mid-session, and want one answer: is my traffic going the fastest way, and is the relay worth paying for. The developer (Jaden) is also a daily user on his own gaming PC.

## Product Purpose

Rig Doctor Globe shows where game traffic actually goes, on a 3D globe, picks direct or relay per path, and proves the choice with measurements. Success is a player who can see in seconds which path their game uses, how many milliseconds each hop adds, and whether the relay measurably beats direct in real matches.

## Positioning

A game-traffic relay that proves its own value. Every match is measured direct vs relay from in-game logs, and any month without a measured gain is refunded. Competitors sell ping reduction without proof; Rig Doctor sells proof first.

## Operating Context

- Used on a gaming PC, often while a League client or match is running. The app must never steal focus or interrupt a game.
- Relay: WireGuard to a Vultr Chicago server that forwards only Riot game-server ranges. Modes: Manual (On/Off) and Auto (decides from match logs, 10 ms bar).
- Views: the globe with route cards, Relay control, Processes, Selected route, Relays, Journey, Routes, Hops, Proof drawer, Peak-hour log drawer.

## Capabilities and Constraints

- Measured from the player's machine: traceroute hops, per-hop latency, in-game ping from League match logs. Relay-to-destination time is estimated from distance until measured in game.
- Map rules: nodes are bordered server boxes, not circles; routes are 3D arcs that bend with the globe; no overlap of lines, nodes or labels (enforced by `qa/overlap-check.cjs`).
- Public repo: no real IP addresses in fixtures or screenshots; use documentation ranges.
- Pricing target $4.99/mo, no-card trial, one-click cancel, auto-refund. Not yet live; the ship rule is a measured 10 ms in-game gain.

## Brand Commitments

- Name "Rig Doctor", app title "Rig Doctor Globe".
- Keep the existing palette: black ground, white ink, greys (secondary grey #7a7a7a). No blue.
- Voice: plain, factual, measured numbers over claims.

## Evidence on Hand

- Replay backend data for the UI (`src/replay-proof.ts`, dev server on port 1420).
- Measured: relay vs direct is a tie on Jaden's own line (about 30 ms both). No testimonials, customer counts or published benchmarks exist; do not invent them.

## Product Principles

1. Proof before promise: every claim on screen traces to a measurement, and estimates are labeled as estimates.
2. One glance answers "which path is my game on, and is it the fast one".
3. Never get in the way of a match: no focus theft, no surprise tunnel drops.
4. The globe is the hero; panels explain it rather than compete with it.
