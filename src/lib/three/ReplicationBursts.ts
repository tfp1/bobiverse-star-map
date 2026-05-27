import * as THREE from 'three';
import type { Overlay } from '$lib/data/overlay';
import type { ReplicationEdge } from '$lib/data/types';

/**
 * Transient ring-flash at the child Bob's spawn position when a
 * replication edge crosses the scrubber year. Reads as "a Bob was
 * born here" in Timeline mode without needing text.
 *
 * Each burst is a small instanced quad rendered through an additive
 * shader; lifetime ~1.5 s, fades from full to zero, scale eases out.
 * The set of bursts in flight is rebuilt whenever applyView changes
 * (so e.g. scrubbing back resets them); per-frame we just tick t/lifetime.
 */

export const BURST_LIFETIME_S = 1.5;
const RING_INNER = 0.35;
const RING_OUTER = 0.5;
const START_RADIUS_PC = 0.2;
const END_RADIUS_PC = 1.4;
const COLOR = 0xd3c0ff; // soft lavender — adjacent to the replication-edge color

export interface ReplicationBurstsResult {
	object: THREE.Points;
	setDisplayedYear: (year: number | null) => void;
	dispose: () => void;
}

interface Burst {
	pos: THREE.Vector3;
	year: number;
}

interface BuildArgs {
	overlay: Overlay;
	bursts: Burst[];
}

function collectBursts(overlay: Overlay, tier: number, yearMaxBuffered: number | null): Burst[] {
	const out: Burst[] = [];
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
	const bursts = collectBursts(overlay, tier, yearMaxBuffered);

	const N = Math.max(1, bursts.length);
	const positions = new Float32Array(N * 3);
	const burstYears = new Float32Array(N);
	for (let i = 0; i < bursts.length; i++) {
		positions[i * 3 + 0] = bursts[i].pos.x;
		positions[i * 3 + 1] = bursts[i].pos.y;
		positions[i * 3 + 2] = bursts[i].pos.z;
		burstYears[i] = bursts[i].year;
	}

	const geom = new THREE.BufferGeometry();
	geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
	geom.setAttribute('burstYear', new THREE.BufferAttribute(burstYears, 1));
	geom.setDrawRange(0, bursts.length);

	const material = new THREE.ShaderMaterial({
		uniforms: {
			uDisplayedYear: { value: -1 },
			uLifetime: { value: BURST_LIFETIME_S },
			uPixelRatio: { value: window.devicePixelRatio },
			uHeight: { value: window.innerHeight },
			uColor: { value: new THREE.Color(COLOR) },
			uStartRadius: { value: START_RADIUS_PC },
			uEndRadius: { value: END_RADIUS_PC }
		},
		vertexShader: /* glsl */ `
			attribute float burstYear;
			varying float vAge;
			uniform float uDisplayedYear;
			uniform float uLifetime;
			uniform float uPixelRatio;
			uniform float uHeight;
			uniform float uStartRadius;
			uniform float uEndRadius;
			void main() {
				// Age in seconds-since-burst, assuming the scrubber's "1 year"
				// of in-world time maps to 1 second of burst lifetime when
				// scrubbing slowly. The shader doesn't see playback speed
				// directly — it just computes a 0..1 progress over the
				// fade window.
				vAge = uDisplayedYear - burstYear; // in years
				vec4 mv = modelViewMatrix * vec4(position, 1.0);
				gl_Position = projectionMatrix * mv;
				float scale = uHeight * projectionMatrix[1][1] * 0.5;
				// Ring radius grows from start to end over the lifetime
				float t = clamp(vAge / uLifetime, 0.0, 1.0);
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
				float d = length(uv) * 2.0; // 0..~1
				// Ring band centred at 0.85 of the sprite, widening with t
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

	return {
		object,
		setDisplayedYear(year: number | null) {
			material.uniforms.uDisplayedYear.value = year == null ? -1 : year;
		},
		dispose() {
			geom.dispose();
			material.dispose();
		}
	};
}
