import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { loadStarsBin } from '$lib/stars/loadStarsBin';
import { getOverlay } from '$lib/data/overlay';
import { buildTierView, MAX_TIER } from '$lib/data/derive';
import { makeStarPoints } from './StarPoints';
import { makeSystemMarkers } from './overlay/SystemMarkers';
import { makeReplicationEdges } from './overlay/ReplicationEdges';
import { makeTravelEdges } from './overlay/TravelEdges';
import { makeBobNodes } from './overlay/BobNodes';
import { makeOffMapMarkers } from './overlay/OffMapMarkers';
import { makeMegastructureNodes } from './overlay/MegastructureNodes';
import { makeGrids } from './Grids';
import { makeDropLines } from './DropLines';
import { makeSkyboxLabels } from './SkyboxLabels';
import { makeReplicationBursts } from './ReplicationBursts';
import { attachPicking, type Selection } from './picking';

export interface SceneHandle {
	dispose: () => void;
	stats: SceneStats;
	applyView: (view: { tier: number; yearMax: number | null }) => SceneStats;
	/** Animate to a (eye, target) view with cubic easing. */
	flyTo: (eye: THREE.Vector3, target: THREE.Vector3, ms?: number) => void;
	/** Recenter on Sol and frame the local cloud. */
	recenter: () => void;
	/** Top-down view along +Y axis (the ecliptic plane — the bin's reference plane). */
	frameEcliptic: () => void;
	/** Re-pivot orbit on a named system / bob and fly closer. */
	focusOn: (sel: Selection) => void;
	/**
	 * Continuous (float) scrubber year for shader-driven edge fade-in
	 * and replication bursts. Null disables animation (Explore mode).
	 * Cheap — uniform write, no rebuild.
	 */
	setDisplayedYear: (year: number | null) => void;
}

export interface SceneStats {
	systems: number;
	megastructures: number;
	bobs: number;
	replicationEdges: number;
	travelEdges: number;
}

export interface SceneOptions {
	starsBinUrl: string;
	onSelect?: (sel: Selection | null) => void;
	initialTier?: number;
	initialYearMax?: number | null;
}

const INITIAL_EYE = new THREE.Vector3(5, 3, 8);
const INITIAL_TARGET = new THREE.Vector3(0, 0, 0);
const PLANE_EYE = new THREE.Vector3(0, 18, 0.01); // y-up top-down; tiny z to avoid degenerate up
const PLANE_TARGET = new THREE.Vector3(0, 0, 0);

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
	camera.position.copy(INITIAL_EYE);
	camera.lookAt(INITIAL_TARGET);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.target.copy(INITIAL_TARGET);
	controls.enableDamping = true;
	controls.dampingFactor = 0.05;
	controls.minDistance = 0.02;
	controls.maxDistance = 200;
	controls.enablePan = true;
	controls.panSpeed = 0.8;
	controls.rotateSpeed = 0.7;
	controls.zoomSpeed = 0.9;
	controls.screenSpacePanning = true; // pan in screen plane, not on the world XZ floor
	controls.update();

	// Reference grids and skybox labels mount before the overlay so the
	// star points and markers draw on top of them.
	const grids = makeGrids({ planeSpacing: 3, offsetCount: 1, radius: 16, gridStep: 1 });
	scene.add(grids.group);

	const skyboxLabels = makeSkyboxLabels(container);

	// Bloom post-pass — gentle, so bright stars and Sol get a subtle halo
	// without turning into glow blobs. Strength stays low to keep the
	// star-point shader's crisp falloff intact.
	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	const bloom = new UnrealBloomPass(
		new THREE.Vector2(container.clientWidth, container.clientHeight),
		0.35, // strength
		0.6,  // radius
		0.85  // threshold (only bright pixels bloom)
	);
	composer.addPass(bloom);

	const cleanupPartial = () => {
		controls.dispose();
		renderer.dispose();
		composer.dispose();
		grids.dispose();
		skyboxLabels.dispose();
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

	const sol = new THREE.Mesh(
		new THREE.SphereGeometry(0.06, 16, 12),
		new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
	);
	scene.add(sol);

	const overlay = getOverlay();
	const edgeResolution = new THREE.Vector2(container.clientWidth, container.clientHeight);

	interface OverlayBundle {
		systemMarkers: ReturnType<typeof makeSystemMarkers>;
		offMapMarkers: ReturnType<typeof makeOffMapMarkers>;
		megastructureNodes: ReturnType<typeof makeMegastructureNodes>;
		repEdges: ReturnType<typeof makeReplicationEdges>;
		travelEdges: ReturnType<typeof makeTravelEdges>;
		bobNodes: ReturnType<typeof makeBobNodes>;
		dropLines: ReturnType<typeof makeDropLines>;
	}

	let currentDisplayedYear: number | null = null;

	// Replication bursts live OUTSIDE the bundle so their per-instance
	// prevDisplayedYear / triggered state survive applyView's rebuild.
	// Otherwise a year-crossing that coincides with an integer rebuild
	// would land on a fresh module with prev=null and skip the
	// (prev, year] comparison that drives the burst trigger.
	const repBursts = makeReplicationBursts(
		overlay,
		opts.initialTier ?? MAX_TIER,
		opts.initialYearMax ?? null
	);
	scene.add(repBursts.object);

	const buildOverlay = (tier: number, yearMax: number | null): OverlayBundle => {
		const view = buildTierView(overlay, tier, yearMax);
		const systemMarkers = makeSystemMarkers(overlay.systems.values(), view.visibleSystems);
		const offMapMarkers = makeOffMapMarkers(overlay.offMap.values(), view.visibleSystems);
		const megastructureNodes = makeMegastructureNodes(
			overlay,
			edgeResolution,
			view.visibleMegastructures
		);
		const repEdges = makeReplicationEdges(overlay, edgeResolution, view);
		const travelEdges = makeTravelEdges(overlay, edgeResolution, view);
		const bobNodes = makeBobNodes(overlay, view);
		// Drop lines from each visible catalog-star marker to the central
		// plane. Off-map ring markers sit far from the cloud and would
		// flood the view with stems; skip them.
		const dropPositions: THREE.Vector3[] = [];
		for (const m of systemMarkers.meshes) {
			// Skip Sol itself — already on the plane.
			if (m.userData?.systemName === 'Sol') continue;
			dropPositions.push(m.position.clone());
		}
		const dropLines = makeDropLines(dropPositions);
		// Seed the newly-built edge materials with the current scrubber
		// position so newly-included edges don't pop on the boundary year.
		// (repBursts is built once at scene-mount; setView keeps its
		// prevDisplayedYear intact so the crossing comparison survives.)
		const y = currentDisplayedYear ?? yearMax;
		repEdges.setDisplayedYear(y);
		travelEdges.setDisplayedYear(y);
		return {
			systemMarkers,
			offMapMarkers,
			megastructureNodes,
			repEdges,
			travelEdges,
			bobNodes,
			dropLines
		};
	};

	const disposeOverlay = (b: OverlayBundle) => {
		scene.remove(b.systemMarkers.group);
		scene.remove(b.offMapMarkers.group);
		scene.remove(b.megastructureNodes.group);
		scene.remove(b.repEdges.object);
		scene.remove(b.travelEdges.object);
		scene.remove(b.bobNodes.group);
		scene.remove(b.dropLines.object);
		b.systemMarkers.dispose();
		b.offMapMarkers.dispose();
		b.megastructureNodes.dispose();
		b.repEdges.dispose();
		b.travelEdges.dispose();
		b.bobNodes.dispose();
		b.dropLines.dispose();
	};

	const initialTier = opts.initialTier ?? MAX_TIER;
	const initialYearMax = opts.initialYearMax ?? null;
	let bundle = buildOverlay(initialTier, initialYearMax);
	const addBundle = (b: OverlayBundle) => {
		scene.add(b.systemMarkers.group);
		scene.add(b.offMapMarkers.group);
		scene.add(b.megastructureNodes.group);
		scene.add(b.repEdges.object);
		scene.add(b.travelEdges.object);
		scene.add(b.bobNodes.group);
		scene.add(b.dropLines.object);
	};
	const pickTargets = (b: OverlayBundle): THREE.Mesh[] => [
		...b.systemMarkers.meshes,
		...b.offMapMarkers.meshes,
		...b.megastructureNodes.meshes,
		...b.bobNodes.meshes
	];
	addBundle(bundle);

	const picking = attachPicking({
		camera,
		canvas: renderer.domElement,
		targets: pickTargets(bundle),
		onSelect: opts.onSelect ?? (() => {})
	});

	const stats: SceneStats = {
		systems: bundle.systemMarkers.meshes.length + bundle.offMapMarkers.meshes.length,
		megastructures: bundle.megastructureNodes.meshes.length,
		bobs: bundle.bobNodes.stats.drawn,
		replicationEdges: bundle.repEdges.stats.drawn,
		travelEdges: bundle.travelEdges.stats.drawn
	};

	// flyTo: cubic ease-in-out between current (eye, target) and a destination.
	// We animate `controls.target` and the camera position in lockstep so
	// the user keeps a recognisable framing through the move.
	interface FlyState {
		startEye: THREE.Vector3;
		startTarget: THREE.Vector3;
		endEye: THREE.Vector3;
		endTarget: THREE.Vector3;
		t0: number;
		duration: number;
	}
	let fly: FlyState | null = null;
	const easeInOutCubic = (x: number) =>
		x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

	const flyTo = (eye: THREE.Vector3, target: THREE.Vector3, ms = 900) => {
		fly = {
			startEye: camera.position.clone(),
			startTarget: controls.target.clone(),
			endEye: eye.clone(),
			endTarget: target.clone(),
			t0: performance.now(),
			duration: ms
		};
	};

	const recenter = () => flyTo(INITIAL_EYE, INITIAL_TARGET);
	const frameEcliptic = () => flyTo(PLANE_EYE, PLANE_TARGET);

	const focusOn = (sel: Selection) => {
		let pos: THREE.Vector3 | null = null;
		if (sel.kind === 'system') {
			const s = overlay.resolveSystem(sel.systemName);
			if (s) pos = new THREE.Vector3(s.xyz[0], s.xyz[1], s.xyz[2]);
		} else if (sel.kind === 'megastructure') {
			const m = overlay.megastructures.find((x) => x.name === sel.megastructureName);
			if (m) {
				const host = overlay.resolveSystem(m.host);
				if (host) pos = new THREE.Vector3(host.xyz[0], host.xyz[1], host.xyz[2]);
			}
		} else if (sel.kind === 'bob') {
			// Bob nodes sit near their current system; use the mesh position
			// from the live overlay bundle (cheaper than re-deriving).
			const mesh = bundle.bobNodes.meshes.find(
				(m) => (m.userData as { bobId?: string }).bobId === sel.bobId
			);
			if (mesh) pos = mesh.position.clone();
		}
		if (!pos) return;
		// Position the camera at a fixed offset from the focus point that
		// keeps the same viewing direction we currently have, so the
		// framing feels like "lean in" rather than "teleport".
		const offset = camera.position.clone().sub(controls.target);
		const dist = Math.max(offset.length(), 0.3);
		const targetDist = Math.min(dist, 3); // pull in if we were further out
		offset.setLength(targetDist);
		flyTo(pos.clone().add(offset), pos);
	};

	const clock = new THREE.Clock();
	let raf = 0;
	const tick = () => {
		const dt = clock.getDelta();
		if (fly) {
			const t = Math.min(1, (performance.now() - fly.t0) / fly.duration);
			const e = easeInOutCubic(t);
			camera.position.lerpVectors(fly.startEye, fly.endEye, e);
			controls.target.lerpVectors(fly.startTarget, fly.endTarget, e);
			if (t >= 1) fly = null;
		}
		controls.update();
		grids.update(camera);
		bundle.travelEdges.tickFlow(dt);
		repBursts.tick();
		composer.render(dt);
		labelRenderer.render(scene, camera);
		skyboxLabels.update(camera, container.clientWidth, container.clientHeight);
		raf = requestAnimationFrame(tick);
	};
	raf = requestAnimationFrame(tick);

	const onResize = () => {
		const w = container.clientWidth;
		const h = container.clientHeight;
		renderer.setSize(w, h);
		labelRenderer.setSize(w, h);
		composer.setSize(w, h);
		bloom.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		(stars.material as THREE.ShaderMaterial).uniforms.uHeight.value = h;
		bundle.repEdges.setResolution(w, h);
		bundle.travelEdges.setResolution(w, h);
		bundle.megastructureNodes.setResolution(w, h);
	};
	window.addEventListener('resize', onResize);

	return {
		stats,
		applyView({ tier, yearMax }: { tier: number; yearMax: number | null }): SceneStats {
			disposeOverlay(bundle);
			bundle = buildOverlay(tier, yearMax);
			addBundle(bundle);
			// Refresh burst candidates against the new view, but keep the
			// module's prevDisplayedYear so the next setDisplayedYear call
			// (with the new yearFloat) still triggers any crossings.
			repBursts.setView(overlay, tier, yearMax);
			picking.setTargets(pickTargets(bundle));
			stats.systems = bundle.systemMarkers.meshes.length + bundle.offMapMarkers.meshes.length;
			stats.megastructures = bundle.megastructureNodes.meshes.length;
			stats.bobs = bundle.bobNodes.stats.drawn;
			stats.replicationEdges = bundle.repEdges.stats.drawn;
			stats.travelEdges = bundle.travelEdges.stats.drawn;
			return { ...stats };
		},
		flyTo,
		recenter,
		frameEcliptic,
		focusOn,
		setDisplayedYear(year: number | null) {
			currentDisplayedYear = year;
			bundle.repEdges.setDisplayedYear(year);
			bundle.travelEdges.setDisplayedYear(year);
			repBursts.setDisplayedYear(year);
		},
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			controls.dispose();
			composer.dispose();
			renderer.dispose();
			stars.geometry.dispose();
			(stars.material as THREE.Material).dispose();
			sol.geometry.dispose();
			(sol.material as THREE.Material).dispose();
			grids.dispose();
			skyboxLabels.dispose();
			scene.remove(repBursts.object);
			repBursts.dispose();
			disposeOverlay(bundle);
			picking.dispose();
			container.removeChild(renderer.domElement);
			if (labelRenderer.domElement.parentNode === container) {
				container.removeChild(labelRenderer.domElement);
			}
		}
	};
}
