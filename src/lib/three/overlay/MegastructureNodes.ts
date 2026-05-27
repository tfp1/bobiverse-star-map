import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Overlay } from '$lib/data/overlay';
import type { Megastructure } from '$lib/data/types';

/**
 * Host-bound megastructure renderer (handoff D9).
 *
 *   - Heaven's River (topopolis)   → thin torus icon, green tint
 *   - Matryoshka Brain (dyson_variant) → wireframe lattice sphere
 *
 * Each megastructure renders at its precomputed offset from its host
 * star (~0.3 pc) and is connected to the host with a faint tether
 * line so the relationship reads at a glance. Picked meshes carry
 * `userData = { kind: 'megastructure', megastructureName }` so the
 * InfoPanel can pull up the sub-locations list (D10).
 */
export interface MegastructureNodesResult {
	group: THREE.Group;
	meshes: THREE.Mesh[];
	tether: LineSegments2;
	setResolution: (w: number, h: number) => void;
	dispose: () => void;
}

export function makeMegastructureNodes(
	overlay: Overlay,
	resolution: THREE.Vector2,
	visible?: Set<string>
): MegastructureNodesResult {
	const group = new THREE.Group();
	group.renderOrder = 3;

	const torusGeom = new THREE.TorusGeometry(0.14, 0.03, 8, 24);
	const latticeGeom = new THREE.IcosahedronGeometry(0.13, 1);
	const materials: THREE.Material[] = [];
	const labelEls: HTMLDivElement[] = [];
	const meshes: THREE.Mesh[] = [];

	const tetherPositions: number[] = [];

	for (const m of overlay.megastructures) {
		if (visible && !visible.has(m.name)) continue;
		const host = overlay.systems.get(m.host);
		if (!host) continue;

		const mat = makeMegaMaterial(m);
		materials.push(mat);
		const mesh = new THREE.Mesh(
			m.subtype === 'topopolis' ? torusGeom : latticeGeom,
			mat
		);
		mesh.position.set(m.xyz[0], m.xyz[1], m.xyz[2]);
		// Tilt topopolis ring so it doesn't sit edge-on to the camera
		// on first load (camera lands at +X/+Y/+Z).
		if (m.subtype === 'topopolis') {
			mesh.rotation.x = Math.PI / 3;
			mesh.rotation.y = Math.PI / 6;
		}
		mesh.userData = { kind: 'megastructure', megastructureName: m.name };
		meshes.push(mesh);
		group.add(mesh);

		const el = document.createElement('div');
		el.className = 'system-label megastructure-label';
		el.textContent = m.name;
		labelEls.push(el);
		const label = new CSS2DObject(el);
		label.position.copy(mesh.position);
		group.add(label);

		tetherPositions.push(host.xyz[0], host.xyz[1], host.xyz[2], m.xyz[0], m.xyz[1], m.xyz[2]);
	}

	const tetherGeom = new LineSegmentsGeometry();
	tetherGeom.setPositions(tetherPositions);
	const tetherMat = new LineMaterial({
		color: 0x6fc3ff,
		linewidth: 0.8,
		transparent: true,
		opacity: 0.4,
		depthTest: false,
		resolution
	});
	const tether = new LineSegments2(tetherGeom, tetherMat);
	tether.renderOrder = 2;
	tether.computeLineDistances();
	group.add(tether);

	return {
		group,
		meshes,
		tether,
		setResolution(w: number, h: number) {
			tetherMat.resolution.set(w, h);
		},
		dispose() {
			torusGeom.dispose();
			latticeGeom.dispose();
			tetherGeom.dispose();
			tetherMat.dispose();
			for (const m of materials) m.dispose();
			for (const el of labelEls) el.remove();
		}
	};
}

function makeMegaMaterial(m: Megastructure): THREE.Material {
	if (m.subtype === 'topopolis') {
		// Heaven's River reads as green (Quinlan biosphere on the ribbon).
		return new THREE.MeshBasicMaterial({
			color: 0x6dd0a0,
			transparent: true,
			opacity: 0.9
		});
	}
	// dyson_variant: lattice sphere, gold/copper to read as "wrapping the star".
	return new THREE.MeshBasicMaterial({
		color: 0xe0a060,
		transparent: true,
		opacity: 0.8,
		wireframe: true
	});
}
