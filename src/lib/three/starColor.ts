/**
 * BP-RP colour index → linear RGB.
 *
 * BP-RP is roughly equivalent to B-V: negative = hot blue stars,
 * positive = cool red stars. The full Gaia range is about [-0.54, 4.58];
 * we map it through a piecewise ramp that picks reasonable
 * star colours rather than a full black-body curve (which would render
 * cool stars nearly invisible against a dark backdrop).
 *
 * Stops are tuned to roughly match the colours used in gaia-mary's
 * Color mode (eyeballed): blue-white at hot, white-ish at G2-like,
 * warm orange at K, deep orange-red at M.
 */

interface Stop {
	bpRp: number;
	r: number;
	g: number;
	b: number;
}

const STOPS: Stop[] = [
	{ bpRp: -0.5, r: 0.6, g: 0.75, b: 1.0 }, // hot blue (O/B)
	{ bpRp: 0.0, r: 0.85, g: 0.92, b: 1.0 }, // A
	{ bpRp: 0.5, r: 1.0, g: 1.0, b: 0.95 }, // F
	{ bpRp: 0.85, r: 1.0, g: 0.97, b: 0.85 }, // G2 (Sun-like)
	{ bpRp: 1.3, r: 1.0, g: 0.82, b: 0.6 }, // K
	{ bpRp: 2.0, r: 1.0, g: 0.6, b: 0.35 }, // early M
	{ bpRp: 3.5, r: 1.0, g: 0.4, b: 0.2 } // late M
];

export function bpRpToRgb(bpRp: number, out: Float32Array, offset: number): void {
	if (bpRp <= STOPS[0].bpRp) {
		out[offset] = STOPS[0].r;
		out[offset + 1] = STOPS[0].g;
		out[offset + 2] = STOPS[0].b;
		return;
	}
	const last = STOPS[STOPS.length - 1];
	if (bpRp >= last.bpRp) {
		out[offset] = last.r;
		out[offset + 1] = last.g;
		out[offset + 2] = last.b;
		return;
	}
	for (let i = 1; i < STOPS.length; i++) {
		const hi = STOPS[i];
		if (bpRp < hi.bpRp) {
			const lo = STOPS[i - 1];
			const t = (bpRp - lo.bpRp) / (hi.bpRp - lo.bpRp);
			out[offset] = lo.r + t * (hi.r - lo.r);
			out[offset + 1] = lo.g + t * (hi.g - lo.g);
			out[offset + 2] = lo.b + t * (hi.b - lo.b);
			return;
		}
	}
}
