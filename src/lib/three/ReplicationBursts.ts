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
	/**
	 * Recompute candidate set (tier and/or year-buffer changed) without
	 * resetting prevDisplayedYear or wall-clock state. The geometry's
	 * position + triggeredAt buffers are reused if the new candidate
	 * count fits; otherwise reallocated. Preserves the (prev, year]
	 * comparison window across the call so a year-crossing that the
	 * caller would push immediately afterwards still triggers.
	 */
	setView: (overlay: Overlay, tier: number, yearMax: number | null) => void;
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

const FADE_BUFFER = 3;

export function makeReplicationBursts(
	overlay: Overlay,
	tier: number,
	yearMax: number | null
): ReplicationBurstsResult {
	let candidates = collectCandidates(
		overlay,
		tier,
		yearMax == null ? null : yearMax + FADE_BUFFER
	);
	// Pre-allocate generously so setView can usually reuse the buffer
	// without reallocating (cheap path during playback).
	let capacity = Math.max(256, candidates.length * 2);
	let positions = new Float32Array(capacity * 3);
	let triggeredAt = new Float32Array(capacity);
	for (let i = 0; i < capacity; i++) triggeredAt[i] = -1;
	for (let i = 0; i < candidates.length; i++) {
		positions[i * 3 + 0] = candidates[i].pos.x;
		positions[i * 3 + 1] = candidates[i].pos.y;
		positions[i * 3 + 2] = candidates[i].pos.z;
	}

	const geom = new THREE.BufferGeometry();
	let posAttr = new THREE.BufferAttribute(positions, 3);
	geom.setAttribute('position', posAttr);
	let triggeredAttr = new THREE.BufferAttribute(triggeredAt, 1);
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
		setView(o: Overlay, t: number, ym: number | null) {
			// Recompute candidate set without disturbing prevDisplayedYear,
			// so a year-crossing immediately following this call still
			// triggers correctly. Reuses the geometry buffers in place
			// when the new count fits; reallocates only when growing.
			const next = collectCandidates(o, t, ym == null ? null : ym + FADE_BUFFER);
			if (next.length > capacity) {
				capacity = Math.max(capacity * 2, next.length);
				positions = new Float32Array(capacity * 3);
				triggeredAt = new Float32Array(capacity);
				for (let i = 0; i < capacity; i++) triggeredAt[i] = -1;
				posAttr = new THREE.BufferAttribute(positions, 3);
				geom.setAttribute('position', posAttr);
				triggeredAttr = new THREE.BufferAttribute(triggeredAt, 1);
				triggeredAttr.setUsage(THREE.DynamicDrawUsage);
				geom.setAttribute('triggeredAt', triggeredAttr);
			} else {
				// Reset trigger state for slots we're about to overwrite.
				// Candidates that disappear (tier dropped) shouldn't leave
				// ghost rings; new candidates start untriggered.
				for (let i = 0; i < capacity; i++) triggeredAt[i] = -1;
				triggeredAttr.needsUpdate = true;
			}
			for (let i = 0; i < next.length; i++) {
				positions[i * 3 + 0] = next[i].pos.x;
				positions[i * 3 + 1] = next[i].pos.y;
				positions[i * 3 + 2] = next[i].pos.z;
			}
			posAttr.needsUpdate = true;
			geom.setDrawRange(0, next.length);
			candidates = next;
			// prevDisplayedYear deliberately untouched: the next
			// setDisplayedYear call from the playback loop will detect
			// the year-crossing against the value pushed before the
			// view change.
		},
		dispose() {
			geom.dispose();
			material.dispose();
		}
	};
}
