import * as THREE from 'three';
import { FlyControls } from 'three/addons/controls/FlyControls.js';
import { loadStarsBin } from '$lib/stars/loadStarsBin';
import { makeStarPoints } from './StarPoints';

export interface SceneHandle {
	dispose: () => void;
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

	const field = await loadStarsBin(opts.starsBinUrl);
	const stars = makeStarPoints(field);
	scene.add(stars);

	// Mark Sol with a faint sphere at the origin so the user knows where they are.
	const sol = new THREE.Mesh(
		new THREE.SphereGeometry(0.05, 12, 12),
		new THREE.MeshBasicMaterial({ color: 0xffe9a8 })
	);
	scene.add(sol);

	const clock = new THREE.Clock();
	let raf = 0;
	const tick = () => {
		const dt = clock.getDelta();
		controls.update(dt);
		renderer.render(scene, camera);
		raf = requestAnimationFrame(tick);
	};
	raf = requestAnimationFrame(tick);

	const onResize = () => {
		const w = container.clientWidth;
		const h = container.clientHeight;
		renderer.setSize(w, h);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		(stars.material as THREE.ShaderMaterial).uniforms.uHeight.value = h;
	};
	window.addEventListener('resize', onResize);

	return {
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			controls.dispose();
			renderer.dispose();
			stars.geometry.dispose();
			(stars.material as THREE.Material).dispose();
			container.removeChild(renderer.domElement);
		}
	};
}
