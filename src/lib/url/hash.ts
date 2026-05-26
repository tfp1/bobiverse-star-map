/**
 * Tiny `window.location.hash` serializer for shareable view state.
 * Format: `#book=N` (single param for now; new keys will follow the
 * same `&`-separated `k=v` pattern). Returns sane defaults on a
 * missing/garbled hash rather than throwing — a corrupt URL should
 * fall back to the app's default state, not break the page.
 */
import { MAX_TIER } from '$lib/data/derive';

export interface HashState {
	tier: number;
}

export function parseHash(hash: string, defaults: HashState): HashState {
	const raw = hash.startsWith('#') ? hash.slice(1) : hash;
	if (!raw) return { ...defaults };
	const out: HashState = { ...defaults };
	for (const part of raw.split('&')) {
		const eq = part.indexOf('=');
		if (eq < 0) continue;
		const k = part.slice(0, eq);
		const v = part.slice(eq + 1);
		if (k === 'book') {
			const n = Number(v);
			if (Number.isInteger(n) && n >= 1 && n <= MAX_TIER) out.tier = n;
		}
	}
	return out;
}

export function writeHash(state: HashState): string {
	return `#book=${state.tier}`;
}
