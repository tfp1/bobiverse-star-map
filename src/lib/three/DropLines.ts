import * as THREE from 'three';

/**
 * Vertical "stems" from each named-system marker down to the central
 * grid plane (y=0). Gives an immediate z-axis reading — "this system is
 * 3 pc above the plane" — that the cloud of stars otherwise can't
 * convey. One batched LineSegments for the whole set; rebuild on view
 * changes alongside the overlay bundle.
 */

export interface DropLinesHandle {
	object: THREE.LineSegments;
	dispose: () => void;
}

export function makeDropLines(positions: THREE.Vector3[]): DropLinesHandle {
	const positionsArr = new Float32Array(positions.length * 6);
	for (let i = 0; i < positions.length; i++) {
		const p = positions[i];
		positionsArr[i * 6 + 0] = p.x;
		positionsArr[i * 6 + 1] = p.y;
		positionsArr[i * 6 + 2] = p.z;
		positionsArr[i * 6 + 3] = p.x;
		positionsArr[i * 6 + 4] = 0;
		positionsArr[i * 6 + 5] = p.z;
	}

	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positionsArr, 3));

	const material = new THREE.LineBasicMaterial({
		color: 0x7fa6c7,
		transparent: true,
		opacity: 0.28,
		depthWrite: false
	});

	const object = new THREE.LineSegments(geom, material);
	object.renderOrder = -1;

	return {
		object,
		dispose() {
			geom.dispose();
			material.dispose();
		}
	};
}
