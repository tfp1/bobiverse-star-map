/**
 * Tiny `window.location.hash` serializer for shareable view state.
 * Format: `&`-separated `k=v` pairs.
 *   book=N        spoiler tier (1..MAX_TIER)
 *   mode=M        explore (default) | timeline
 *   year=YYYY     scrubber position, only emitted in timeline mode
 *
 * Returns sane defaults on a missing/garbled hash rather than
 * throwing — a corrupt URL should fall back to the app's default
 * state, not break the page.
 */
import { MAX_TIER } from '$lib/data/derive';

export type ViewMode = 'explore' | 'timeline';

export const YEAR_MIN = 2133;
export const YEAR_MAX = 2345;

export interface HashState {
	tier: number;
	mode: ViewMode;
	year: number;
}

export function parseHash(hash: string, defaults: HashState): HashState {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash;
	const out: HashState = { ...defaults };
	if (!raw) return out;
	for (const part of raw.split('&')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq);
		const v = part.slice(eq + 1);
		if (k === 'book') {
			const n = Number(v);
			if (Number.isInteger(n) && n >= 1 && n <= MAX_TIER) out.tier = n;
		} else if (k === 'mode') {
			if (v === 'timeline' || v === 'explore') out.mode = v;
		} else if (k === 'year') {
			const n = Number(v);
			if (Number.isInteger(n) && n >= YEAR_MIN && n <= YEAR_MAX) out.year = n;
		}
	}
	return out;
}

export function writeHash(state: HashState): string {
	const parts = [`book=${state.tier}`];
	if (state.mode === 'timeline') {
		parts.push(`mode=timeline`);
		parts.push(`year=${state.year}`);
	}
	return `#${parts.join('&')}`;
}
