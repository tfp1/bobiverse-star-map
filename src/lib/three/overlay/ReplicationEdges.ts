import * as THREE from 'three';
import type { Overlay } from '$lib/data/overlay';

/**
 * Replication edges: parent Bob → child Bob, drawn between the two
 * Bobs' origin_system positions. Edges where parent and child share
 * an origin_system collapse to a single point and are dropped (a
 * Bob spawning in the same star is more naturally a per-system
 * pip, which lands with the info-panel PR).
 *
 * Edges whose endpoints don't resolve to a known spatial system
 * (e.g. unknown origin, off-map seeds) are dropped here. They'll
 * come back when non-spatial rendering (#14) is decided.
 */
export interface ReplicationEdgesResult {
	object: THREE.LineSegments;
	dispose: () => void;
	stats: { drawn: number; dropped: number };
}

export function makeReplicationEdges(overlay: Overlay): ReplicationEdgesResult {
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

	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
	const mat = new THREE.LineBasicMaterial({
		color: 0x9b7cff,
		transparent: true,
		opacity: 0.55,
		depthWrite: false
	});
	const object = new THREE.LineSegments(geom, mat);

	return {
		object,
		stats: { drawn, dropped },
		dispose() {
			geom.dispose();
			mat.dispose();
		}
	};
}
