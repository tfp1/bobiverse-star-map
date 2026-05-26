import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Overlay } from '$lib/data/overlay';

/**
 * Replication edges: parent Bob → child Bob, drawn between the two
 * Bobs' origin_system positions. Same-system replications collapse to
 * a single point and are dropped (more naturally a per-system pip,
 * which lands with the info-panel PR). Endpoints that don't resolve
 * to a known spatial system are also dropped — they'll come back
 * with the non-spatial render decision (#14).
 *
 * Rendered with Line2 / LineMaterial so linewidth in pixels is
 * actually respected (LineBasicMaterial.linewidth is ignored on
 * essentially every WebGL implementation).
 */
export interface ReplicationEdgesResult {
	object: LineSegments2;
	setResolution: (w: number, h: number) => void;
	dispose: () => void;
	stats: { drawn: number; dropped: number };
}

export function makeReplicationEdges(
	overlay: Overlay,
	resolution: THREE.Vector2
): ReplicationEdgesResult {
	const positions: number[] = [];
	let drawn = 0;
	let dropped = 0;

	for (const edge of overlay.replication) {
		if (!edge.parent_known || !edge.child_known) {
			dropped++;
			continue;
		}
		const parent = overlay.bobByName(edge.parent);
		const child = overlay.bobByName(edge.child);
		if (!parent || !child) {
			dropped++;
			continue;
		}
		const a = overlay.systems.get(parent.origin_system);
		const b = overlay.systems.get(child.origin_system);
		if (!a || !b || a.name === b.name) {
			dropped++;
			continue;
		}
		positions.push(a.xyz[0], a.xyz[1], a.xyz[2], b.xyz[0], b.xyz[1], b.xyz[2]);
		drawn++;
	}

	const geom = new LineSegmentsGeometry();
	geom.setPositions(positions);
	const mat = new LineMaterial({
		color: 0x9b7cff,
		linewidth: 1.5,
		transparent: true,
		opacity: 0.85,
		depthTest: false,
		resolution
	});
	const object = new LineSegments2(geom, mat);
	object.renderOrder = 1;
	object.computeLineDistances();

	return {
		object,
		stats: { drawn, dropped },
		setResolution(w: number, h: number) {
			mat.resolution.set(w, h);
		},
		dispose() {
			geom.dispose();
			mat.dispose();
		}
	};
}
