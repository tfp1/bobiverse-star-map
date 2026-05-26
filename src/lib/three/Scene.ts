import * as THREE from 'three';
import { FlyControls } from 'three/addons/controls/FlyControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { loadStarsBin } from '$lib/stars/loadStarsBin';
import { getOverlay } from '$lib/data/overlay';
import { makeStarPoints } from './StarPoints';
import { makeSystemMarkers } from './overlay/SystemMarkers';
import { makeReplicationEdges } from './overlay/ReplicationEdges';
import { makeTravelEdges } from './overlay/TravelEdges';

export interface SceneHandle {
	dispose: () => void;
	stats: SceneStats;
}

export interface SceneStats {
	systems: number;
	replicationEdges: number;
	travelEdges: number;
}

export interface SceneOptions {
	starsBinUrl: string;
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
	camera.position.set(0, 0, 0); // Sol at origin

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
	const systemMarkers = makeSystemMarkers(overlay.systems.values());
	scene.add(systemMarkers.group);
	const repEdges = makeReplicationEdges(overlay);
	scene.add(repEdges.object);
	const travelEdges = makeTravelEdges(overlay);
	scene.add(travelEdges.object);

	const stats: SceneStats = {
		systems: overlay.systems.size,
		replicationEdges: repEdges.stats.drawn,
		travelEdges: travelEdges.stats.drawn
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
	};
	window.addEventListener('resize', onResize);

	return {
		stats,
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			controls.dispose();
			renderer.dispose();
			stars.geometry.dispose();
			(stars.material as THREE.Material).dispose();
			sol.geometry.dispose();
			(sol.material as THREE.Material).dispose();
			systemMarkers.dispose();
			repEdges.dispose();
			travelEdges.dispose();
			container.removeChild(renderer.domElement);
			if (labelRenderer.domElement.parentNode === container) {
				container.removeChild(labelRenderer.domElement);
			}
		}
	};
}
