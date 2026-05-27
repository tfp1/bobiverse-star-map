import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Overlay } from '$lib/data/overlay';
import { travelDestinationName } from '$lib/data/overlay';
import type { TierView } from '$lib/data/derive';
import { attachEdgeFade, buildEdgeYearAttribute, EDGE_FADE_BUFFER_YEARS } from '../edgeFade';
import type { EdgeFadeHandle } from '../edgeFade';

/**
 * Travel edges: per-Bob, the chronologically-ordered chain of system
 * positions the Bob visits. Drawn as line segments between adjacent
 * itinerary stops rather than parent→child arcs because travel is a
 * sequence, not a tree.
 *
 * Off-map and unresolved destinations are dropped upstream in
 * buildItineraries — they need the non-spatial render decision
 * (#14) before they can be drawn.
 */
export interface TravelEdgesResult {
	object: LineSegments2;
	setResolution: (w: number, h: number) => void;
	setDisplayedYear: (year: number | null) => void;
	/** Tick the dash-flow animation each frame. dt in seconds. */
	tickFlow: (dt: number) => void;
	dispose: () => void;
	stats: { drawn: number };
}

interface TravelLeg {
	from: string;
	to: string;
	year: number | null;
}

/**
 * Recompute per-Bob itineraries restricted to travel edges with
 * `first_book <= view.tier`. Mirrors overlay.buildItineraries but
 * adds the tier gate; the unfiltered version remains cached on the
 * overlay for the no-tier path. Returns flat legs with per-leg year
 * so the renderer can fade each segment in independently.
 */
function buildLegsAtTier(overlay: Overlay, view: TierView): TravelLeg[] {
	const yearMaxBuffered =
		view.yearMax != null ? view.yearMax + EDGE_FADE_BUFFER_YEARS : null;
	const byBobId = new Map<string, typeof overlay.travel>();
	for (const t of overlay.travel) {
		if (!t.bob_known) continue;
		const destName = travelDestinationName(t);
		if (destName == null) continue;
		if (!overlay.resolveSystem(destName)) continue;
		if (t.first_book == null || t.first_book > view.tier) continue;
		if (yearMaxBuffered != null) {
			if (t.date_year == null || t.date_year > yearMaxBuffered) continue;
		}
		const primary = overlay.bobByName(t.bob);
		if (!primary) continue;
		if (!view.bobVisible(primary.name)) continue;
		const list = byBobId.get(primary.id) ?? [];
		list.push(t);
		byBobId.set(primary.id, list);
	}
	const legs: TravelLeg[] = [];
	for (const bob of overlay.bobs) {
		if (!view.bobVisible(bob.name)) continue;
		const travels = byBobId.get(bob.id);
		if (!travels) continue;
		travels.sort((a, b) => (a.reading_order ?? 0) - (b.reading_order ?? 0));
		let prev: string | null = overlay.resolveSystem(bob.origin_system) ? bob.origin_system : null;
		for (const t of travels) {
			const dest = travelDestinationName(t);
			if (dest == null) continue;
			if (prev != null && prev !== dest) {
				legs.push({ from: prev, to: dest, year: t.date_year });
			}
			prev = dest;
		}
	}
	return legs;
}

/** Fallback for Explore mode (no tier/year gating): build legs with null years. */
function buildAllLegs(overlay: Overlay): TravelLeg[] {
	const legs: TravelLeg[] = [];
	for (const seq of overlay.bobItinerary.values()) {
		for (let i = 0; i + 1 < seq.length; i++) {
			legs.push({ from: seq[i], to: seq[i + 1], year: null });
		}
	}
	return legs;
}

export function makeTravelEdges(
	overlay: Overlay,
	resolution: THREE.Vector2,
	view?: TierView
): TravelEdgesResult {
	const positions: number[] = [];
	const years: (number | null)[] = [];
	let drawn = 0;

	const legs: TravelLeg[] = view ? buildLegsAtTier(overlay, view) : buildAllLegs(overlay);
	for (const leg of legs) {
		const a = overlay.resolveSystem(leg.from);
		const b = overlay.resolveSystem(leg.to);
		if (!a || !b) continue;
		positions.push(a.xyz[0], a.xyz[1], a.xyz[2], b.xyz[0], b.xyz[1], b.xyz[2]);
		years.push(leg.year);
		drawn++;
	}

	const geom = new LineSegmentsGeometry();
	geom.setPositions(positions);
	geom.setAttribute('instanceEdgeYear', buildEdgeYearAttribute(years));
	const mat = new LineMaterial({
		color: 0xffb15c,
		linewidth: 1.5,
		transparent: true,
		opacity: 0.95,
		depthTest: false,
		resolution,
		dashed: true,
		dashSize: 0.6,
		gapSize: 0.4,
		dashScale: 1
	});
	const fade: EdgeFadeHandle = attachEdgeFade(mat);
	const object = new LineSegments2(geom, mat);
	object.renderOrder = 2; // above replication so travel reads as the "active" path
	object.computeLineDistances();

	// Dash flow speed: world units per second along the line. Negative
	// `dashOffset` makes dashes appear to march from `from` to `to`
	// because LineMaterial measures distance from segment start.
	const FLOW_SPEED = 0.55;
	let dashOffset = 0;

	return {
		object,
		stats: { drawn },
		setResolution(w: number, h: number) {
			mat.resolution.set(w, h);
		},
		setDisplayedYear(year: number | null) {
			fade.setDisplayedYear(year);
		},
		tickFlow(dt: number) {
			dashOffset -= FLOW_SPEED * dt;
			fade.setFlow(dashOffset);
		},
		dispose() {
			geom.dispose();
			mat.dispose();
		}
	};
}
