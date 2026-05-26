import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { SpatialSystem } from '$lib/data/types';

/**
 * One marker (small sphere + HTML label) per Bobiverse-relevant system.
 * Returns the Three.js group, the marker meshes (for raycasting), and
 * a dispose path so the scene teardown can clean everything up.
 *
 * `visible` (when provided) filters systems by name — used by the
 * spoiler selector to hide systems whose content is all gated out.
 */
export interface SystemMarkersResult {
	group: THREE.Group;
	meshes: THREE.Mesh[];
	dispose: () => void;
}

export function makeSystemMarkers(
	systems: Iterable<SpatialSystem>,
	visible?: Set<string>
): SystemMarkersResult {
	const group = new THREE.Group();
	const sphereGeom = new THREE.SphereGeometry(0.12, 16, 12);
	const sphereMat = new THREE.MeshBasicMaterial({
		color: 0x6fc3ff,
		transparent: true,
		opacity: 0.7
	});
	const labelEls: HTMLDivElement[] = [];
	const meshes: THREE.Mesh[] = [];

	for (const s of systems) {
		if (visible && !visible.has(s.name)) continue;
		const sphere = new THREE.Mesh(sphereGeom, sphereMat);
		sphere.position.set(s.xyz[0], s.xyz[1], s.xyz[2]);
		sphere.userData = { kind: 'system', systemName: s.name };
		group.add(sphere);
		meshes.push(sphere);

		const el = document.createElement('div');
		el.className = 'system-label';
		el.textContent = s.name;
		labelEls.push(el);
		const label = new CSS2DObject(el);
		label.position.copy(sphere.position);
		group.add(label);
	}

	return {
		group,
		meshes,
		dispose() {
			sphereGeom.dispose();
			sphereMat.dispose();
			for (const el of labelEls) el.remove();
		}
	};
}
