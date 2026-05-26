import type { Overlay } from './overlay';
import type { Bob } from './types';

export const MAX_TIER = 5;

/**
 * Precomputed visibility state for one tier value. Built once per tier
 * change and passed to the overlay renderers so each one doesn't
 * re-walk the overlay.
 */
export interface TierView {
	tier: number;
	visibleSystems: Set<string>;
	bobVisible: (bobName: string) => boolean;
}

export function buildTierView(overlay: Overlay, tier: number): TierView {
	const visibleSystems = systemsVisibleAt(overlay, tier);
	// Memoize firstBookOf — replication is small but called per-Bob per build.
	const fbCache = new Map<string, number | null>();
	const fbOf = (name: string): number | null => {
		if (fbCache.has(name)) return fbCache.get(name)!;
		const v = firstBookOf(overlay, name);
		fbCache.set(name, v);
		return v;
	};
	return {
		tier,
		visibleSystems,
		bobVisible(bobName: string) {
			const fb = fbOf(bobName);
			if (fb == null) return tier >= MAX_TIER;
			return fb <= tier;
		}
	};
}

/**
 * `data/bobs.json` does not carry first_book directly. Derive it from
 * the earliest replication edge that names the Bob as parent or child.
 * Returns null if the Bob doesn't appear in any replication edge
 * (e.g. unnamed_row42, wiki-only stubs).
 */
export function firstBookOf(overlay: Overlay, bobName: string): number | null {
	let min: number | null = null;
	for (const edge of overlay.replication) {
		if (edge.parent !== bobName && edge.child !== bobName) continue;
		if (edge.first_book == null) continue;
		if (min == null || edge.first_book < min) min = edge.first_book;
	}
	return min;
}

/**
 * Is this Bob visible at `tier`? A Bob with no replication-edge appearance
 * (firstBookOf returns null) is treated as MAX_TIER-only: it's likely a
 * late-discovered stub (Hugh/Lenny/Mud) whose first book is genuinely
 * unknown, so hide until the all-spoilers tier.
 */
export function bobVisibleAt(overlay: Overlay, bob: Bob, tier: number): boolean {
	const fb = firstBookOf(overlay, bob.name);
	if (fb == null) return tier >= MAX_TIER;
	return fb <= tier;
}

/**
 * Set of system names that have ANY visible content (Bob with origin
 * there, or replication/travel edge endpoint there) at the given tier.
 * Sol is always included as the spatial origin so the camera anchor
 * stays meaningful even at tier 1.
 */
export function systemsVisibleAt(overlay: Overlay, tier: number): Set<string> {
	const out = new Set<string>();
	out.add('Sol');
	for (const bob of overlay.bobs) {
		if (!overlay.systems.has(bob.origin_system)) continue;
		if (bobVisibleAt(overlay, bob, tier)) out.add(bob.origin_system);
	}
	for (const e of overlay.replication) {
		if (e.first_book == null || e.first_book > tier) continue;
		if (!e.parent_known || !e.child_known) continue;
		const p = overlay.bobByName(e.parent);
		const c = overlay.bobByName(e.child);
		if (p && overlay.systems.has(p.origin_system)) out.add(p.origin_system);
		if (c && overlay.systems.has(c.origin_system)) out.add(c.origin_system);
	}
	for (const t of overlay.travel) {
		if (t.first_book == null || t.first_book > tier) continue;
		if (t.destination_type === 'off_map') continue;
		if (overlay.systems.has(t.destination_system)) out.add(t.destination_system);
		const bob = overlay.bobByName(t.bob);
		if (bob && overlay.systems.has(bob.origin_system)) out.add(bob.origin_system);
	}
	return out;
}

/**
 * Bobs whose origin_system is `systemName`. When `tier` is provided,
 * residents are gated the same way the scene gates Bob pips — orphan
 * Bobs (firstBookOf = null) only appear at tier 5.
 */
export function bobsAt(overlay: Overlay, systemName: string, tier?: number): Bob[] {
	const all = overlay.bobs.filter((b) => b.origin_system === systemName);
	if (tier == null) return all;
	return all.filter((b) => {
		const fb = firstBookOf(overlay, b.name);
		if (fb == null) return tier >= MAX_TIER;
		return fb <= tier;
	});
}

/**
 * Count of travel edges arriving at or leaving from `systemName`.
 * When `tier` is provided, both arrival and departure counts are
 * restricted to edges with `first_book <= tier`.
 */
export function travelCountsAt(
	overlay: Overlay,
	systemName: string,
	tier?: number
): { arrivals: number; departures: number } {
	let arrivals = 0;
	let departures = 0;
	for (const t of overlay.travel) {
		if (tier != null && (t.first_book == null || t.first_book > tier)) continue;
		if (t.destination_system === systemName) arrivals++;
	}
	if (tier == null) {
		for (const seq of overlay.bobItinerary.values()) {
			for (let i = 0; i + 1 < seq.length; i++) {
				if (seq[i] === systemName) departures++;
			}
		}
		return { arrivals, departures };
	}
	// Tier-restricted departures: a departure is a travel edge whose
	// per-Bob predecessor stop (origin_system, or the previous in-tier
	// destination) equals `systemName`. Mirrors the itinerary logic
	// used by TravelEdges.buildItinerariesAtTier so the panel agrees
	// with the rendered lines.
	const byBobId = new Map<string, typeof overlay.travel>();
	for (const t of overlay.travel) {
		if (!t.bob_known) continue;
		if (t.destination_type === 'off_map') continue;
		if (!overlay.systems.has(t.destination_system)) continue;
		if (t.first_book == null || t.first_book > tier) continue;
		const primary = overlay.bobByName(t.bob);
		if (!primary) continue;
		const list = byBobId.get(primary.id) ?? [];
		list.push(t);
		byBobId.set(primary.id, list);
	}
	for (const bob of overlay.bobs) {
		const travels = byBobId.get(bob.id);
		if (!travels) continue;
		travels.sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0));
		let prev = overlay.systems.has(bob.origin_system) ? bob.origin_system : null;
		for (const t of travels) {
			if (prev === systemName && t.destination_system !== systemName) departures++;
			if (prev !== t.destination_system) prev = t.destination_system;
		}
	}
	return { arrivals, departures };
}
