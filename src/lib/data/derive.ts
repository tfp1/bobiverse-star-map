import type { Overlay } from './overlay';
import type { Bob } from './types';

export const MAX_TIER = 5;

/**
 * Precomputed visibility state for one (tier, yearMax) pair. Built once
 * per filter change and passed to the overlay renderers so each one
 * doesn't re-walk the overlay.
 *
 * `yearMax` null means "no time gating" (Explore mode). When set
 * (Timeline mode), entities with a null in-world date are hidden —
 * they can't be placed on a chronological axis, so a chronological
 * filter has nothing to compare them against.
 */
export interface TierView {
	tier: number;
	yearMax: number | null;
	visibleSystems: Set<string>;
	/**
	 * Name-keyed visibility — for edge rows (replication/travel) that
	 * reference Bobs only by display name and have no record id.
	 * Resolves through bobByName, so backup-variant ids (Elmer_v4 etc.)
	 * collapse to the primary's anchors. DO NOT call from per-record
	 * code paths (BobNodes, system-residents); use bobVisibleRec.
	 */
	bobVisible: (bobName: string) => boolean;
	/**
	 * Record-keyed visibility — for code paths that iterate
	 * `overlay.bobs` directly and can disambiguate Elmer from
	 * Elmer_v4. Variant records contribute only their own dates and
	 * are excluded from the firstBookOf/firstDateOf edge fallback
	 * (edges aren't attributed to a specific restore-variant), so a
	 * dateless _vN record stays hidden in Timeline mode and at
	 * sub-MAX tiers — matching the "backup restore is a late reveal"
	 * intent.
	 */
	bobVisibleRec: (bob: Bob) => boolean;
	/**
	 * True when the in-world year for an entity should be considered
	 * visible at the current yearMax. Null is hidden under any active
	 * time gate and always visible when no gate is set.
	 */
	dateVisible: (year: number | null) => boolean;
}

/**
 * Backup-restore variant: data/bobs.json carries restored-from-backup
 * variants as `<Name>_v<N>` rows that share a display name with the
 * primary record. Used to decide whether to apply the edge-derived
 * book/date fallbacks (which are name-keyed and would otherwise
 * pull the primary's anchors into the variant).
 */
function isVariantId(id: string): boolean {
	return /_v\d+$/.test(id);
}

export function buildTierView(
	overlay: Overlay,
	tier: number,
	yearMax: number | null = null
): TierView {
	const fbCache = new Map<string, number | null>();
	const fbOf = (name: string): number | null => {
		if (fbCache.has(name)) return fbCache.get(name)!;
		const v = firstBookOf(overlay, name);
		fbCache.set(name, v);
		return v;
	};
	const fdCache = new Map<string, number | null>();
	const fdOf = (name: string): number | null => {
		if (fdCache.has(name)) return fdCache.get(name)!;
		const v = firstDateOf(overlay, name);
		fdCache.set(name, v);
		return v;
	};
	const dateVisible = (year: number | null): boolean => {
		if (yearMax == null) return true;
		return year != null && year <= yearMax;
	};
	const bobVisible = (bobName: string): boolean => {
		const fb = fbOf(bobName);
		const tierOk = fb == null ? tier >= MAX_TIER : fb <= tier;
		if (!tierOk) return false;
		if (yearMax == null) return true;
		return dateVisible(fdOf(bobName));
	};
	const bobVisibleRec = (bob: Bob): boolean => bobVisibleAt(overlay, bob, tier, yearMax);
	const visibleSystems = systemsVisibleAt(overlay, tier, yearMax);
	return {
		tier,
		yearMax,
		visibleSystems,
		bobVisible,
		bobVisibleRec,
		dateVisible
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
 * Earliest in-world year a Bob can be placed on the timeline. Falls
 * back through bobs.json (online_year, then created_year) to the
 * earliest replication edge that names the Bob as parent or child,
 * then the earliest travel edge by the Bob. Returns null only when
 * NONE of those carry a date — those Bobs cannot be placed in
 * Timeline mode and are hidden whenever yearMax is set.
 *
 * Name-keyed. Resolves bobByName for the bobs.json fallback, which
 * collapses backup-variant ids (Elmer_v4) onto the primary record.
 * Per-record callers should go through bobVisibleAt / TierView's
 * bobVisibleRec, which skips the edge fallback for variants.
 */
export function firstDateOf(overlay: Overlay, bobName: string): number | null {
	const bob = overlay.bobByName(bobName);
	let min: number | null = null;
	const consider = (y: number | null | undefined) => {
		if (y == null) return;
		if (min == null || y < min) min = y;
	};
	if (bob) {
		consider(bob.online_year);
		consider(bob.created_year);
	}
	for (const e of overlay.replication) {
		if (e.parent !== bobName && e.child !== bobName) continue;
		consider(e.date_year);
	}
	for (const t of overlay.travel) {
		if (t.bob !== bobName) continue;
		consider(t.date_year);
	}
	return min;
}

/**
 * Is this specific Bob record visible at `tier` (and optionally at
 * `yearMax`)? Per-record (id-aware): backup-variant rows (Elmer_v4
 * etc.) do NOT inherit the primary's edge-derived anchors, because
 * edges aren't attributed to a specific restore-variant. A variant
 * with no own dates is effectively an orphan stub — visible only
 * at tier 5 and hidden whenever yearMax is set.
 *
 * For primary records: a Bob with no replication-edge appearance is
 * treated as MAX_TIER-only (Hugh/Lenny/Mud). Under yearMax, a Bob
 * whose firstDateOf returns null is hidden (no chronological anchor).
 */
export function bobVisibleAt(
	overlay: Overlay,
	bob: Bob,
	tier: number,
	yearMax: number | null = null
): boolean {
	const variant = isVariantId(bob.id);
	const fb = variant ? null : firstBookOf(overlay, bob.name);
	const tierOk = fb == null ? tier >= MAX_TIER : fb <= tier;
	if (!tierOk) return false;
	if (yearMax == null) return true;
	let fd: number | null;
	if (variant) {
		// Only this record's own dates count; no edge fallback.
		fd = bob.online_year ?? bob.created_year ?? null;
	} else {
		fd = firstDateOf(overlay, bob.name);
	}
	return fd != null && fd <= yearMax;
}

/**
 * Set of system names that have ANY visible content (Bob with origin
 * there, or replication/travel edge endpoint there) at the given
 * tier and yearMax. Sol is always included as the spatial origin so
 * the camera anchor stays meaningful even at tier 1 / year 2133.
 */
export function systemsVisibleAt(
	overlay: Overlay,
	tier: number,
	yearMax: number | null = null
): Set<string> {
	const out = new Set<string>();
	out.add('Sol');
	const dateOk = (y: number | null): boolean =>
		yearMax == null ? true : y != null && y <= yearMax;
	for (const bob of overlay.bobs) {
		if (!overlay.systems.has(bob.origin_system)) continue;
		if (bobVisibleAt(overlay, bob, tier, yearMax)) out.add(bob.origin_system);
	}
	for (const e of overlay.replication) {
		if (e.first_book == null || e.first_book > tier) continue;
		if (!dateOk(e.date_year)) continue;
		if (!e.parent_known || !e.child_known) continue;
		const p = overlay.bobByName(e.parent);
		const c = overlay.bobByName(e.child);
		if (p && overlay.systems.has(p.origin_system)) out.add(p.origin_system);
		if (c && overlay.systems.has(c.origin_system)) out.add(c.origin_system);
	}
	for (const t of overlay.travel) {
		if (t.first_book == null || t.first_book > tier) continue;
		if (!dateOk(t.date_year)) continue;
		if (t.destination_type === 'off_map') continue;
		if (!t.bob_known) continue;
		// Match TravelEdges.buildItinerariesAtTier: a travel row only
		// contributes to the visible scene when its primary Bob is
		// itself visible at this tier/yearMax. Without this gate,
		// orphan-tier Bobs (firstBookOf null, MAX_TIER-only) like
		// Claude — whose only mention is a B2 travel to Gamma
		// Pavonis — would light up destination markers at tiers
		// 2–4 with no pip or edge actually drawn there.
		const bob = overlay.bobByName(t.bob);
		if (!bob) continue;
		if (!bobVisibleAt(overlay, bob, tier, yearMax)) continue;
		if (overlay.systems.has(t.destination_system)) out.add(t.destination_system);
		if (overlay.systems.has(bob.origin_system)) out.add(bob.origin_system);
	}
	return out;
}

/**
 * Bobs whose origin_system is `systemName`. When `tier` is provided,
 * residents are gated the same way the scene gates Bob pips — orphan
 * Bobs (firstBookOf = null) only appear at tier 5. When `yearMax` is
 * also provided, Bobs with no date anchor are dropped.
 */
export function bobsAt(
	overlay: Overlay,
	systemName: string,
	tier?: number,
	yearMax: number | null = null
): Bob[] {
	const all = overlay.bobs.filter((b) => b.origin_system === systemName);
	if (tier == null) return all;
	return all.filter((b) => bobVisibleAt(overlay, b, tier, yearMax));
}

/**
 * Count of travel edges arriving at or leaving from `systemName`.
 * When `tier` is provided, both arrival and departure counts are
 * restricted to edges with `first_book <= tier`. When `yearMax`
 * is also provided, edges with date_year > yearMax (or null) are
 * dropped, matching the rendered TravelEdges set.
 */
export function travelCountsAt(
	overlay: Overlay,
	systemName: string,
	tier?: number,
	yearMax: number | null = null
): { arrivals: number; departures: number } {
	let arrivals = 0;
	let departures = 0;
	if (tier == null) {
		for (const t of overlay.travel) {
			if (t.destination_system === systemName) arrivals++;
		}
		for (const seq of overlay.bobItinerary.values()) {
			for (let i = 0; i + 1 < seq.length; i++) {
				if (seq[i] === systemName) departures++;
			}
		}
		return { arrivals, departures };
	}
	// Tier-restricted path. Both arrivals and departures must mirror
	// the same filters TravelEdges.buildItinerariesAtTier applies, so
	// the panel counts agree with the rendered travel lines:
	//   - edge.first_book <= tier
	//   - edge.date_year <= yearMax (when yearMax is set)
	//   - destination resolves to a known system (off_map dropped)
	//   - bob_known and primary Bob resolves
	//   - primary Bob is visible at this tier (covers Hal at GL877
	//     who is firstBookOf=null and thus hidden until tier 5)
	const view = buildTierView(overlay, tier, yearMax);
	const byBobId = new Map<string, typeof overlay.travel>();
	for (const t of overlay.travel) {
		if (!t.bob_known) continue;
		if (t.destination_type === 'off_map') continue;
		if (!overlay.systems.has(t.destination_system)) continue;
		if (t.first_book == null || t.first_book > tier) continue;
		if (!view.dateVisible(t.date_year)) continue;
		const primary = overlay.bobByName(t.bob);
		if (!primary) continue;
		if (!view.bobVisible(primary.name)) continue;
		if (t.destination_system === systemName) arrivals++;
		const list = byBobId.get(primary.id) ?? [];
		list.push(t);
		byBobId.set(primary.id, list);
	}
	for (const bob of overlay.bobs) {
		if (!view.bobVisible(bob.name)) continue;
		const travels = byBobId.get(bob.id);
		if (!travels) continue;
		travels.sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0));
		let prev = overlay.systems.has(bob.origin_system) ? bob.origin_system : null;
		for (const t of travels) {
			if (prev === systemName && t.destination_system !== systemName) departures++;
			prev = t.destination_system;
		}
	}
	return { arrivals, departures };
}
