import bobsRaw from '../../../data/bobs.json';
import repRaw from '../../../data/edges_replication.json';
import travelRaw from '../../../data/edges_travel.json';
import sysRaw from '../../../data/system_to_star_index.json';
import type {
	Bob,
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
	systems: Map<string, SpatialSystem>;
	/**
	 * Per-Bob (keyed by id), chronologically-ordered system sequence:
	 * origin_system first, then each travel edge with destination_type
	 * 'system' or 'place_in_system' resolved to its destination_system.
	 * off_map destinations are dropped for PR2 — they'll be rendered
	 * under the non-spatial convention (#14).
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
			out.set(name, { name, xyz: [0, 0, 0] });
			continue;
		}
		const xyz = rec.bin_xyz_pc ?? rec.ref_xyz_pc;
		if (!xyz || xyz.length !== 3) continue;
		out.set(name, { name, xyz: [xyz[0], xyz[1], xyz[2]] });
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
	systems: Map<string, SpatialSystem>,
	nameToPrimary: Map<string, Bob>
): Map<string, string[]> {
	const byId = new Map<string, TravelEdge[]>();
	for (const t of travel) {
		if (!t.bob_known) continue;
		if (t.destination_type === 'off_map') continue;
		if (!systems.has(t.destination_system)) continue;
		const primary = nameToPrimary.get(t.bob);
		if (!primary) continue;
		const list = byId.get(primary.id) ?? [];
		list.push(t);
		byId.set(primary.id, list);
	}
	const itin = new Map<string, string[]>();
	for (const bob of bobs) {
		const seq: string[] = [];
		if (systems.has(bob.origin_system)) seq.push(bob.origin_system);
		const travels = byId.get(bob.id);
		if (travels) {
			travels.sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0));
			for (const t of travels) {
				const dest = t.destination_system;
				if (seq[seq.length - 1] !== dest) seq.push(dest);
			}
		}
		if (seq.length > 1) itin.set(bob.id, seq);
	}
	return itin;
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
	const bobItinerary = buildItineraries(bobs, travel, systems, nameToPrimary);
	cached = {
		bobs,
		bobById,
		bobByName: (name) => nameToPrimary.get(name),
		replication,
		travel,
		systems,
		bobItinerary
	};
	return cached;
}
