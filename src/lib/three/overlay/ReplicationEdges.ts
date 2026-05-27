import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Overlay } from '$lib/data/overlay';
import type { TierView } from '$lib/data/derive';
import { attachEdgeFade, buildEdgeYearAttribute, EDGE_FADE_BUFFER_YEARS } from '../edgeFade';
import type { EdgeFadeHandle } from '../edgeFade';

/**
 * Replication edges: parent Bob → child Bob, drawn between the two
 * Bobs' origin_system positions. Same-system replications collapse to
 * a single point and are dropped (more naturally a per-system pip,
 * which lands with the info-panel PR). Endpoints that don't resolve
 * to a known spatial system are also dropped — they'll come back
 * with the non-spatial render decision (#14).
 *
 * Rendered with Line2 / LineMaterial so linewidth in pixels is
 * actually respected (LineBasicMaterial.linewidth is ignored on
 * essentially every WebGL implementation).
 */
export interface ReplicationEdgesResult {
	object: LineSegments2;
	setResolution: (w: number, h: number) => void;
	setDisplayedYear: (year: number | null) => void;
	dispose: () => void;
	stats: { drawn: number; dropped: number };
}

export function makeReplicationEdges(
	overlay: Overlay,
	resolution: THREE.Vector2,
	view?: TierView
): ReplicationEdgesResult {
	const positions: number[] = [];
	const years: (number | null)[] = [];
	let drawn = 0;
	let dropped = 0;

	// Fade-buffer: include edges up to (yearMax + EDGE_FADE_BUFFER_YEARS) so
	// newly-included edges have a window to fade through. The shader gates
	// actual visibility per-edge against the continuously-updated
	// displayedYear uniform.
	const yearMaxBuffered =
		view && view.yearMax != null ? view.yearMax + EDGE_FADE_BUFFER_YEARS : null;

	for (const edge of overlay.replication) {
		if (!edge.parent_known || !edge.child_known) {
			dropped++;
			continue;
		}
		if (view) {
			if (edge.first_book == null || edge.first_book > view.tier) {
				dropped++;
				continue;
			}
			if (yearMaxBuffered != null) {
				if (edge.date_year == null || edge.date_year > yearMaxBuffered) {
					dropped++;
					continue;
				}
			}
		}
		const parent = overlay.bobByName(edge.parent);
		const child = overlay.bobByName(edge.child);
		if (!parent || !child) {
			dropped++;
			continue;
		}
		const a = overlay.systems.get(parent.origin_system);
		const b = overlay.systems.get(child.origin_system);
		if (!a || !b || a.name === b.name) {
			dropped++;
			continue;
		}
		positions.push(a.xyz[0], a.xyz[1], a.xyz[2], b.xyz[0], b.xyz[1], b.xyz[2]);
		years.push(edge.date_year);
		drawn++;
	}

	const geom = new LineSegmentsGeometry();
	geom.setPositions(positions);
	geom.setAttribute('instanceEdgeYear', buildEdgeYearAttribute(years));
	const mat = new LineMaterial({
		color: 0x9b7cff,
		linewidth: 1.5,
		transparent: true,
		opacity: 0.85,
		depthTest: false,
		resolution
	});
	const fade: EdgeFadeHandle = attachEdgeFade(mat);
	const object = new LineSegments2(geom, mat);
	object.renderOrder = 1;
	object.computeLineDistances();

	return {
		object,
		stats: { drawn, dropped },
		setResolution(w: number, h: number) {
			mat.resolution.set(w, h);
		},
		setDisplayedYear(year: number | null) {
			fade.setDisplayedYear(year);
		},
		dispose() {
			geom.dispose();
			mat.dispose();
		}
	};
}
