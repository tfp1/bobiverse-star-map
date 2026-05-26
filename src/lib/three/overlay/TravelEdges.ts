import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Overlay } from '$lib/data/overlay';

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

export function makeTravelEdges(
	overlay: Overlay,
	resolution: THREE.Vector2
): TravelEdgesResult {
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
