import * as THREE from 'three';

/**
 * Naked-eye orientation stars labelled on the skybox backdrop. Helps the
 * viewer keep their bearings while orbiting — Castor/Pollux/Regulus/Vega
 * etc. act as anchors that don't move relative to the GAIA panorama.
 *
 * Implementation: per-frame projection of real 3D positions (rotated
 * equatorial→ecliptic to match the bin's frame) onto DOM elements that
 * float over the renderer's canvas. Cheaper than CSS2DObject and easier
 * to style with global CSS.
 */

const OBLIQUITY_RAD = (23.4392911 * Math.PI) / 180;
const OBL_COS = Math.cos(OBLIQUITY_RAD);
const OBL_SIN = Math.sin(OBLIQUITY_RAD);

interface OrientationStar {
	name: string;
	/** Right ascension in degrees (J2000). */
	ra: number;
	/** Declination in degrees (J2000). */
	dec: number;
	/** Distance in parsec; sets the world-space radius of the label point. */
	dist: number;
}

// Bright naked-eye stars distributed around the sky so any orbit angle
// has at least a couple of anchors visible. Distances are realistic
// (parsec) but the project draws the local cloud out to ~25 pc — these
// labels will sit beyond the cloud, on/near the skybox sphere.
const ORIENTATION_STARS: OrientationStar[] = [
	{ name: 'Sirius', ra: 101.287, dec: -16.716, dist: 2.64 },
	{ name: 'Procyon', ra: 114.826, dec: 5.225, dist: 3.51 },
	{ name: 'Altair', ra: 297.696, dec: 8.868, dist: 5.13 },
	{ name: 'Vega', ra: 279.234, dec: 38.784, dist: 7.68 },
	{ name: 'Fomalhaut', ra: 344.413, dec: -29.622, dist: 7.7 },
	{ name: 'Pollux', ra: 116.329, dec: 28.026, dist: 10.34 },
	{ name: 'Arcturus', ra: 213.915, dec: 19.183, dist: 11.26 },
	{ name: 'Capella', ra: 79.172, dec: 45.998, dist: 13.12 },
	{ name: 'Castor', ra: 113.65, dec: 31.888, dist: 15.18 },
	{ name: 'Aldebaran', ra: 68.98, dec: 16.51, dist: 20.0 },
	{ name: 'Regulus', ra: 152.093, dec: 11.967, dist: 24.31 },
	{ name: 'Denebola', ra: 177.265, dec: 14.572, dist: 11.0 },
	{ name: 'Spica', ra: 201.298, dec: -11.161, dist: 76.7 },
	{ name: 'Antares', ra: 247.352, dec: -26.432, dist: 169.0 },
	{ name: 'Deneb', ra: 310.358, dec: 45.28, dist: 802.0 },
	{ name: 'Betelgeuse', ra: 88.793, dec: 7.407, dist: 168.0 },
	{ name: 'Rigel', ra: 78.634, dec: -8.202, dist: 264.0 }
];

interface ProjectedLabel {
	el: HTMLDivElement;
	position: THREE.Vector3;
}

export interface SkyboxLabelsHandle {
	root: HTMLElement;
	/** Re-project labels each frame; cheap (vec3 copy + project + CSS write). */
	update: (camera: THREE.Camera, containerWidth: number, containerHeight: number) => void;
	dispose: () => void;
}

export function makeSkyboxLabels(parent: HTMLElement): SkyboxLabelsHandle {
	const root = document.createElement('div');
	root.className = 'skybox-labels';
	root.style.position = 'absolute';
	root.style.inset = '0';
	root.style.pointerEvents = 'none';
	root.style.overflow = 'hidden';
	parent.appendChild(root);

	const labels: ProjectedLabel[] = [];
	for (const star of ORIENTATION_STARS) {
		const raRad = (star.ra * Math.PI) / 180;
		const decRad = (star.dec * Math.PI) / 180;
		// Equatorial unit vector.
		const xe = Math.cos(decRad) * Math.cos(raRad);
		const ye = Math.cos(decRad) * Math.sin(raRad);
		const ze = Math.sin(decRad);
		// Rotate around X to ecliptic, matching the bin frame.
		const x = xe * star.dist;
		const y = (ye * OBL_COS + ze * OBL_SIN) * star.dist;
		const z = (-ye * OBL_SIN + ze * OBL_COS) * star.dist;

		const el = document.createElement('div');
		el.className = 'skybox-label';
		el.textContent = star.name;
		root.appendChild(el);
		labels.push({ el, position: new THREE.Vector3(x, y, z) });
	}

	const ndc = new THREE.Vector3();
	const update = (camera: THREE.Camera, w: number, h: number) => {
		for (const l of labels) {
			ndc.copy(l.position).project(camera);
			// Behind the camera or off-screen → hide.
			if (ndc.z > 1 || ndc.z < -1 || Math.abs(ndc.x) > 1.1 || Math.abs(ndc.y) > 1.1) {
				if (l.el.style.display !== 'none') l.el.style.display = 'none';
				continue;
			}
			const px = ((ndc.x + 1) / 2) * w;
			const py = ((1 - ndc.y) / 2) * h;
			if (l.el.style.display === 'none') l.el.style.display = '';
			l.el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
		}
	};

	const dispose = () => {
		for (const l of labels) {
			if (l.el.parentNode) l.el.parentNode.removeChild(l.el);
		}
		if (root.parentNode) root.parentNode.removeChild(root);
	};

	return { root, update, dispose };
}
