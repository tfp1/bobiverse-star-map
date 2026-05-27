import bobsRaw from '../../../data/bobs.json';
import repRaw from '../../../data/edges_replication.json';
import travelRaw from '../../../data/edges_travel.json';
import sysRaw from '../../../data/system_to_star_index.json';
import { getNonSpatial } from './nonSpatial';
import type {
	Bob,
	Megastructure,
	ReplicationEdge,
	TravelEdge,
	SystemRef,
	SpatialSystem
} from './types';

export interface Overlay {
	bobs: Bob[];
	bobById: Map<string, Bob>;
	/**
	 * Resolves a Bob display name to the primary record. `data/bobs.json`
	 * has name collisions (Elmer/Elmer_v4 etc.) where the "_vN" record is a
	 * restored-from-backup variant; replication and travel rows reference
	 * the original character by name, so we always attach to the
	 * non-versioned record when both exist.
	 */
	bobByName: (name: string) => Bob | undefined;
	replication: ReplicationEdge[];
	travel: TravelEdge[];
	/** Spatial (catalog-star) systems keyed by name. Sol included at origin. */
	systems: Map<string, SpatialSystem>;
	/**
	 * Off-map placeholder systems (handoff D6/D7). Includes
	 * gazetteer off_map_systems + Sgr A* + hostless megastructures
	 * (Hub Zero, Federation Capital). Carry an XYZ on the ~120 pc
	 * ring sphere so travel edges can land on them.
	 */
	offMap: Map<string, SpatialSystem>;
	/** first_book + date_year for each off-map node. */
	offMapMeta: Map<string, { first_book: number; date_year: number | null }>;
	/** Host-bound megastructures (handoff D9): HR @ Eta Leporis etc. */
	megastructures: Megastructure[];
	/**
	 * Unified name → SpatialSystem lookup across both `systems` and
	 * `offMap`. Use this when resolving a travel edge's destination.
	 */
	resolveSystem: (name: string) => SpatialSystem | undefined;
	/**
	 * Per-Bob (keyed by id), chronologically-ordered system sequence:
	 * origin_system first, then each travel edge with a resolvable
	 * destination (catalog star OR off-map ring marker). Wormhole-
	 * specific path rendering is the renderer's call (handoff D8) —
	 * the itinerary is shape-agnostic.
	 */
	bobItinerary: Map<string, string[]>;
}

function buildSystems(): Map<string, SpatialSystem> {
	const out = new Map<string, SpatialSystem>();
	// The on-disk JSON types Position arrays as number[]; runtime-check the
	// length and cast through unknown at this JSON boundary.
	const systems = (sysRaw as unknown as { systems: Record<string, SystemRef> }).systems;
	for (const [name, rec] of Object.entries(systems)) {
		if (rec.type !== 'catalog_star') continue;
		if (name === 'Sol') {
			out.set(name, { name, xyz: [0, 0, 0], kind: 'catalog_star' });
			continue;
		}
		const xyz = rec.bin_xyz_pc ?? rec.ref_xyz_pc;
		if (!xyz || xyz.length !== 3) continue;
		out.set(name, { name, xyz: [xyz[0], xyz[1], xyz[2]], kind: 'catalog_star' });
	}
	return out;
}

/**
 * Build a display-name → primary-record map. `data/bobs.json` has
 * collisions (Elmer/Elmer_v4, Loki/Loki_v4, ???/???) where the "_vN"
 * record is a restored-from-backup variant of the same character.
 * Edge rows reference the original by name; always attach to the
 * non-versioned record when both exist.
 */
function buildNameToPrimary(bobs: Bob[]): Map<string, Bob> {
	const byName = new Map<string, Bob[]>();
	for (const b of bobs) {
		const list = byName.get(b.name) ?? [];
		list.push(b);
		byName.set(b.name, list);
	}
	const out = new Map<string, Bob>();
	for (const [name, records] of byName) {
		const primary = records.find((r) => !/_v\d+$/.test(r.id)) ?? records[0];
		out.set(name, primary);
	}
	return out;
}

function buildItineraries(
	bobs: Bob[],
	travel: TravelEdge[],
	resolveSystem: (name: string) => SpatialSystem | undefined,
	nameToPrimary: Map<string, Bob>
): Map<string, string[]> {
	const byId = new Map<string, TravelEdge[]>();
	for (const t of travel) {
		if (!t.bob_known) continue;
		const destName = travelDestinationName(t);
		if (destName == null) continue;
		if (!resolveSystem(destName)) continue;
		const primary = nameToPrimary.get(t.bob);
		if (!primary) continue;
		const list = byId.get(primary.id) ?? [];
		list.push(t);
		byId.set(primary.id, list);
	}
	const itin = new Map<string, string[]>();
	for (const bob of bobs) {
		const seq: string[] = [];
		if (resolveSystem(bob.origin_system)) seq.push(bob.origin_system);
		const travels = byId.get(bob.id);
		if (travels) {
			travels.sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0));
			for (const t of travels) {
				const dest = travelDestinationName(t);
				if (dest != null && seq[seq.length - 1] !== dest) seq.push(dest);
			}
		}
		if (seq.length > 1) itin.set(bob.id, seq);
	}
	return itin;
}

/**
 * Canonical destination name for a travel edge — destination_system
 * if the resolver bound it to a catalog star, otherwise destination_raw
 * for off_map rows (which carry the off-map system name on the ring
 * sphere). Returns null when neither is usable.
 */
export function travelDestinationName(t: TravelEdge): string | null {
	if (t.destination_system) return t.destination_system;
	if (t.destination_type === 'off_map' && t.destination_raw) return t.destination_raw;
	return null;
}

let cached: Overlay | null = null;

export function getOverlay(): Overlay {
	if (cached) return cached;
	const bobs = (bobsRaw as unknown as { bobs: Bob[] }).bobs;
	const bobById = new Map(bobs.map((b) => [b.id, b]));
	const nameToPrimary = buildNameToPrimary(bobs);
	const replication = (repRaw as unknown as { edges: ReplicationEdge[] }).edges;
	const travel = (travelRaw as unknown as { edges: TravelEdge[] }).edges;
	const systems = buildSystems();
	const { offMap, offMapMeta, megastructures } = getNonSpatial(systems);
	const resolveSystem = (name: string): SpatialSystem | undefined =>
		systems.get(name) ?? offMap.get(name);
	const bobItinerary = buildItineraries(bobs, travel, resolveSystem, nameToPrimary);
	cached = {
		bobs,
		bobById,
		bobByName: (name) => nameToPrimary.get(name),
		replication,
		travel,
		systems,
		offMap,
		offMapMeta,
		megastructures,
		resolveSystem,
		bobItinerary
	};
	return cached;
}
