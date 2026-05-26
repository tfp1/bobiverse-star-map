import type { Overlay } from './overlay';
import type { Bob } from './types';

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

/** Bobs whose origin_system is `systemName`. */
export function bobsAt(overlay: Overlay, systemName: string): Bob[] {
	return overlay.bobs.filter((b) => b.origin_system === systemName);
}

/** Count of travel edges arriving at or leaving from `systemName`. */
export function travelCountsAt(
	overlay: Overlay,
	systemName: string
): { arrivals: number; departures: number } {
	let arrivals = 0;
	let departures = 0;
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
