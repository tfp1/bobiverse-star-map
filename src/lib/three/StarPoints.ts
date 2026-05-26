import * as THREE from 'three';
import type { StarField } from '$lib/stars/loadStarsBin';
import { bpRpToRgb } from './starColor';

/**
 * Build a Points object for a StarField.
 *
 * Per-vertex attributes:
 *   - position (3f, parsec)
 *   - color    (3f, linear RGB from BP-RP)
 *   - size     (1f, world-space point radius derived from absolute magnitude)
 *
 * The shader uses size attenuation in clip space so distant stars
 * shrink naturally; the size attribute scales them by intrinsic
 * brightness. A small radial alpha falloff softens the sprite.
 */
export function makeStarPoints(field: StarField): THREE.Points {
	const { count, positions, absMag, bpRp } = field;

	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));

	const colors = new Float32Array(count * 3);
	const sizes = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		bpRpToRgb(bpRp[i], colors, i * 3);
		// Brighter (more negative M) → bigger. M ranges roughly [-5, 15] in
		// this volume. Clamp + log-ish curve so the dimmest aren't dots.
		const m = Math.max(-5, Math.min(15, absMag[i]));
		sizes[i] = Math.pow(1.4, -m) * 0.04 + 0.5;
	}
	geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
	geom.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

	const material = new THREE.ShaderMaterial({
		uniforms: {
			uPixelRatio: { value: window.devicePixelRatio },
			uHeight: { value: window.innerHeight }
		},
		vertexShader: /* glsl */ `
			attribute float size;
			varying vec3 vColor;
			uniform float uPixelRatio;
			uniform float uHeight;
			void main() {
				vColor = color;
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				gl_Position = projectionMatrix * mv;
				// Convert world-space radius to pixels via projection
				// matrix's vertical scale. Falls off with 1/-z.
				float scale = uHeight * projectionMatrix[1][1] * 0.5;
				gl_PointSize = max(1.0, size * scale / -mv.z) * uPixelRatio;
			}
		`,
		fragmentShader: /* glsl */ `
			varying vec3 vColor;
			void main() {
				vec2 uv = gl_PointCoord - 0.5;
				float d = length(uv);
				if (d > 0.5) discard;
				float a = smoothstep(0.5, 0.1, d);
				gl_FragColor = vec4(vColor, a);
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending,
		vertexColors: true
	});

	const points = new THREE.Points(geom, material);
	points.frustumCulled = false;
	return points;
}
