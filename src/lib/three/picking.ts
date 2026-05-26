import * as THREE from 'three';

export type Selection =
	| { kind: 'system'; systemName: string }
	| { kind: 'bob'; bobId: string; bobName: string };

export interface PickingOptions {
	camera: THREE.Camera;
	canvas: HTMLElement;
	targets: THREE.Mesh[];
	onSelect: (sel: Selection | null) => void;
	/** Max pointer travel in pixels for a mouseup to count as a click. */
	dragThreshold?: number;
}

export interface PickingHandle {
	dispose: () => void;
	setTargets: (meshes: THREE.Mesh[]) => void;
}

/**
 * Mouse-driven raycaster. We attach mousedown/mouseup pairs so that
 * fly-control drag-to-look doesn't also fire selections — a "click"
 * is only registered if the pointer didn't travel more than
 * `dragThreshold` between down and up.
 *
 * Pointer events are listened on `canvas`, not on `window`, so the
 * CSS2DRenderer overlay above the canvas (which has
 * pointer-events:none) doesn't swallow them.
 */
export function attachPicking(opts: PickingOptions): PickingHandle {
	const { camera, canvas, onSelect } = opts;
	let targets = opts.targets;
	const dragThreshold = opts.dragThreshold ?? 5;
	const raycaster = new THREE.Raycaster();
	const ndc = new THREE.Vector2();
	let downX = 0;
	let downY = 0;
	let downed = false;

	const onDown = (e: PointerEvent) => {
		downX = e.clientX;
		downY = e.clientY;
		downed = true;
	};

	const onUp = (e: PointerEvent) => {
		if (!downed) return;
		downed = false;
		const dx = e.clientX - downX;
		const dy = e.clientY - downY;
		if (dx * dx + dy * dy > dragThreshold * dragThreshold) return;

		const rect = canvas.getBoundingClientRect();
		ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(ndc, camera);
		const hits = raycaster.intersectObjects(targets, false);
		if (hits.length === 0) {
			onSelect(null);
			return;
		}
		const hit = hits[0].object;
		const data = hit.userData as
			| { kind: 'system'; systemName: string }
			| { kind: 'bob'; bobId: string; bobName: string }
			| Record<string, never>;
		if (data.kind === 'system') {
			onSelect({ kind: 'system', systemName: data.systemName });
		} else if (data.kind === 'bob') {
			onSelect({ kind: 'bob', bobId: data.bobId, bobName: data.bobName });
		} else {
			onSelect(null);
		}
	};

	canvas.addEventListener('pointerdown', onDown);
	canvas.addEventListener('pointerup', onUp);

	return {
		setTargets(meshes: THREE.Mesh[]) {
			targets = meshes;
		},
		dispose() {
			canvas.removeEventListener('pointerdown', onDown);
			canvas.removeEventListener('pointerup', onUp);
		}
	};
}
