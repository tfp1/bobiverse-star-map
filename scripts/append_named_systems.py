#!/usr/bin/env python3
"""
append_named_systems.py

Append records for the named Bobiverse star systems to stars-near.bin.
The inherited bin file is missing nearly all bright named stars due to
Gaia DR3's bright-star saturation cut (verified empirically; see
scripts/map_systems_to_stars.py output). This script adds them back so
the named systems can be rendered as part of the same point cloud the
backdrop uses.

Computes Gaia-style photometry (M_G absolute G magnitude, BP-RP color)
from SIMBAD-sourced V magnitude + distance + spectral type using the
Pecaut & Mamajek 2013 main-sequence color/temperature table
(http://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt).
Values are exact for canonical SpTs and linearly interpolated otherwise.

IDEMPOTENT: refuses to re-append if the bin's count is already > 53836.
The tracked `static/stars-near.bin` is committed in its post-append
state (the renderer needs it that way), so a plain re-run from a fresh
checkout would hit the idempotency guard. Pass `--reset` to truncate
the bin back to the base 53836 records and regenerate in one step:

    python3 scripts/append_named_systems.py --reset

OUTPUTS:
  static/stars-near.bin             — extended in-place (19 new records appended)
  data/system_to_star_index.json    — updated in-place: each appended system
                                       gets a real index/byte_offset and
                                       physically-honest bin_M_abs_g / bin_BP_RP
  data/named_systems.json           — new flat lookup file for downstream use
"""

import argparse
import datetime as _dt
import json
import math
import os
import shutil
import struct
import sys
from collections import OrderedDict

BIN_BASE_COUNT = 53836  # the inherited count; sentinel for idempotency check
RECORD_SIZE = 20        # 5 × float32

# Coordinate frame: the inherited stars-near.bin is in HELIOCENTRIC ECLIPTIC
# XYZ (J2000), verified empirically — 3 of the nearest backdrop stars
# (Barnard, Wolf 359, Lalande 21185) match exact when the equatorial unit
# vector is rotated by the obliquity ε around the X-axis. Our ref_xyz_pc
# inputs from SIMBAD are equatorial (ICRS), so we apply that same rotation
# before writing so the named systems share the bin's frame.
OBLIQUITY_DEG = 23.4392911  # IAU 2006 obliquity at J2000.0
_OB_RAD = math.radians(OBLIQUITY_DEG)
_OB_COS = math.cos(_OB_RAD)
_OB_SIN = math.sin(_OB_RAD)


def equatorial_to_ecliptic(xyz):
    """Rotate a heliocentric ICRS (equatorial) XYZ vector into the
    heliocentric ecliptic frame used by stars-near.bin."""
    x, y, z = xyz
    return (
        x,
        y * _OB_COS + z * _OB_SIN,
        -y * _OB_SIN + z * _OB_COS,
    )

# ────────────────────────────────────────────────────────────────────────
# Pecaut & Mamajek 2013 main-sequence colors (subset for SpTs we use)
# Source: http://www.pas.rochester.edu/~emamajek/EEM_dwarf_UBVIJHK_colors_Teff.txt
# Columns:  SpT  →  (G-V offset, BP-RP color)
# These are mean dwarf values; close-enough for any subgiant near the main
# sequence (Delta Eri K0+IV, Delta Pav G8IV — both have well-known photometry).
#
# Numeric SpT key: F=5, G=6, K=7, M=8; key = class*10 + subclass (F2=52, G2=62, K5=75, M3=83)
# ────────────────────────────────────────────────────────────────────────
SPT_TABLE = {
    52: (-0.02, 0.62),   # F2V
    56: (-0.05, 0.75),   # F6V
    59: (-0.10, 0.85),   # F9V
    60: (-0.11, 0.85),   # G0V
    62: (-0.13, 0.89),   # G2V (Sun-like)
    65: (-0.16, 0.94),   # G5V
    66: (-0.17, 0.97),   # G6V
    68: (-0.19, 1.04),   # G8V
    70: (-0.21, 1.10),   # K0V
    72: (-0.27, 1.27),   # K2V
    75: (-0.38, 1.62),   # K5V
    80: (-0.45, 1.95),   # M0V
    81: (-0.55, 2.20),   # M1V
    82: (-0.65, 2.45),   # M2V
    83: (-0.75, 2.80),   # M3V
    85: (-0.90, 3.10),   # M5V
}


def spt_key(spt):
    """Parse a spectral type string into a numeric key for SPT_TABLE.
    Examples: 'G2V' → 62, 'K0+IV' → 70, 'F9.5V' → 59 (rounded down),
    'M3.5+M3.0' → 83, 'F9VFe-1.4CH-0.7' → 59 (strip metallicity tags).
    """
    s = spt.strip()
    # Composite ("M3.5+M3.0") → take primary
    if "+" in s:
        s = s.split("+")[0].strip()
    cls = s[0].upper()
    if cls not in "OBAFGKMLT":
        raise ValueError(f"Unknown spectral class in {spt!r}")
    # Subclass digit (allow decimals like 9.5, 3.5)
    rest = s[1:]
    # Read leading numeric portion
    num = ""
    for ch in rest:
        if ch.isdigit() or ch == ".":
            num += ch
        else:
            break
    if not num:
        raise ValueError(f"No subclass digit in {spt!r}")
    subclass = int(float(num))  # truncate decimal
    class_to_decade = {"O": 0, "B": 1, "A": 2, "F": 5, "G": 6, "K": 7, "M": 8}
    return class_to_decade[cls] * 10 + subclass


def lookup_photometry(spt):
    """Return (g_minus_v, bp_rp) for a spectral type. Linear interpolation
    if exact key not in SPT_TABLE."""
    k = spt_key(spt)
    if k in SPT_TABLE:
        return SPT_TABLE[k]
    # Interpolate between nearest table keys
    keys = sorted(SPT_TABLE)
    if k < keys[0]:
        return SPT_TABLE[keys[0]]
    if k > keys[-1]:
        return SPT_TABLE[keys[-1]]
    for i, kk in enumerate(keys):
        if kk > k:
            lo, hi = keys[i - 1], kk
            (gv_lo, bp_lo), (gv_hi, bp_hi) = SPT_TABLE[lo], SPT_TABLE[hi]
            t = (k - lo) / (hi - lo)
            return (gv_lo + t * (gv_hi - gv_lo),
                    bp_lo + t * (bp_hi - bp_lo))
    return SPT_TABLE[keys[-1]]


def compute_M_and_color(v_mag, distance_pc, spt):
    """V mag + distance + SpT → (absolute G mag, BP-RP color)."""
    g_minus_v, bp_rp = lookup_photometry(spt)
    if v_mag is None:
        # Fall back: use Mamajek absolute V_mag for the SpT and ignore distance.
        # For our missing case (NN 4285, M3.5V), this is reasonable —
        # the absolute mag is essentially a property of spectral type.
        # Approximate M_V for an M3.5V dwarf ≈ 11.5; convert to G.
        approx_M_V_table = {  # rough M_V by SpT key
            52: 3.5, 56: 4.0, 59: 4.5, 60: 4.6, 62: 4.8, 65: 5.1, 66: 5.3,
            68: 5.6, 70: 5.9, 72: 6.4, 75: 7.4, 80: 9.0, 81: 9.6, 82: 10.4,
            83: 11.2, 85: 12.3,
        }
        k = spt_key(spt)
        m_v = approx_M_V_table.get(k, 8.0)
        m_g = m_v + g_minus_v
        return m_g, bp_rp
    # Standard distance modulus
    apparent_g = v_mag + g_minus_v
    abs_g = apparent_g - 5.0 * math.log10(distance_pc / 10.0)
    return abs_g, bp_rp


def read_count(bin_path):
    with open(bin_path, "rb") as f:
        return struct.unpack("<I", f.read(4))[0]


def reset_to_base(bin_path):
    """Truncate the bin back to its inherited base (BIN_BASE_COUNT records)
    and rewrite the header. Lets the script regenerate from a tracked
    post-append file in one step instead of requiring a separate
    truncate-by-hand step before re-running."""
    new_size = 4 + BIN_BASE_COUNT * RECORD_SIZE
    with open(bin_path, "r+b") as f:
        f.truncate(new_size)
        f.seek(0)
        f.write(struct.pack("<I", BIN_BASE_COUNT))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default="static/stars-near.bin")
    ap.add_argument("--mapping", default="data/system_to_star_index.json")
    ap.add_argument("--named-out", default="data/named_systems.json")
    ap.add_argument("--dry-run", action="store_true",
                    help="Compute photometry and report; do not modify files.")
    ap.add_argument("--reset", action="store_true",
                    help=(f"Truncate the bin back to the inherited base count "
                          f"({BIN_BASE_COUNT}) before appending. Use this to "
                          "regenerate from a fresh checkout — the tracked "
                          "static/stars-near.bin is already post-append, so a "
                          "plain re-run hits the idempotency guard."))
    args = ap.parse_args()

    current_count = read_count(args.bin)
    if args.reset and not args.dry_run:
        if current_count == BIN_BASE_COUNT:
            print(f"{args.bin} already at base count {BIN_BASE_COUNT}; nothing to reset.")
        else:
            print(f"Resetting {args.bin}: {current_count} → {BIN_BASE_COUNT} records.")
            reset_to_base(args.bin)
            current_count = BIN_BASE_COUNT

    # Idempotency check — runs after any --reset so we can confirm we landed
    # at the expected base.
    if current_count != BIN_BASE_COUNT:
        print(f"REFUSING: {args.bin} count is {current_count} (expected base {BIN_BASE_COUNT}).")
        print("This bin file has already been modified. To regenerate from "
              "the tracked post-append file, re-run with --reset:")
        print(f"  python3 scripts/append_named_systems.py --reset")
        sys.exit(1)

    with open(args.mapping) as f:
        mapping = json.load(f)

    # Collect catalog stars that need appending (have ref_xyz, are catalog_star, not Sol)
    to_append = []
    for name, s in mapping["systems"].items():
        if s.get("type") != "catalog_star":
            continue
        if name == "Sol":
            continue
        xyz = s.get("ref_xyz_pc")
        spt = s.get("ref_spt")
        if not (xyz and spt):
            print(f"  SKIP {name}: missing xyz or spt")
            continue
        m_g, bp_rp = compute_M_and_color(s.get("ref_v_mag"), s.get("ref_distance_pc"), spt)
        # ref_xyz_pc is equatorial (ICRS); rotate into the bin's ecliptic
        # frame before appending. See OBLIQUITY_DEG note at top.
        xyz_ecl = list(equatorial_to_ecliptic(xyz))
        to_append.append({
            "name": name,
            "xyz": xyz_ecl,
            "xyz_equatorial": list(xyz),
            "spt": spt,
            "v_mag": s.get("ref_v_mag"),
            "distance_pc": s.get("ref_distance_pc"),
            "M_abs_g": m_g,
            "BP_RP": bp_rp,
        })

    print(f"Will append {len(to_append)} named-system records to {args.bin}.")
    print(f"{'System':<22s} {'SpT':<10s} {'V':<6s} {'d_pc':<7s} {'M_G':<6s} {'BP-RP':<6s}  xyz")
    for r in to_append:
        v = f"{r['v_mag']:5.2f}" if r['v_mag'] is not None else "  -  "
        print(f"  {r['name']:<20s}  {r['spt']:<8s}  {v:<6s} {r['distance_pc']:5.2f}   {r['M_abs_g']:5.2f}  {r['BP_RP']:5.2f}   "
              f"({r['xyz'][0]:+6.3f}, {r['xyz'][1]:+6.3f}, {r['xyz'][2]:+6.3f})")

    if args.dry_run:
        print("\n[dry-run] No files modified.")
        return

    # Append records: rewrite the bin with updated count + new records
    base_record_count = BIN_BASE_COUNT
    new_count = base_record_count + len(to_append)
    base_bytes = os.path.getsize(args.bin) - 4  # all records
    assert base_bytes == base_record_count * RECORD_SIZE, \
        f"size mismatch: file has {base_bytes // RECORD_SIZE} records vs header {base_record_count}"

    tmp_path = args.bin + ".tmp"
    with open(args.bin, "rb") as src, open(tmp_path, "wb") as dst:
        src.read(4)  # discard old count
        dst.write(struct.pack("<I", new_count))
        # copy existing records verbatim
        shutil.copyfileobj(src, dst, length=1 << 20)
        # append new records
        for r in to_append:
            dst.write(struct.pack("<5f",
                                  r["xyz"][0], r["xyz"][1], r["xyz"][2],
                                  r["M_abs_g"], r["BP_RP"]))
    os.replace(tmp_path, args.bin)
    print(f"\nBin updated: {args.bin} now has {new_count} records "
          f"({base_record_count} backdrop + {len(to_append)} named).")

    # Update mapping in place
    for offset, r in enumerate(to_append):
        idx = base_record_count + offset
        s = mapping["systems"][r["name"]]
        s["index"] = idx
        s["byte_offset"] = 4 + idx * RECORD_SIZE
        s["bin_xyz_pc"] = list(r["xyz"])  # ecliptic frame (matches bin)
        s["bin_xyz_pc_equatorial"] = list(r["xyz_equatorial"])
        s["bin_M_abs_g"] = r["M_abs_g"]
        s["bin_BP_RP"] = r["BP_RP"]
        s["match_distance_pc"] = 0.0
        s["confidence"] = "appended"
        # Preserve diagnostic but mark as obsolete. Strip any prior
        # "APPENDED ..." prefix(es) so re-running with --reset doesn't
        # accumulate duplicate banners.
        notes_prefix = ("APPENDED to stars-near.bin from SIMBAD reference data; "
                        "Mamajek 2013 SpT→photometry")
        existing = (s.get("notes") or "")
        while existing.startswith(notes_prefix):
            sep = existing.find(". ")
            existing = existing[sep + 2:] if sep != -1 else ""
        s["notes"] = (
            f"{notes_prefix}; rotated equatorial→ecliptic. {existing}"
        ).strip()
        # Drop the old diagnostic — it described the failed crossmatch
        s.pop("nearest_record_index_diagnostic", None)

    # Update coverage summary
    cov = mapping.setdefault("_coverage", {})
    by_conf = cov.setdefault("by_confidence", {})
    by_conf["appended"] = len(to_append)
    for k in ("high", "medium", "low", "none"):
        if k in by_conf and by_conf[k] == 0:
            del by_conf[k]
    cov["last_updated"] = _dt.datetime.utcnow().isoformat() + "Z"
    cov["bin_record_count_after_append"] = new_count

    with open(args.mapping, "w") as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)
    print(f"Mapping updated: {args.mapping}")

    # Write a clean lookup file for downstream consumers
    named_doc = OrderedDict()
    named_doc["$schema_version"] = "1.0.0"
    named_doc["$generated_at"] = _dt.datetime.utcnow().isoformat() + "Z"
    named_doc["$bin_file"] = args.bin
    named_doc["$bin_record_count"] = new_count
    named_doc["$source_photometry"] = (
        "Positions from SIMBAD (RA/Dec/parallax), rotated equatorial→ecliptic "
        f"(obliquity ε={OBLIQUITY_DEG}°) to match the bin's heliocentric "
        "ecliptic frame. Photometry computed from V_mag + distance + spectral "
        "type via Pecaut & Mamajek 2013 main-sequence color table."
    )
    named_doc["named_systems"] = []
    for r in to_append:
        idx = base_record_count + to_append.index(r)
        named_doc["named_systems"].append({
            "name": r["name"],
            "index": idx,
            "byte_offset": 4 + idx * RECORD_SIZE,
            "xyz_pc": list(r["xyz"]),                       # ecliptic (bin frame)
            "xyz_pc_equatorial": list(r["xyz_equatorial"]), # ICRS, for reference
            "M_abs_g": r["M_abs_g"],
            "BP_RP": r["BP_RP"],
            "spt": r["spt"],
            "v_mag": r["v_mag"],
            "distance_pc": r["distance_pc"],
        })
    # Add non-physical / origin entries for completeness
    for name in ("Sol",):
        named_doc["named_systems"].append({
            "name": name, "index": None, "byte_offset": None,
            "xyz_pc": [0.0, 0.0, 0.0], "type": "origin",
            "notes": "Heliocentric origin; not a bin record.",
        })
    for name in ("Federation Capital", "Sagittarius A*"):
        named_doc["named_systems"].append({
            "name": name, "index": None, "byte_offset": None,
            "type": "non_physical",
            "notes": "Render via separate non-spatial convention per handoff §D1.",
        })
    with open(args.named_out, "w") as f:
        json.dump(named_doc, f, indent=2, ensure_ascii=False)
    print(f"Named lookup written: {args.named_out}")

    print(f"\nDone. To regenerate from scratch: python3 scripts/append_named_systems.py --reset")


if __name__ == "__main__":
    main()
