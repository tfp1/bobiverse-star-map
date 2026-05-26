// Shape of the data files at repo /data/. These are the parts the
// overlay graph actually consumes; many other fields exist on disk
// (provenance, source_text, etc.) and are ignored here.

export interface Bob {
	id: string;
	name: string;
	bob_number: number;
	generation: number;
	parent_id: string | null;
	origin_system: string;
	destinations: string[];
	created_year: number | null;
	online_year: number | null;
	deceased_year: number | null;
}

export interface ReplicationEdge {
	parent: string;
	child: string;
	in_world_date: string | null;
	date_year: number | null;
	chapter_code: string | null;
	reading_order: number | null;
	first_book: number | null;
	pattern: string;
	confidence: string;
	parent_known: boolean;
	child_known: boolean;
}

export type TravelDestType = 'system' | 'place_in_system' | 'off_map';

export interface TravelEdge {
	bob: string;
	verb: string;
	destination_raw: string;
	destination_system: string;
	destination_type: TravelDestType;
	in_world_date: string | null;
	date_year: number | null;
	chapter_code: string | null;
	reading_order: number | null;
	first_book: number | null;
	pattern: string;
	confidence: string;
	bob_known: boolean;
}

export type SystemType = 'catalog_star' | 'non_physical';

export interface SystemRef {
	type: SystemType;
	ref_xyz_pc?: [number, number, number];
	bin_xyz_pc?: [number, number, number];
	index?: number | null;
	ref_spt?: string;
	ref_v_mag?: number;
}

/**
 * A system that resolves to a real spatial position. Sol is included
 * (at the origin) even though it has no bin record.
 */
export interface SpatialSystem {
	name: string;
	xyz: [number, number, number];
}
