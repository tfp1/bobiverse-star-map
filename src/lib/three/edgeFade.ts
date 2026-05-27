import * as THREE from 'three';
import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';

/**
 * Per-edge fade-in animation hook for LineSegments2 / LineMaterial.
 *
 * In Timeline mode, edges whose in-world year is at or just past the
 * scrubber should fade in smoothly rather than pop. We attach a
 * per-instance `instanceEdgeYear` attribute to the geometry and
 * inject a `uDisplayedYear` uniform into the fragment shader; alpha
 * is multiplied by smoothstep(year, year + window, displayedYear).
 *
 * Sentinel: uDisplayedYear < 0 → no fade (Explore mode, full opacity).
 * The geometry should be built with edges up to (yearMax + buffer)
 * so newly-included edges have a window to fade through.
 */

export const EDGE_FADE_WINDOW_YEARS = 1.5;
/** Include edges this far past yearMax in the buffer so they have a fade window. */
export const EDGE_FADE_BUFFER_YEARS = 3;

export interface EdgeFadeHandle {
	setDisplayedYear: (year: number | null) => void;
	setFlow: (offsetWorldUnits: number) => void;
}

interface FadeUniforms {
	uDisplayedYear: { value: number };
	uFadeWindow: { value: number };
}

export function attachEdgeFade(material: LineMaterial): EdgeFadeHandle {
	const uniforms: FadeUniforms = {
		uDisplayedYear: { value: -1 }, // sentinel: no fade
		uFadeWindow: { value: EDGE_FADE_WINDOW_YEARS }
	};

	const prev = material.onBeforeCompile;
	material.onBeforeCompile = (shader, renderer) => {
		if (prev) prev.call(material, shader, renderer);
		shader.uniforms.uDisplayedYear = uniforms.uDisplayedYear;
		shader.uniforms.uFadeWindow = uniforms.uFadeWindow;

		shader.vertexShader = shader.vertexShader.replace(
			'void main() {',
			`attribute float instanceEdgeYear;
varying float vEdgeYear;
void main() {
	vEdgeYear = instanceEdgeYear;`
		);

		shader.fragmentShader = shader.fragmentShader
			.replace(
				'uniform float opacity;',
				`uniform float opacity;
uniform float uDisplayedYear;
uniform float uFadeWindow;
varying float vEdgeYear;`
			)
			.replace(
				'gl_FragColor = vec4( diffuseColor.rgb, alpha );',
				`float edgeFade = uDisplayedYear < 0.0 ? 1.0
	: smoothstep( vEdgeYear - 0.05, vEdgeYear + uFadeWindow, uDisplayedYear );
if ( edgeFade < 0.001 ) discard;
gl_FragColor = vec4( diffuseColor.rgb, alpha * edgeFade );`
			);
	};

	// Force recompile if the material has already been used.
	material.needsUpdate = true;

	return {
		setDisplayedYear(year: number | null) {
			uniforms.uDisplayedYear.value = year == null ? -1 : year;
		},
		setFlow(offsetWorldUnits: number) {
			// Update LineMaterial's dashOffset for animated travel flow.
			// Negative offset = dashes appear to march from start to end.
			(material as unknown as { dashOffset: number }).dashOffset = offsetWorldUnits;
		}
	};
}

/**
 * Build an InstancedBufferAttribute carrying one year value per edge
 * (i.e., one per LineSegments2 instance). Edges with null year get
 * the sentinel -Infinity so they're always visible (fully faded in).
 */
export function buildEdgeYearAttribute(years: (number | null)[]): THREE.InstancedBufferAttribute {
	const arr = new Float32Array(years.length);
	for (let i = 0; i < years.length; i++) {
		arr[i] = years[i] == null ? -1e9 : years[i]!;
	}
	return new THREE.InstancedBufferAttribute(arr, 1);
}
