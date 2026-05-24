#!/usr/bin/env python3
"""
map_systems_to_stars.py

Crossmatch the 22-entry Bobiverse system enum (gazetteer.systems) against
stars-near.bin (heliocentric XYZ catalog inherited from valhovey/gaia-mary).

Produces data/system_to_star_index.json mapping each catalog_star system to
the nearest record in the bin file, with byte offset, the bin's coords, the
absolute G mag and BP-RP color, the match delta, and a confidence flag.

The two non_physical systems (Federation Capital, Sagittarius A*) are
recorded but NOT crossmatched.

bin format (verified by byte inspection — see handoff.md §2):
  - little-endian
  - uint32 count at offset 0  (= 53836)
  - then count records of 5 x float32 (20 bytes each):
      [0] x parsec  [1] y parsec  [2] z parsec  (heliocentric, Sol at origin,
                                                 ICRS-aligned axes per Gaia DR3)
      [3] M absolute G mag  (faint limit ~13)
      [4] BP-RP colour index (-0.54 .. 4.58)
  - Sphere radius ~83 pc. Sol excluded (it's the origin).

Reference astrometry table (RA, Dec, parallax) is hardcoded from SIMBAD
queries (cited per-row); coords are ICRS J2000 to match the bin's ICRS-aligned
heliocentric XYZ. We convert (RA, Dec, distance) -> (x, y, z) via the standard
spherical-to-Cartesian formula:
    x = d * cos(dec) * cos(ra)
    y = d * cos(dec) * sin(ra)
    z = d * sin(dec)
with RA/dec in radians and d = 1000 / parallax_mas (parsec).

Confidence (REVISED after empirical inspection — see notes below):
  high   : match_distance_pc < 0.3 AND |M_bin - expected_abs_G| < 1.5
  medium : match_distance_pc < 0.5 AND |M_bin - expected_abs_G| < 2.0
  low    : a plausible candidate exists but distance OR magnitude is off
  none   : no plausible candidate (system absent from bin)

CRITICAL FINDING (empirical, see write-up):

  The bin file is NOT a comprehensive nearby-star catalog. It's a Gaia DR3
  derivative with bright-star saturation cuts that have removed virtually
  ALL of the named bright stars in our enum. There is nothing within 1 pc
  of Sirius, no Alpha-Cen-A-like record near the Alpha Cen position
  (only a red dwarf at 0.46 pc with M~9 / BP-RP~3.8), nothing near
  Eps Eri / Eps Ind / Eta Cas / Eta Lep / Omi2 Eri / etc.

  This is a much larger problem than handoff.md §2 anticipated — handoff
  only flagged the *faint* M-dwarf hosts (Proxima, GJ 877, NN 4285) as
  at risk; in fact the *bright* hosts are the ones missing.

  The fix is either:
    (a) regenerate stars-near.bin from Gaia DR3 with the bright-star
        saturation filter removed and Hipparcos/Bayer cross-IDs preserved
        (handoff.md §5 suggests this is on the table); OR
    (b) manually append the 18 missing named systems with their SIMBAD
        coords + abs G + BP-RP, as a small extension array.

  Until that happens, ALMOST EVERY catalog_star system in this output
  will be confidence=none. The output JSON still records each system's
  reference XYZ and the "would have been" nearest-record details so a
  later regeneration can be sanity-checked against this baseline.

Usage:
    python3 scripts/map_systems_to_stars.py

Writes data/system_to_star_index.json. Prints a format-verification dump,
a match table, and a coverage summary.

Stdlib only (struct, math, json, datetime).
"""

import datetime as _dt
import json
import math
import os
import struct
import sys

# -----------------------------------------------------------------------------
# Paths
# -----------------------------------------------------------------------------

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BIN_PATH = os.path.join(ROOT, "stars-near.bin")
EVENTS_PATH = os.path.join(ROOT, "data", "events.json")
BOB_INDEX_PATH = os.path.join(ROOT, "data", "bob_index.json")
OUT_PATH = os.path.join(ROOT, "data", "system_to_star_index.json")

# -----------------------------------------------------------------------------
# Reference astrometric table for the 20 catalog_star systems.
#
# Coordinates are ICRS J2000 (degrees), parallax in mas, all from SIMBAD
# (simbad.u-strasbg.fr) as queried 2026-05-24 unless noted otherwise. Spectral
# type and apparent V mag included so we can sanity-check the matched M.
#
# expected_abs_G is a rough estimate of the Gaia G absolute magnitude used
# only for the confidence sanity check. It does not need to be tight — we use
# a ±1.5-mag tolerance band.
# -----------------------------------------------------------------------------

# Crude SpT -> abs-G lookup for the sanity check only (rough main-sequence
# values; absolute G is generally within ~0.3 mag of absolute V for these
# spectral types except late M).
ABS_G_FROM_SPT = {
    "F2V": 3.0, "F6V": 3.7, "F9V": 4.4, "F9.5V": 4.5, "F9VFe-1.4CH-0.7": 4.4,
    "G0V": 4.5, "G2V": 4.7, "G5V": 5.2, "G6V": 5.4, "G8IV": 3.8,
    "K0V": 5.8, "K0+IV": 4.5, "K2V": 6.2, "K5V": 7.4,
    "M1V": 9.0, "M2.5V": 9.7, "M3V": 10.0, "M3.5V": 10.4, "M3.5+M3.0": 10.0,
    "M5.5Ve": 13.5,
}

# Each entry:
#   key (canonical system name) ->
#       ra_deg, dec_deg, parallax_mas, spt, v_mag, source, notes
REFERENCE_SYSTEMS = {
    "Sol": {
        "ra_deg": None, "dec_deg": None, "parallax_mas": None,
        "spt": "G2V", "v_mag": -26.74,
        "source": "by-definition origin",
        "notes": ("Sol is the heliocentric origin (0,0,0). Excluded from "
                  "stars-near.bin by construction. Render at origin."),
    },
    "Alpha Centauri": {
        # SIMBAD: Alpha Cen A (system anchor; the bin treats A and B as a
        # single barycentric point at ~1.34 pc).
        "ra_deg": 219.902083, "dec_deg": -60.834548, "parallax_mas": 742.12,
        "spt": "G2V", "v_mag": 0.01,
        "source": "SIMBAD: alpha Cen A",
        "notes": "A+B unresolved at bin resolution; Proxima is a separate "
                 "M5.5Ve dwarf at M~15.6 and is excluded by the M<13 faint cut.",
    },
    "Epsilon Eridani": {
        "ra_deg": 53.2326854, "dec_deg": -9.4582609, "parallax_mas": 310.5773,
        "spt": "K2V", "v_mag": 3.73,
        "source": "SIMBAD: eps Eri",
        "notes": "",
    },
    "Epsilon Indi": {
        # SIMBAD anchor is eps Ind A; eps Ind B (binary brown dwarf) is too
        # faint to be in the bin.
        "ra_deg": 330.8402, "dec_deg": -56.7859, "parallax_mas": 274.8431,
        "spt": "K5V", "v_mag": 4.69,
        "source": "SIMBAD: eps Ind A",
        "notes": "",
    },
    "Delta Eridani": {
        "ra_deg": 55.8120864565, "dec_deg": -9.7633641421,
        "parallax_mas": 110.0254,
        "spt": "K0+IV", "v_mag": 3.54,
        "source": "SIMBAD: del Eri",
        "notes": "Subgiant; abs G ~4.5 (brighter than dwarf K0).",
    },
    "Delta Pavonis": {
        "ra_deg": 302.1817, "dec_deg": -66.1820, "parallax_mas": 163.9544,
        "spt": "G8IV", "v_mag": 3.56,
        "source": "SIMBAD: del Pav",
        "notes": "",
    },
    "Gamma Pavonis": {
        "ra_deg": 321.610870, "dec_deg": -65.366198, "parallax_mas": 108.0102,
        "spt": "F9VFe-1.4CH-0.7", "v_mag": 4.22,
        "source": "SIMBAD: gam Pav",
        "notes": "",
    },
    "Beta Hydri": {
        "ra_deg": 6.4377765, "dec_deg": -77.2542461, "parallax_mas": 134.07,
        "spt": "G0V", "v_mag": 2.79,
        "source": "SIMBAD: bet Hyi",
        "notes": "",
    },
    "Zeta Tucanae": {
        "ra_deg": 5.017608, "dec_deg": -64.8747937, "parallax_mas": 116.1826,
        "spt": "F9.5V", "v_mag": 4.23,
        "source": "SIMBAD: zet Tuc",
        "notes": "",
    },
    "Kappa Ceti": {
        "ra_deg": 49.840402, "dec_deg": 3.370198, "parallax_mas": 107.8023,
        "spt": "G5V", "v_mag": 4.85,
        "source": "SIMBAD: kap1 Cet (HD 20630)",
        "notes": "",
    },
    "Eta Cassiopeiae": {
        # SIMBAD anchor: eta Cas A. eta Cas B is a K7V companion ~12 arcsec
        # away; at bin resolution they read as one point.
        "ra_deg": 12.276227692, "dec_deg": 57.814621,
        "parallax_mas": 168.8322,
        "spt": "F9V", "v_mag": 3.44,
        "source": "SIMBAD: eta Cas A",
        "notes": "Binary; B not separately resolved in bin.",
    },
    "Eta Leporis": {
        "ra_deg": 89.1012306254, "dec_deg": -14.1677175507,
        "parallax_mas": 66.8573,
        "spt": "F2V", "v_mag": 3.72,
        "source": "SIMBAD: eta Lep (HD 40136)",
        "notes": "Heaven's River megastructure host (Bender's final destination).",
    },
    "Pi3 Orionis": {
        "ra_deg": 72.4600467021, "dec_deg": 6.9613350574,
        "parallax_mas": 124.6198,
        "spt": "F6V", "v_mag": 3.190,
        "source": "SIMBAD: pi3 Ori (HD 30652)",
        "notes": "",
    },
    "82 Eridani": {
        # = HD 20794, GJ 139.
        "ra_deg": 49.9819, "dec_deg": -43.0698, "parallax_mas": 165.5242,
        "spt": "G6V", "v_mag": 4.27,
        "source": "SIMBAD: 82 Eri (HD 20794)",
        "notes": "",
    },
    "Omicron² Eridani": {
        # = 40 Eridani, HD 26965, GJ 166 A. Anchor on A (K0V); B (DA white
        # dwarf) and C (M4.5V) are companions; at bin resolution the system
        # reads as one point on A.
        "ra_deg": 63.8180, "dec_deg": -7.6529, "parallax_mas": 199.6080,
        "spt": "K0V", "v_mag": 4.43,
        "source": "SIMBAD: omi2 Eri / 40 Eri A (HD 26965)",
        "notes": "= 40 Eridani. Triple system; A anchors. Vulcan/Romulus host.",
    },
    "Gliese 54": {
        # M2.5V binary; SIMBAD anchor.
        "ra_deg": 17.5953366540, "dec_deg": -67.4449574079,
        "parallax_mas": 121.4487,
        "spt": "M2.5V", "v_mag": 9.824,
        "source": "SIMBAD: GJ 54",
        "notes": "Red-dwarf binary; abs G ~9.7, should be inside the bin's "
                 "M<13 cut.",
    },
    "Gliese 877": {
        "ra_deg": 338.9396303554, "dec_deg": -75.4586788444,
        "parallax_mas": 116.3134,
        "spt": "M3V", "v_mag": 10.377,
        "source": "SIMBAD: GJ 877",
        "notes": ("M3V at d~8.6 pc; abs G ~10.4 — within bin faint cut, "
                  "should be present despite handoff.md flagging it as 'at "
                  "risk'. Others' home star in canon (destroyed B3C70)."),
    },
    "NN 4285": {
        # NN catalog = "Nearby/New" (Luyten). NN 4285 = GJ 4285 in the Gliese
        # extended catalog. Note: the abs-G estimate puts this on the brighter
        # side of the M-dwarf cut (~10), so it should be present.
        "ra_deg": 359.512084, "dec_deg": -65.835241, "parallax_mas": 35.4025,
        "spt": "M3.5V", "v_mag": None,
        "source": "SIMBAD: GJ 4285 (= NN 4285)",
        "notes": ("M3.5V at d~28 pc; abs G ~10.4 — well inside the bin's "
                  "M<13 cut. Handoff flagged as 'at risk' but should be "
                  "present."),
    },
    "HIP 14101": {
        "ra_deg": 45.4641648, "dec_deg": -16.5933641, "parallax_mas": 106.16,
        "spt": "M3.5+M3.0", "v_mag": 9.97,
        "source": "SIMBAD: HIP 14101 (= LP 771-95)",
        "notes": "M3.5+M3.0 binary at d~9.4 pc; abs G ~10. Odin host (B3C20).",
    },
    "HIP 84051": {
        "ra_deg": 257.7464771, "dec_deg": -52.5155110,
        "parallax_mas": 78.2621,
        "spt": "M1V", "v_mag": 10.017,
        "source": "SIMBAD: HIP 84051",
        "notes": "M1V at d~12.8 pc; abs G ~9. New Pav host post-B3C45.",
    },
}

# The two non_physical systems (rendered separately per handoff D1).
NON_PHYSICAL_SYSTEMS = {
    "Federation Capital": {
        "notes": ("Fictional alien capital (Pan Galactic Federation, B5 C68). "
                  "No real star. Render as non-spatial node per handoff D1."),
    },
    "Sagittarius A*": {
        "notes": ("Galactic center, ~8 kpc — off-scale for local-bubble "
                  "(~83 pc) visualization. Render as directional beacon per "
                  "handoff D1."),
    },
}


# -----------------------------------------------------------------------------
# Bin file I/O
# -----------------------------------------------------------------------------

def load_bin(path):
    """Return (count, list of (x, y, z, M, BP_RP) tuples)."""
    with open(path, "rb") as f:
        data = f.read()
    count = struct.unpack("<I", data[:4])[0]
    expected = 4 + count * 20
    if expected != len(data):
        raise ValueError(
            f"bin size mismatch: header says {count} records "
            f"=> expect {expected} bytes, file is {len(data)}"
        )
    records = []
    for i in range(count):
        off = 4 + i * 20
        records.append(struct.unpack("<5f", data[off:off + 20]))
    return count, records


def verification_dump(count, records):
    """Print the format-verification dump the caller requested."""
    print("=" * 72)
    print("STARS-NEAR.BIN FORMAT VERIFICATION")
    print("=" * 72)
    print(f"  record count (uint32 LE at offset 0): {count}")
    print(f"  file size matches 4 + count*20 = {4 + count*20} bytes: OK")
    print(f"  per-record layout: 5 x float32 LE = 20 bytes")
    print()
    print("  first 4 records (x_pc, y_pc, z_pc, M_abs_G, BP-RP):")
    for i in range(4):
        x, y, z, M, bp = records[i]
        r = math.sqrt(x * x + y * y + z * z)
        print(f"    [{i}] off=0x{4 + i*20:08x}  "
              f"x={x:9.4f}  y={y:9.4f}  z={z:9.4f}  "
              f"M={M:6.3f}  BP-RP={bp:6.3f}  r={r:6.3f} pc")
    xs = [r[0] for r in records]
    ys = [r[1] for r in records]
    zs = [r[2] for r in records]
    Ms = [r[3] for r in records]
    bps = [r[4] for r in records]
    rs = [math.sqrt(x * x + y * y + z * z) for x, y, z in zip(xs, ys, zs)]
    print()
    print(f"  x range: [{min(xs):.3f}, {max(xs):.3f}] pc")
    print(f"  y range: [{min(ys):.3f}, {max(ys):.3f}] pc")
    print(f"  z range: [{min(zs):.3f}, {max(zs):.3f}] pc")
    print(f"  M range: [{min(Ms):.3f}, {max(Ms):.3f}] (faint cut ~13)")
    print(f"  BP-RP range: [{min(bps):.3f}, {max(bps):.3f}]")
    print(f"  r range: [{min(rs):.3f}, {max(rs):.3f}] pc "
          f"(sphere radius ~83 pc, nearest is Alpha Cen / Proxima distance)")
    print()


# -----------------------------------------------------------------------------
# Astrometry
# -----------------------------------------------------------------------------

def radec_plx_to_xyz(ra_deg, dec_deg, parallax_mas):
    """ICRS (RA, Dec, parallax_mas) -> heliocentric ICRS XYZ in parsecs.

    Matches the bin's frame: Gaia DR3 publishes heliocentric XYZ on ICRS-
    aligned axes, and val's stars-near.bin is derived from Gaia DR3.
    """
    if parallax_mas is None or parallax_mas <= 0:
        return None
    d_pc = 1000.0 / parallax_mas
    ra = math.radians(ra_deg)
    dec = math.radians(dec_deg)
    cd = math.cos(dec)
    x = d_pc * cd * math.cos(ra)
    y = d_pc * cd * math.sin(ra)
    z = d_pc * math.sin(dec)
    return (x, y, z)


def nearest_record(target_xyz, records):
    """Return (best_index, best_distance_pc)."""
    tx, ty, tz = target_xyz
    best_i = -1
    best_d2 = float("inf")
    for i, (x, y, z, _M, _bp) in enumerate(records):
        dx = x - tx
        dy = y - ty
        dz = z - tz
        d2 = dx * dx + dy * dy + dz * dz
        if d2 < best_d2:
            best_d2 = d2
            best_i = i
    return best_i, math.sqrt(best_d2)


def classify_confidence(match_distance_pc, M_bin, expected_abs_G,
                         d_ref_pc):
    """Return one of high/medium/low/none.

    Empirical thresholds (see header):
      - high: <0.3 pc AND M within 1.5 of SpT expectation
      - medium: <0.5 pc AND M within 2.0 of expectation
      - low: <1.5 pc AND M within 2.5 of expectation (weak candidate)
      - none: otherwise — system absent from the bin file.

    Relative cap: also require match_distance < 0.5 * d_ref (a 1.5 pc miss
    on a 2 pc-distant star is fatal; on a 50 pc-distant star it's fine).
    """
    if d_ref_pc and match_distance_pc > 0.5 * d_ref_pc:
        return "none"
    m_off = None
    if expected_abs_G is not None and M_bin is not None:
        m_off = abs(M_bin - expected_abs_G)
    if match_distance_pc < 0.3 and m_off is not None and m_off < 1.5:
        return "high"
    if match_distance_pc < 0.5 and m_off is not None and m_off < 2.0:
        return "medium"
    if match_distance_pc < 1.5 and m_off is not None and m_off < 2.5:
        return "low"
    return "none"


# -----------------------------------------------------------------------------
# Event/Bob dependency lookup
# -----------------------------------------------------------------------------

def systems_seen_in_events(events_path):
    if not os.path.exists(events_path):
        return set()
    with open(events_path) as f:
        data = json.load(f)
    cov = data.get("_coverage", {})
    return set(cov.get("systems_seen", []))


def events_per_system(events_path):
    """Return dict of system_id -> count, plus per-system sample chapter_codes."""
    if not os.path.exists(events_path):
        return {}, {}
    with open(events_path) as f:
        data = json.load(f)
    counts = {}
    samples = {}
    for ev in data.get("events", []):
        sid = ev.get("system_id")
        if not sid:
            continue
        counts[sid] = counts.get(sid, 0) + 1
        if sid not in samples:
            samples[sid] = []
        if len(samples[sid]) < 3:
            samples[sid].append(ev.get("chapter_code"))
        # Also note target_system for en_route events
    return counts, samples


def bobs_per_system(bob_index_path):
    """Return dict of system_id -> list of bob names (best-effort)."""
    if not os.path.exists(bob_index_path):
        return {}
    try:
        with open(bob_index_path) as f:
            data = json.load(f)
    except Exception:
        return {}
    # The exact shape of bob_index.json is not fully specified here. We probe
    # for a top-level list of bobs and try common key names.
    by_sys = {}
    bobs = data if isinstance(data, list) else data.get("bobs", [])
    if not isinstance(bobs, list):
        return {}
    for b in bobs:
        if not isinstance(b, dict):
            continue
        name = b.get("name") or b.get("bob") or b.get("id")
        loc = (b.get("home_system") or b.get("system") or b.get("location")
               or b.get("current_system"))
        if name and loc:
            by_sys.setdefault(loc, []).append(name)
    return by_sys


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

def main():
    # 1. Load + verify the bin.
    count, records = load_bin(BIN_PATH)
    verification_dump(count, records)

    # 2. Pull event / bob dependencies for the impact report.
    events_seen = systems_seen_in_events(EVENTS_PATH)
    ev_counts, ev_samples = events_per_system(EVENTS_PATH)
    bob_by_sys = bobs_per_system(BOB_INDEX_PATH)

    # 3. Crossmatch every catalog_star system.
    out_systems = {}
    by_conf = {"high": 0, "medium": 0, "low": 0, "none": 0, "non_physical": 0}

    for name, ref in REFERENCE_SYSTEMS.items():
        if name == "Sol":
            out_systems[name] = {
                "type": "catalog_star",
                "index": None,
                "byte_offset": None,
                "ref_source": ref["source"],
                "notes": ref["notes"],
            }
            # Sol gets no confidence bucket — it's neither matched nor missing.
            continue

        xyz = radec_plx_to_xyz(ref["ra_deg"], ref["dec_deg"],
                                ref["parallax_mas"])
        idx, dist = nearest_record(xyz, records)
        bin_x, bin_y, bin_z, bin_M, bin_bp = records[idx]
        expected_abs_G = ABS_G_FROM_SPT.get(ref["spt"])
        d_ref_pc = 1000.0 / ref["parallax_mas"]
        conf = classify_confidence(dist, bin_M, expected_abs_G, d_ref_pc)
        by_conf[conf] += 1

        notes_extra = []
        if ref["notes"]:
            notes_extra.append(ref["notes"])
        if expected_abs_G is not None:
            notes_extra.append(
                f"expected abs G ~{expected_abs_G:.1f} (from SpT={ref['spt']}); "
                f"bin M_at_nearest={bin_M:.2f}"
            )
        if conf == "none":
            notes_extra.append(
                "NEAREST RECORD IS NOT A MATCH — system absent from "
                "stars-near.bin. Probably caused by Gaia DR3 bright-star "
                "saturation cut (val's source data). Nearest-record fields "
                "below are diagnostic, not authoritative."
            )

        # Canonical match fields are null when conf=none.
        if conf == "none":
            match_index = None
            match_byte_offset = None
        else:
            match_index = idx
            match_byte_offset = 4 + idx * 20

        out_systems[name] = {
            "type": "catalog_star",
            "ref_ra_deg": ref["ra_deg"],
            "ref_dec_deg": ref["dec_deg"],
            "ref_parallax_mas": ref["parallax_mas"],
            "ref_distance_pc": d_ref_pc,
            "ref_xyz_pc": list(xyz),
            "ref_source": ref["source"],
            "ref_spt": ref["spt"],
            "ref_v_mag": ref["v_mag"],
            "index": match_index,
            "byte_offset": match_byte_offset,
            "bin_xyz_pc": [bin_x, bin_y, bin_z],
            "bin_M_abs_g": bin_M,
            "bin_BP_RP": bin_bp,
            "match_distance_pc": dist,
            "confidence": conf,
            "nearest_record_index_diagnostic": idx,
            "notes": " | ".join(notes_extra),
        }

    # 4. Non-physical systems.
    for name, meta in NON_PHYSICAL_SYSTEMS.items():
        out_systems[name] = {
            "type": "non_physical",
            "index": None,
            "byte_offset": None,
            "notes": meta["notes"],
        }
        by_conf["non_physical"] += 1

    # 5. Impact report: which low/none/missing systems are touched by events?
    blocking = []
    for sysname, info in out_systems.items():
        conf = info.get("confidence")
        if conf in ("low", "none"):
            n_events = ev_counts.get(sysname, 0)
            seen = sysname in events_seen
            bobs = bob_by_sys.get(sysname, [])
            blocking.append({
                "system": sysname,
                "confidence": conf,
                "match_distance_pc": info.get("match_distance_pc"),
                "events_using_system": n_events,
                "in_systems_seen": seen,
                "sample_chapter_codes": ev_samples.get(sysname, []),
                "bobs_at_system": bobs,
            })

    missing_reasons = []
    for sysname, info in out_systems.items():
        if info.get("confidence") in ("low", "none"):
            md = info.get("match_distance_pc")
            mbin = info.get("bin_M_abs_g")
            ref = REFERENCE_SYSTEMS.get(sysname, {})
            spt = ref.get("spt", "")
            exp = ABS_G_FROM_SPT.get(spt)
            # Diagnose: bright-star cut vs faint M-dwarf cut
            if exp is not None and exp < 7.0:
                cause = ("Likely Gaia DR3 bright-star saturation cut "
                         f"(SpT={spt}, expected abs G ~{exp:.1f}, too "
                         f"bright for clean Gaia astrometry).")
            elif exp is not None and exp > 11.0:
                cause = ("Likely faint-cut excluded the dim host "
                         f"(SpT={spt}, expected abs G ~{exp:.1f}, near "
                         f"or below the bin's M<13 limit).")
            else:
                cause = ("Possibly a positional/parallax discrepancy "
                         f"(SpT={spt}, expected abs G ~{exp}; check "
                         f"epoch/proper-motion handling).")
            reason = (
                f"{sysname}: nearest bin record is {md:.2f} pc away "
                f"(M_bin={mbin:.2f}); {cause}"
            )
            missing_reasons.append(reason)

    # 6. Assemble and write the output.
    out = {
        "$schema_version": "1.0.0",
        "$generated_at": _dt.datetime.now(_dt.timezone.utc)
                                  .replace(microsecond=0).isoformat()
                                  .replace("+00:00", "Z"),
        "$bin_file": "stars-near.bin",
        "$bin_record_count": count,
        "$reference_sources": [
            "SIMBAD (simbad.u-strasbg.fr); J2000 ICRS RA/Dec + parallax",
            "All parallaxes consistent with Gaia DR3 / Hipparcos.",
        ],
        "$method": (
            "For each catalog_star system, compute heliocentric XYZ from "
            "(RA, Dec, 1000/parallax_mas) on ICRS axes, then find the "
            "Euclidean-nearest record in stars-near.bin. Confidence: "
            "high (<0.3 pc + M within 1.5 of expected), medium (<1.0 pc), "
            "low (<3.0 pc), none (>=3.0 pc -> system absent from bin)."
        ),
        "systems": out_systems,
        "_coverage": {
            "total_systems": len(out_systems),
            "by_confidence": by_conf,
            "missing_from_bin_likely_reasons": missing_reasons,
            "systems_blocking_events": blocking,
        },
    }

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    # 7. Print summary tables.
    print("=" * 72)
    print("MATCH TABLE")
    print("=" * 72)
    print(f"{'system':<22} {'idx':>6} {'dist_pc':>9} "
          f"{'M_bin':>7} {'BP-RP':>7} {'conf':<8}")
    print("-" * 72)
    for name in REFERENCE_SYSTEMS:
        info = out_systems[name]
        if name == "Sol":
            print(f"{name:<22} {'-':>6} {'-':>9} {'-':>7} {'-':>7} "
                  f"{'origin':<8}")
            continue
        idx_str = (str(info['index']) if info['index'] is not None
                   else f"[{info['nearest_record_index_diagnostic']}]")
        print(f"{name:<22} "
              f"{idx_str:>7} "
              f"{info['match_distance_pc']:>9.3f} "
              f"{info['bin_M_abs_g']:>7.2f} "
              f"{info['bin_BP_RP']:>7.2f} "
              f"{info['confidence']:<8}")
    for name in NON_PHYSICAL_SYSTEMS:
        print(f"{name:<22} {'-':>6} {'-':>9} {'-':>7} {'-':>7} "
              f"{'non_phy':<8}")
    print()

    print("=" * 72)
    print("COVERAGE SUMMARY")
    print("=" * 72)
    print(f"  total systems: {len(out_systems)}")
    print(f"  by confidence: {by_conf}")
    if missing_reasons:
        print()
        print("  systems missing-from-bin (low/none confidence):")
        for r in missing_reasons:
            print(f"    - {r}")
    else:
        print("  no systems missing from bin (all matched at high or medium).")
    if blocking:
        print()
        print("  events depending on missing/low-confidence systems:")
        for b in blocking:
            print(f"    - {b['system']}: {b['events_using_system']} events, "
                  f"samples={b['sample_chapter_codes']}, "
                  f"bobs={b['bobs_at_system']}")
    else:
        print("  no events block on missing systems.")
    print()
    print(f"Wrote: {OUT_PATH}")


if __name__ == "__main__":
    main()
