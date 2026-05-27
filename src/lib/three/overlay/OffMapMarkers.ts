import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { SpatialSystem } from '$lib/data/types';

/**
 * Off-map marker renderer (handoff D6/D7). One node per entry in
 * `overlay.offMap`, placed on the ~120 pc ring sphere.
 *
 * Two icon classes:
 *   - kind: 'off_map'   — ghosted torus (a thin ring), dim cyan,
 *                          reads as "this is out there but we don't
 *                          know which way exactly".
 *   - kind: 'sgr_a_star' — gold-tinted octahedron, slightly bigger,
 *                          reads as "we know which direction this is"
 *                          (per the literal-direction beacon convention).
 *
 * Markers are physically large (2 pc radius) because they sit far from
 * the local star cloud and would otherwise be sub-pixel from the
 * default camera position.
 */
export interface OffMapMarkersResult {
	group: THREE.Group;
	meshes: THREE.Mesh[];
	dispose: () => void;
}

const OFF_MAP_RADIUS = 2.0;
const OFF_MAP_TUBE = 0.35;
const SGR_A_RADIUS = 2.4;

export function makeOffMapMarkers(
	offMap: Iterable<SpatialSystem>,
	visible?: Set<string>
): OffMapMarkersResult {
	const group = new THREE.Group();

	// Two shared geometries; per-mesh material so future per-marker
	// emphasis (timeline highlight, hover) can adjust opacity without
	// dirtying its neighbours' material.
	const ringGeom = new THREE.TorusGeometry(OFF_MAP_RADIUS, OFF_MAP_TUBE, 8, 32);
	const sgrGeom = new THREE.OctahedronGeometry(SGR_A_RADIUS, 0);
	const materials: THREE.Material[] = [];
	const labelEls: HTMLDivElement[] = [];
	const meshes: THREE.Mesh[] = [];

	for (const s of offMap) {
		if (visible && !visible.has(s.name)) continue;

		const isSgrA = s.kind === 'sgr_a_star';
		const mat = new THREE.MeshBasicMaterial({
			color: isSgrA ? 0xf4c75a : 0x7088a8,
			transparent: true,
			opacity: isSgrA ? 0.85 : 0.55,
			side: THREE.DoubleSide
		});
		materials.push(mat);

		const mesh = new THREE.Mesh(isSgrA ? sgrGeom : ringGeom, mat);
		mesh.position.set(s.xyz[0], s.xyz[1], s.xyz[2]);
		// Orient the torus so its face points back toward Sol — keeps
		// the ring readable from origin instead of edge-on.
		if (!isSgrA) {
			mesh.lookAt(0, 0, 0);
		}
		mesh.userData = { kind: 'system', systemName: s.name };
		meshes.push(mesh);
		group.add(mesh);

		const el = document.createElement('div');
		el.className = isSgrA ? 'system-label off-map-label sgr-a-label' : 'system-label off-map-label';
		el.textContent = s.name;
		labelEls.push(el);
		const label = new CSS2DObject(el);
		label.position.copy(mesh.position);
		group.add(label);
	}

	return {
		group,
		meshes,
		dispose() {
			ringGeom.dispose();
			sgrGeom.dispose();
			for (const m of materials) m.dispose();
			for (const el of labelEls) el.remove();
		}
	};
}
