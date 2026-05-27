import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Overlay } from '$lib/data/overlay';
import { travelDestinationName } from '$lib/data/overlay';
import type { TierView } from '$lib/data/derive';

/**
 * Travel edges: per-Bob, the chronologically-ordered chain of system
 * positions the Bob visits. Drawn as line segments between adjacent
 * itinerary stops rather than parent→child arcs because travel is a
 * sequence, not a tree.
 *
 * Off-map and unresolved destinations are dropped upstream in
 * buildItineraries — they need the non-spatial render decision
 * (#14) before they can be drawn.
 */
export interface TravelEdgesResult {
	object: LineSegments2;
	setResolution: (w: number, h: number) => void;
	dispose: () => void;
	stats: { drawn: number };
}

/**
 * Recompute per-Bob itineraries restricted to travel edges with
 * `first_book <= view.tier`. Mirrors overlay.buildItineraries but
 * adds the tier gate; the unfiltered version remains cached on the
 * overlay for the no-tier path.
 */
function buildItinerariesAtTier(overlay: Overlay, view: TierView): string[][] {
	const byBobId = new Map<string, typeof overlay.travel>();
	for (const t of overlay.travel) {
		if (!t.bob_known) continue;
		const destName = travelDestinationName(t);
		if (destName == null) continue;
		if (!overlay.resolveSystem(destName)) continue;
		if (t.first_book == null || t.first_book > view.tier) continue;
		if (!view.dateVisible(t.date_year)) continue;
		const primary = overlay.bobByName(t.bob);
		if (!primary) continue;
		if (!view.bobVisible(primary.name)) continue;
		const list = byBobId.get(primary.id) ?? [];
		list.push(t);
		byBobId.set(primary.id, list);
	}
	const out: string[][] = [];
	for (const bob of overlay.bobs) {
		if (!view.bobVisible(bob.name)) continue;
		const travels = byBobId.get(bob.id);
		if (!travels) continue;
		const seq: string[] = [];
		if (overlay.resolveSystem(bob.origin_system)) seq.push(bob.origin_system);
		travels.sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0));
		for (const t of travels) {
			const dest = travelDestinationName(t);
			if (dest != null && seq[seq.length - 1] !== dest) seq.push(dest);
		}
		if (seq.length > 1) out.push(seq);
	}
	return out;
}

export function makeTravelEdges(
	overlay: Overlay,
	resolution: THREE.Vector2,
	view?: TierView
): TravelEdgesResult {
	const positions: number[] = [];
	let drawn = 0;

	const sequences: string[][] = view ? buildItinerariesAtTier(overlay, view) : [...overlay.bobItinerary.values()];

	for (const seq of sequences) {
		for (let i = 0; i + 1 < seq.length; i++) {
			const a = overlay.resolveSystem(seq[i]);
			const b = overlay.resolveSystem(seq[i + 1]);
			if (!a || !b) continue;
			positions.push(a.xyz[0], a.xyz[1], a.xyz[2], b.xyz[0], b.xyz[1], b.xyz[2]);
			drawn++;
		}
	}

	const geom = new LineSegmentsGeometry();
	geom.setPositions(positions);
	const mat = new LineMaterial({
		color: 0xffb15c,
		linewidth: 1.5,
		transparent: true,
		opacity: 0.95,
		depthTest: false,
		resolution
	});
	const object = new LineSegments2(geom, mat);
	object.renderOrder = 2; // above replication so travel reads as the "active" path
	object.computeLineDistances();

	return {
		object,
		stats: { drawn },
		setResolution(w: number, h: number) {
			mat.resolution.set(w, h);
		},
		dispose() {
			geom.dispose();
			mat.dispose();
		}
	};
}
