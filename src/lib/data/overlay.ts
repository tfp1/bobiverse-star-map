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
	replication: ReplicationEdge[];
	travel: TravelEdge[];
	systems: Map<string, SpatialSystem>;
	/**
	 * Per-Bob, chronologically-ordered system sequence: origin_system first,
	 * then each travel edge with destination_type=='system' or 'place_in_system'
	 * (resolved to its destination_system). off_map destinations are dropped
	 * for PR2 — they'll be rendered under the non-spatial convention (#14).
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

function buildItineraries(
	bobs: Bob[],
	travel: TravelEdge[],
	systems: Map<string, SpatialSystem>
): Map<string, string[]> {
	const byBob = new Map<string, TravelEdge[]>();
	for (const t of travel) {
		if (!t.bob_known) continue;
		if (t.destination_type === 'off_map') continue;
		if (!systems.has(t.destination_system)) continue;
		const list = byBob.get(t.bob) ?? [];
		list.push(t);
		byBob.set(t.bob, list);
	}
	const itin = new Map<string, string[]>();
	for (const bob of bobs) {
		const seq: string[] = [];
		if (systems.has(bob.origin_system)) seq.push(bob.origin_system);
		const travels = byBob.get(bob.name);
		if (travels) {
			travels.sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0));
			for (const t of travels) {
				const dest = t.destination_system;
				if (seq[seq.length - 1] !== dest) seq.push(dest);
			}
		}
		if (seq.length) itin.set(bob.name, seq);
	}
	return itin;
}

let cached: Overlay | null = null;

export function getOverlay(): Overlay {
	if (cached) return cached;
	const bobs = (bobsRaw as unknown as { bobs: Bob[] }).bobs;
	const bobById = new Map(bobs.map((b) => [b.id, b]));
	const replication = (repRaw as unknown as { edges: ReplicationEdge[] }).edges;
	const travel = (travelRaw as unknown as { edges: TravelEdge[] }).edges;
	const systems = buildSystems();
	const bobItinerary = buildItineraries(bobs, travel, systems);
	cached = { bobs, bobById, replication, travel, systems, bobItinerary };
	return cached;
}
