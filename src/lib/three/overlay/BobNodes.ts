import * as THREE from 'three';
import type { Overlay } from '$lib/data/overlay';
import type { TierView } from '$lib/data/derive';
import type { Bob } from '$lib/data/types';

/**
 * One pip per Bob whose origin_system resolves to a spatial position.
 *
 * Layout: pips per system arrange on a circle in the X-Z plane around
 * the system marker. Radius scales with sqrt(count) so a 29-Bob
 * cluster (Epsilon Eridani) stays readable without dwarfing the
 * 1-Bob cases. Each pip is its own Mesh so raycasting can identify
 * the specific Bob.
 *
 * Colour-codes by generation: gen 1 is the original (yellow), gen 2
 * the first clones (warm), then ramps cooler through purple at gen
 * 6+ to match the replication-edge palette.
 */
export interface BobNodesResult {
	group: THREE.Group;
	meshes: THREE.Mesh[];
	dispose: () => void;
	stats: { drawn: number; skipped: number };
}

const GEN_COLOURS: Record<number, number> = {
	1: 0xffe9a8,
	2: 0xffc56c,
	3: 0xff8c5c,
	4: 0xff6680,
	5: 0xd970c5,
	6: 0xa97cff
};

function colourForGen(gen: number): number {
	if (gen <= 1) return GEN_COLOURS[1];
	return GEN_COLOURS[Math.min(gen, 6)];
}

export function makeBobNodes(overlay: Overlay, view?: TierView): BobNodesResult {
	const group = new THREE.Group();
	group.renderOrder = 3; // above edges

	// Bucket Bobs by their spatial origin_system, filtered by tier.
	// Bobs with no replication-edge appearance (firstBookOf -> null) are
	// hidden until tier === 5 — see TierView.bobVisible.
	const byOrigin = new Map<string, Bob[]>();
	let skipped = 0;
	for (const bob of overlay.bobs) {
		if (!overlay.systems.has(bob.origin_system)) {
			skipped++;
			continue;
		}
		// Per-record visibility — `overlay.bobs` carries backup-variant
		// rows (Elmer_v4 etc.) alongside the primary record under the
		// same display name. bobVisibleRec checks this bob's own id and
		// skips the edge fallback for variants, so a dateless _vN does
		// not inherit the primary's anchors.
		if (view && !view.bobVisibleRec(bob)) {
			skipped++;
			continue;
		}
		const list = byOrigin.get(bob.origin_system) ?? [];
		list.push(bob);
		byOrigin.set(bob.origin_system, list);
	}

	// Single shared geometry; per-mesh material so each pip can carry
	// its own colour. (Could be vectorised with InstancedMesh later
	// — overkill at 60-ish pips.)
	const pipGeom = new THREE.SphereGeometry(0.04, 10, 8);
	const materials: THREE.Material[] = [];
	const meshes: THREE.Mesh[] = [];

	for (const [systemName, bobs] of byOrigin) {
		const system = overlay.systems.get(systemName);
		if (!system) continue;
		const center = new THREE.Vector3(system.xyz[0], system.xyz[1], system.xyz[2]);
		const radius = 0.18 + 0.06 * Math.sqrt(bobs.length);
		// Sort by bob_number so the pip order is stable across reloads.
		const sorted = [...bobs].sort((a, b) => a.bob_number - b.bob_number);
		for (let i = 0; i < sorted.length; i++) {
			const bob = sorted[i];
			const angle = (i / sorted.length) * Math.PI * 2;
			const mat = new THREE.MeshBasicMaterial({
				color: colourForGen(bob.generation),
				transparent: true,
				opacity: 0.92
			});
			materials.push(mat);
			const mesh = new THREE.Mesh(pipGeom, mat);
			mesh.position.set(
				center.x + Math.cos(angle) * radius,
				center.y,
				center.z + Math.sin(angle) * radius
			);
			mesh.userData = { kind: 'bob', bobId: bob.id, bobName: bob.name };
			meshes.push(mesh);
			group.add(mesh);
		}
	}

	return {
		group,
		meshes,
		stats: { drawn: meshes.length, skipped },
		dispose() {
			pipGeom.dispose();
			for (const m of materials) m.dispose();
		}
	};
}
