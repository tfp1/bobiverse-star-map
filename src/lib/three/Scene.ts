import * as THREE from 'three';
import { FlyControls } from 'three/addons/controls/FlyControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadStarsBin } from '$lib/stars/loadStarsBin';
import { getOverlay } from '$lib/data/overlay';
import { buildTierView, MAX_TIER } from '$lib/data/derive';
import { makeStarPoints } from './StarPoints';
import { makeSystemMarkers } from './overlay/SystemMarkers';
import { makeReplicationEdges } from './overlay/ReplicationEdges';
import { makeTravelEdges } from './overlay/TravelEdges';
import { makeBobNodes } from './overlay/BobNodes';
import { attachPicking, type Selection } from './picking';

export interface SceneHandle {
	dispose: () => void;
	stats: SceneStats;
	applyTier: (tier: number) => SceneStats;
}

export interface SceneStats {
	systems: number;
	bobs: number;
	replicationEdges: number;
	travelEdges: number;
}

export interface SceneOptions {
	starsBinUrl: string;
	onSelect?: (sel: Selection | null) => void;
	/** Reading-order tier 1..5; defaults to MAX_TIER (show everything). */
	initialTier?: number;
}

export async function mountScene(
	container: HTMLElement,
	opts: SceneOptions
): Promise<SceneHandle> {
	const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
	renderer.setPixelRatio(window.devicePixelRatio);
	renderer.setSize(container.clientWidth, container.clientHeight);
	renderer.setClearColor(0x000005, 1.0);
	container.appendChild(renderer.domElement);

	const labelRenderer = new CSS2DRenderer();
	labelRenderer.setSize(container.clientWidth, container.clientHeight);
	labelRenderer.domElement.style.position = 'absolute';
	labelRenderer.domElement.style.top = '0';
	labelRenderer.domElement.style.left = '0';
	labelRenderer.domElement.style.pointerEvents = 'none';
	container.appendChild(labelRenderer.domElement);

	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(
		60,
		container.clientWidth / container.clientHeight,
		0.01,
		2000
	);
	// Pull back from Sol so the user lands looking at the local
	// cluster rather than inside the Sol marker. The named-system
	// triangle (Alpha Cen ~1.3pc, Epsilon Eri ~3.2pc, Epsilon Indi
	// ~3.6pc) fits comfortably in the foreground from here.
	camera.position.set(5, 3, 8);
	camera.lookAt(0, 0, 0);

	const controls = new FlyControls(camera, renderer.domElement);
	controls.movementSpeed = 8; // parsec/sec
	controls.rollSpeed = 0.6;
	controls.dragToLook = true;
	controls.autoForward = false;

	const cleanupPartial = () => {
		controls.dispose();
		renderer.dispose();
		if (renderer.domElement.parentNode === container) {
			container.removeChild(renderer.domElement);
		}
		if (labelRenderer.domElement.parentNode === container) {
			container.removeChild(labelRenderer.domElement);
		}
	};

	let field;
	try {
		field = await loadStarsBin(opts.starsBinUrl);
	} catch (err) {
		cleanupPartial();
		throw err;
	}
	const stars = makeStarPoints(field);
	scene.add(stars);

	// Mark Sol with a faint sphere at the origin so the user knows where they are.
	const sol = new THREE.Mesh(
		new THREE.SphereGeometry(0.05, 12, 12),
		new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
	);
	scene.add(sol);

	const overlay = getOverlay();
	const edgeResolution = new THREE.Vector2(container.clientWidth, container.clientHeight);

	// The four overlay groups are rebuilt on every tier change. Holding
	// the current renderer handles in a single object makes dispose +
	// swap symmetric.
	interface OverlayBundle {
		systemMarkers: ReturnType<typeof makeSystemMarkers>;
		repEdges: ReturnType<typeof makeReplicationEdges>;
		travelEdges: ReturnType<typeof makeTravelEdges>;
		bobNodes: ReturnType<typeof makeBobNodes>;
	}

	const buildOverlay = (tier: number): OverlayBundle => {
		const view = buildTierView(overlay, tier);
		const systemMarkers = makeSystemMarkers(overlay.systems.values(), view.visibleSystems);
		const repEdges = makeReplicationEdges(overlay, edgeResolution, view);
		const travelEdges = makeTravelEdges(overlay, edgeResolution, view);
		const bobNodes = makeBobNodes(overlay, view);
		return { systemMarkers, repEdges, travelEdges, bobNodes };
	};

	const disposeOverlay = (b: OverlayBundle) => {
		scene.remove(b.systemMarkers.group);
		scene.remove(b.repEdges.object);
		scene.remove(b.travelEdges.object);
		scene.remove(b.bobNodes.group);
		b.systemMarkers.dispose();
		b.repEdges.dispose();
		b.travelEdges.dispose();
		b.bobNodes.dispose();
	};

	const initialTier = opts.initialTier ?? MAX_TIER;
	let bundle = buildOverlay(initialTier);
	scene.add(bundle.systemMarkers.group);
	scene.add(bundle.repEdges.object);
	scene.add(bundle.travelEdges.object);
	scene.add(bundle.bobNodes.group);

	const picking = attachPicking({
		camera,
		canvas: renderer.domElement,
		targets: [...bundle.systemMarkers.meshes, ...bundle.bobNodes.meshes],
		onSelect: opts.onSelect ?? (() => {})
	});

	const stats: SceneStats = {
		systems: bundle.systemMarkers.meshes.length,
		bobs: bundle.bobNodes.stats.drawn,
		replicationEdges: bundle.repEdges.stats.drawn,
		travelEdges: bundle.travelEdges.stats.drawn
	};

	const clock = new THREE.Clock();
	let raf = 0;
	const tick = () => {
		const dt = clock.getDelta();
		controls.update(dt);
		renderer.render(scene, camera);
		labelRenderer.render(scene, camera);
		raf = requestAnimationFrame(tick);
	};
	raf = requestAnimationFrame(tick);

	const onResize = () => {
		const w = container.clientWidth;
		const h = container.clientHeight;
		renderer.setSize(w, h);
		labelRenderer.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		(stars.material as THREE.ShaderMaterial).uniforms.uHeight.value = h;
		bundle.repEdges.setResolution(w, h);
		bundle.travelEdges.setResolution(w, h);
	};
	window.addEventListener('resize', onResize);

	return {
		stats,
		applyTier(tier: number): SceneStats {
			disposeOverlay(bundle);
			bundle = buildOverlay(tier);
			scene.add(bundle.systemMarkers.group);
			scene.add(bundle.repEdges.object);
			scene.add(bundle.travelEdges.object);
			scene.add(bundle.bobNodes.group);
			picking.setTargets([...bundle.systemMarkers.meshes, ...bundle.bobNodes.meshes]);
			stats.systems = bundle.systemMarkers.meshes.length;
			stats.bobs = bundle.bobNodes.stats.drawn;
			stats.replicationEdges = bundle.repEdges.stats.drawn;
			stats.travelEdges = bundle.travelEdges.stats.drawn;
			return { ...stats };
		},
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			controls.dispose();
			renderer.dispose();
			stars.geometry.dispose();
			(stars.material as THREE.Material).dispose();
			sol.geometry.dispose();
			(sol.material as THREE.Material).dispose();
			disposeOverlay(bundle);
			picking.dispose();
			container.removeChild(renderer.domElement);
			if (labelRenderer.domElement.parentNode === container) {
				container.removeChild(labelRenderer.domElement);
			}
		}
	};
}
