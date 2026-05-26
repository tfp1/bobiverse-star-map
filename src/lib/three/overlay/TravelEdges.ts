import * as THREE from 'three';
import type { Overlay } from '$lib/data/overlay';

/**
 * Travel edges: per-Bob, the chronologically-ordered chain of system
 * positions the Bob visits. Drawn as connected line segments rather
 * than parent→child arcs because travel is an itinerary, not a tree.
 *
 * Off-map and unresolved destinations are dropped upstream in
 * buildItineraries — they need the non-spatial render decision
 * (#14) before they can be drawn.
 */
export interface TravelEdgesResult {
	object: THREE.LineSegments;
	dispose: () => void;
	stats: { drawn: number };
}

export function makeTravelEdges(overlay: Overlay): TravelEdgesResult {
	const positions: number[] = [];
	let drawn = 0;

	for (const seq of overlay.bobItinerary.values()) {
		for (let i = 0; i + 1 < seq.length; i++) {
			const a = overlay.systems.get(seq[i]);
			const b = overlay.systems.get(seq[i + 1]);
			if (!a || !b) continue;
			positions.push(a.xyz[0], a.xyz[1], a.xyz[2], b.xyz[0], b.xyz[1], b.xyz[2]);
			drawn++;
		}
	}

	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	const mat = new THREE.LineBasicMaterial({
		color: 0xffb15c,
		transparent: true,
		opacity: 0.7,
		depthWrite: false
	});
	const object = new THREE.LineSegments(geom, mat);

	return {
		object,
		stats: { drawn },
		dispose() {
			geom.dispose();
			mat.dispose();
		}
	};
}
