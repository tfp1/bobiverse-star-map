/**
 * Non-spatial / off-map data layer (handoff §1 D6–D10).
 *
 * The Bobiverse story includes systems and megastructures that have no
 * place in stars-near.bin: either they're beyond the local-bubble
 * render volume (Centaurvania, Jabberwocky, Skippyland), or they're
 * an unspatializable concept (Hub Zero, Sgr A* at 26 000 ly). Per the
 * design decisions in handoff §1:
 *
 *   D6 — Off-map distant systems sit on a "ring sphere" at ~120 pc,
 *        deterministic per name, ghosted markers.
 *   D7 — Sagittarius A* uses its real heliocentric direction (RA/Dec)
 *        but the same ~120 pc placeholder radius — the canvas can't
 *        hold 26 kly to scale.
 *   D9 — Megastructures with a host (Heaven's River @ Eta Leporis,
 *        Matryoshka Brain @ Epsilon Eri) render beside their host at
 *        a small offset.
 *   D10 — Sub-locations (Heaven's River's 12 inner places, etc.)
 *        never become top-level nodes; they belong to a megastructure.
 *
 * Source-of-truth is gazetteer.json at the repo root. first_book and
 * date_year values are derived once here from the gazetteer notes
 * (the notes are unstructured prose, so we encode the parse below
 * rather than relying on regex at runtime).
 */

import gazetteerRaw from '../../../gazetteer.json';
import type { SpatialSystem, Megastructure } from './types';

const RING_RADIUS_PC = 120;
const MEGASTRUCTURE_OFFSET_PC = 0.3;

interface GazetteerOffMap {
	name: string;
	confidence: string;
	note: string;
}

interface GazetteerMegastructure {
	name: string;
	system: string | null;
	type: string;
	confidence: string;
	note: string;
}

interface Gazetteer {
	off_map_systems: GazetteerOffMap[];
	megastructures: GazetteerMegastructure[];
}

const gz = gazetteerRaw as unknown as Gazetteer;

/**
 * first_book + date_year overrides. The gazetteer notes carry chapter
 * codes inline ("B5 C48", "B4-1 C30") but as free-text. Encoded here
 * rather than parsed at runtime so the source of truth is reviewable
 * in code. date_year null is fine — Timeline mode will hide the node
 * just like any null-date entity (orphan-Bob tier policy analogue).
 */
/**
 * first_book is canonical; date_year is approximate (none of these
 * appear in dated edges, so dates are derived from the book's known
 * in-world span: B1 ≈ 2144–2188, B2 ≈ 2170–2210, B3 ≈ ~2247, B4 ≈
 * 2210–2230, B5 ≈ 2330–2345). The values let Timeline mode reveal
 * non-spatial content in roughly the right era — exact dates would
 * need prose extraction (B4–5 fan timeline doesn't exist yet, see
 * handoff §3).
 */
const NON_SPATIAL_BOOK: Record<string, { first_book: number; date_year: number | null }> = {
	Centaurvania: { first_book: 5, date_year: 2335 },
	Roanoke: { first_book: 5, date_year: 2335 },
	'Alien System': { first_book: 5, date_year: 2330 },
	Jabberwocky: { first_book: 5, date_year: 2335 },
	Skippyland: { first_book: 5, date_year: 2345 },
	'Gamma Leporis A': { first_book: 1, date_year: 2165 },
	'Sagittarius A*': { first_book: 5, date_year: 2345 },
	"Heaven's River": { first_book: 4, date_year: 2210 },
	'Matryoshka Brain': { first_book: 4, date_year: 2225 },
	'Hub Zero': { first_book: 5, date_year: 2330 },
	'Federation Capital': { first_book: 5, date_year: 2345 }
};

/**
 * Heaven's River internal sub-locations + Jabberwocky continents,
 * per handoff D10. Rendered as a nested list inside the megastructure
 * info panel; never as top-level nodes.
 */
const HR_SUB_LOCATIONS = [
	"Garack's Spine",
	'Three Lagoons',
	'Galen Town',
	'Elbow',
	'Misty Falls',
	'Six Hills',
	'Cedar Rapids',
	'Utopia River',
	'Nirvana River System',
	'Arcadia River System',
	'Transit',
	"Halep's Ending"
];

/**
 * Real heliocentric direction toward Sagittarius A*. ICRS equatorial,
 * RA 17h 45m 40s = 266.4167°, Dec −29°00′28″ ≈ −29.0078°. Returns a
 * unit vector — caller scales to the desired radius.
 */
function sgrAStarUnit(): [number, number, number] {
	const ra = ((17 + 45 / 60 + 40 / 3600) * 15 * Math.PI) / 180;
	const dec = (-29 - 0 / 60 - 28 / 3600) * (Math.PI / 180);
	const c = Math.cos(dec);
	return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

/**
 * Deterministic placement for off-map systems with no known direction.
 * Hashes the system name into an LCG seed, draws two uniform values,
 * maps them onto a uniform sphere using the inverse-CDF for cos(theta).
 * Stable across reloads and across machines so a screenshot taken in
 * one session matches the next.
 */
function fnv1a32(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

function lcgAt(seed: number, n: number): number {
	let s = seed >>> 0;
	for (let i = 0; i <= n; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
	}
	return s / 0x100000000;
}

function sphereFromName(name: string, radius: number): [number, number, number] {
	const h = fnv1a32(name);
	const u = lcgAt(h, 0);
	const v = lcgAt(h, 1);
	const phi = 2 * Math.PI * u;
	const cosTheta = 2 * v - 1;
	const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
	return [
		radius * sinTheta * Math.cos(phi),
		radius * sinTheta * Math.sin(phi),
		radius * cosTheta
	];
}

export interface NonSpatial {
	/**
	 * Off-map placeholder nodes that the renderer treats as
	 * SpatialSystem-like (they carry an XYZ). Keyed by display name.
	 * Includes both `off_map_systems` from the gazetteer and hostless
	 * megastructures (Hub Zero, Federation Capital). The Wormhole
	 * Network entry is intentionally skipped — gazetteer flags it as
	 * an edge-set, not a node.
	 */
	offMap: Map<string, SpatialSystem>;
	/**
	 * first_book / date_year for each off-map node, keyed by name.
	 * Used by tier and Timeline gating. Same shape as the implicit
	 * derivation chains we use for spatial systems, but materialized
	 * because the gazetteer doesn't carry the data structurally.
	 */
	offMapMeta: Map<string, { first_book: number; date_year: number | null }>;
	/** Host-bound megastructures: HR @ Eta Leporis, Matryoshka @ Eps Eri. */
	megastructures: Megastructure[];
}

let cached: NonSpatial | null = null;

export function getNonSpatial(spatial: Map<string, SpatialSystem>): NonSpatial {
	if (cached) return cached;

	const offMap = new Map<string, SpatialSystem>();
	const offMapMeta = new Map<string, { first_book: number; date_year: number | null }>();

	const addRingNode = (name: string, kind: 'off_map' | 'sgr_a_star') => {
		const dir =
			kind === 'sgr_a_star'
				? sgrAStarUnit().map((v) => v * RING_RADIUS_PC)
				: sphereFromName(name, RING_RADIUS_PC);
		offMap.set(name, {
			name,
			xyz: [dir[0], dir[1], dir[2]] as [number, number, number],
			kind
		});
		const meta = NON_SPATIAL_BOOK[name];
		if (meta) offMapMeta.set(name, meta);
	};

	for (const entry of gz.off_map_systems) {
		addRingNode(entry.name, entry.name === 'Sagittarius A*' ? 'sgr_a_star' : 'off_map');
	}
	// Hostless megastructures ride the off-map ring. Wormhole Network
	// is intentionally skipped — render as edges, not a node (gazetteer).
	for (const m of gz.megastructures) {
		if (m.system != null && m.system !== m.name) continue;
		if (m.name === 'Wormhole Network') continue;
		addRingNode(m.name, 'off_map');
	}

	const megastructures: Megastructure[] = [];
	for (const m of gz.megastructures) {
		if (m.system == null || m.system === m.name) continue;
		const host = spatial.get(m.system);
		if (!host) continue; // host star not in spatial set — fall back to off-map ring (none currently)
		const subtype =
			m.type === 'topopolis' ? 'topopolis' : m.type === 'dyson_variant' ? 'dyson_variant' : null;
		if (subtype == null) continue;
		const meta = NON_SPATIAL_BOOK[m.name];
		if (!meta) continue;
		// Offset in the host's tangent plane — push along +X by default;
		// rotate by a name-hash so HR and Matryoshka don't visually overlap
		// if a future megastructure shares a host.
		const angle = (fnv1a32(m.name) >>> 0) / 0x100000000 * 2 * Math.PI;
		const dx = Math.cos(angle) * MEGASTRUCTURE_OFFSET_PC;
		const dy = Math.sin(angle) * MEGASTRUCTURE_OFFSET_PC;
		megastructures.push({
			name: m.name,
			host: m.system,
			subtype,
			first_book: meta.first_book,
			date_year: meta.date_year,
			xyz: [host.xyz[0] + dx, host.xyz[1] + dy, host.xyz[2]],
			sub_locations: m.name === "Heaven's River" ? HR_SUB_LOCATIONS : []
		});
	}

	cached = { offMap, offMapMeta, megastructures };
	return cached;
}
