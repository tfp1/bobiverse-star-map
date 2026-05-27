import * as THREE from 'three';
import type { Overlay } from '$lib/data/overlay';

/**
 * Transient ring-flash at the child Bob's spawn position when a
 * replication edge's in-world year crosses the scrubber. Reads as
 * "a Bob was born here" in Timeline mode without text.
 *
 * Trigger and lifetime are separate: a year-crossing (detected on the
 * JS side from successive setDisplayedYear calls) writes a wall-clock
 * timestamp into a per-instance attribute; the shader uses
 * `uNow - triggeredAt` for age. That way the burst always lasts
 * BURST_LIFETIME_S real seconds — independent of playback speed,
 * pause, or backward scrubs (which un-trigger the burst so a
 * subsequent forward scrub re-fires it).
 */

export const BURST_LIFETIME_S = 1.5;
const START_RADIUS_PC = 0.2;
const END_RADIUS_PC = 1.4;
const COLOR = 0xd3c0ff;

export interface ReplicationBurstsResult {
	object: THREE.Points;
	setDisplayedYear: (year: number | null) => void;
	/** Push wall-clock time forward each frame so burst age advances. */
	tick: () => void;
	dispose: () => void;
}

interface BurstCandidate {
	pos: THREE.Vector3;
	year: number;
}

function collectCandidates(
	overlay: Overlay,
	tier: number,
	yearMaxBuffered: number | null
): BurstCandidate[] {
	const out: BurstCandidate[] = [];
	for (const edge of overlay.replication) {
		if (!edge.parent_known || !edge.child_known) continue;
		if (edge.first_book == null || edge.first_book > tier) continue;
		if (edge.date_year == null) continue;
		if (yearMaxBuffered != null && edge.date_year > yearMaxBuffered) continue;
		const child = overlay.bobByName(edge.child);
		if (!child) continue;
		const s = overlay.systems.get(child.origin_system);
		if (!s) continue;
		out.push({
			pos: new THREE.Vector3(s.xyz[0], s.xyz[1], s.xyz[2]),
			year: edge.date_year
		});
	}
	return out;
}

export function makeReplicationBursts(
	overlay: Overlay,
	tier: number,
	yearMax: number | null
): ReplicationBurstsResult {
	const FADE_BUFFER = 3;
	const yearMaxBuffered = yearMax == null ? null : yearMax + FADE_BUFFER;
	const candidates = collectCandidates(overlay, tier, yearMaxBuffered);
	const N = Math.max(1, candidates.length);

	const positions = new Float32Array(N * 3);
	// Per-instance state. triggeredAt < 0 → not yet fired (or rewound).
	const triggeredAt = new Float32Array(N);
	for (let i = 0; i < N; i++) triggeredAt[i] = -1;
	for (let i = 0; i < candidates.length; i++) {
		positions[i * 3 + 0] = candidates[i].pos.x;
		positions[i * 3 + 1] = candidates[i].pos.y;
		positions[i * 3 + 2] = candidates[i].pos.z;
	}

	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	const triggeredAttr = new THREE.BufferAttribute(triggeredAt, 1);
	triggeredAttr.setUsage(THREE.DynamicDrawUsage);
	geom.setAttribute('triggeredAt', triggeredAttr);
	geom.setDrawRange(0, candidates.length);

	const material = new THREE.ShaderMaterial({
		uniforms: {
			uNow: { value: 0 },
			uLifetime: { value: BURST_LIFETIME_S },
			uPixelRatio: { value: window.devicePixelRatio },
			uHeight: { value: window.innerHeight },
			uColor: { value: new THREE.Color(COLOR) },
			uStartRadius: { value: START_RADIUS_PC },
			uEndRadius: { value: END_RADIUS_PC }
		},
		vertexShader: /* glsl */ `
			attribute float triggeredAt;
			varying float vAge;
			uniform float uNow;
			uniform float uLifetime;
			uniform float uPixelRatio;
			uniform float uHeight;
			uniform float uStartRadius;
			uniform float uEndRadius;
			void main() {
				vAge = (triggeredAt < 0.0) ? -1.0 : (uNow - triggeredAt);
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				gl_Position = projectionMatrix * mv;
				float scale = uHeight * projectionMatrix[1][1] * 0.5;
				float t = (vAge < 0.0) ? 0.0 : clamp(vAge / uLifetime, 0.0, 1.0);
				float r = mix(uStartRadius, uEndRadius, t);
				gl_PointSize = max(2.0, r * scale / -mv.z) * uPixelRatio * 2.0;
			}
		`,
		fragmentShader: /* glsl */ `
			varying float vAge;
			uniform float uLifetime;
			uniform vec3 uColor;
			void main() {
				if (vAge < 0.0 || vAge > uLifetime) discard;
				float t = vAge / uLifetime;
				vec2 uv = gl_PointCoord - 0.5;
				float d = length(uv) * 2.0;
				float ringWidth = mix(0.10, 0.04, t);
				float ringCenter = 0.85;
				float band = smoothstep(ringCenter + ringWidth, ringCenter, d) *
					smoothstep(ringCenter - ringWidth, ringCenter, d);
				float alpha = band * (1.0 - t);
				if (alpha < 0.005) discard;
				gl_FragColor = vec4(uColor, alpha);
			}
		`,
		transparent: true,
		depthWrite: false,
		blending: THREE.AdditiveBlending
	});

	const object = new THREE.Points(geom, material);
	object.frustumCulled = false;
	object.renderOrder = 3;

	let prevDisplayedYear: number | null = null;
	const nowSec = () => performance.now() / 1000;

	return {
		object,
		setDisplayedYear(year: number | null) {
			// Update uNow on every call so the shader stays in lockstep with
			// wall-clock even when the scene's tick loop is otherwise idle.
			material.uniforms.uNow.value = nowSec();
			if (year != null && prevDisplayedYear != null) {
				if (year > prevDisplayedYear) {
					// Forward crossing: trigger candidates whose year is in
					// (prev, year]. Skip already-firing bursts so a play→pause→
					// play cycle straddling a year boundary doesn't restart them.
					const now = material.uniforms.uNow.value;
					for (let i = 0; i < candidates.length; i++) {
						const y = candidates[i].year;
						if (y > prevDisplayedYear && y <= year && triggeredAt[i] < 0) {
							triggeredAt[i] = now;
							triggeredAttr.needsUpdate = true;
						}
					}
				} else if (year < prevDisplayedYear) {
					// Backward scrub: un-trigger anything we've now rewound past
					// so a subsequent forward crossing fires fresh.
					for (let i = 0; i < candidates.length; i++) {
						const y = candidates[i].year;
						if (y > year && y <= prevDisplayedYear && triggeredAt[i] >= 0) {
							triggeredAt[i] = -1;
							triggeredAttr.needsUpdate = true;
						}
					}
				}
			}
			prevDisplayedYear = year;
		},
		tick() {
			material.uniforms.uNow.value = nowSec();
		},
		dispose() {
			geom.dispose();
			material.dispose();
		}
	};
}
