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
	/**
	 * Resolved spatial-system name when destination_type is 'system'
	 * or 'place_in_system'; null for off_map rows where the resolver
	 * couldn't bind to a local-bubble star (destination_raw still
	 * carries the off-map system name — Gamma Leporis A, Skippyland).
	 */
	destination_system: string | null;
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
 * (at the origin) even though it has no bin record. Off-map "ring
 * sphere" placeholders (per handoff D6/D7) implement the same
 * interface — they carry an XYZ so travel edges can land on them —
 * and a `kind` discriminator so renderers can style them differently.
 */
export interface SpatialSystem {
	name: string;
	xyz: [number, number, number];
	kind?: 'catalog_star' | 'off_map' | 'sgr_a_star';
}

/**
 * Host-bound megastructure node (handoff D9). Lives next to its host
 * star at a small offset and renders with a distinctive icon. The
 * `host` field points at a SpatialSystem name. `subtype` chooses the
 * renderer icon (topopolis = thin torus, dyson_variant = lattice).
 */
export interface Megastructure {
	name: string;
	host: string;
	subtype: 'topopolis' | 'dyson_variant';
	first_book: number;
	date_year: number | null;
	xyz: [number, number, number];
	/** Sub-locations nested under this megastructure in InfoPanel (D10). */
	sub_locations: string[];
}
