/**
 * Parse the stars-near.bin file shipped under static/.
 *
 * Format (decoded in handoff §2):
 *   - uint32 LE record count at offset 0
 *   - then count × 5×float32 LE records (20 bytes each):
 *       [0] x parsec  [1] y parsec  [2] z parsec  (heliocentric, Sol at origin)
 *       [3] M_G absolute magnitude (faint limit ~13)
 *       [4] BP-RP colour index (-0.54 .. 4.58)
 *
 * Returns flat Float32Array views suitable for direct upload as
 * BufferAttributes (no per-record object allocation).
 */

export interface StarField {
	count: number;
	positions: Float32Array; // 3 × count, [x0,y0,z0,x1,y1,z1,...]
	absMag: Float32Array; // count
	bpRp: Float32Array; // count
}

export async function loadStarsBin(url: string): Promise<StarField> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
	const buf = await res.arrayBuffer();
	const view = new DataView(buf);

	const count = view.getUint32(0, true);
	const expected = 4 + count * 20;
	if (buf.byteLength !== expected) {
		throw new Error(
			`stars-near.bin size mismatch: header says ${count} records (${expected} bytes) but file is ${buf.byteLength} bytes`
		);
	}

	const positions = new Float32Array(count * 3);
	const absMag = new Float32Array(count);
	const bpRp = new Float32Array(count);

	let off = 4;
	for (let i = 0; i < count; i++) {
		positions[i * 3] = view.getFloat32(off, true);
		positions[i * 3 + 1] = view.getFloat32(off + 4, true);
		positions[i * 3 + 2] = view.getFloat32(off + 8, true);
		absMag[i] = view.getFloat32(off + 12, true);
		bpRp[i] = view.getFloat32(off + 16, true);
		off += 20;
	}

	return { count, positions, absMag, bpRp };
}
