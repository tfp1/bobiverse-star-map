#!/usr/bin/env python3
"""
parse_genealogy_sheet.py

Parse the visual-tree genealogy from the fan Google Sheet
(timelines/google-sheet-genealogy.csv) into a flat Bob index.

The sheet is a 2D tree: columns 1, 3, 5, 7, 9 = generations 1..5.
Each Bob occupies a vertical block of cells in one column, separated
from siblings by a blank row. A block looks like:

    [optional year]      e.g. "2145"
    Name                 e.g. "Riker (Bob2) v2"
    [optional alt name]  e.g. "Jackson ?"  (for Kyle)
    Origin system        e.g. "Epsilon Eridani"
    [optional dest label]   "Destination(s)" — literal label
    [destinations...]    one or more system names
    [HIC code]           "HIC" or "HIC-16537-1"
    [optional Deceased]  "Deceased 2185"
    [optional annot.]    "Sent over SCUT" / "From Backup" / etc.

Parent = most recent name in column (col-2) at or above current row.

OUTPUT: data/bob_index.json
  bobs[]:
    name             primary canonical name (e.g. "Riker")
    bob_number       int|null   from "(BobN)" if present
    version          str|null   from "vN" suffix
    generation       int        column-derived
    parent           str|null   computed from column to the left
    alt_names        list[str]  e.g. ["Jackson"] for Kyle
    born_year        int|null
    deceased_year    int|null
    origin_system    str|null
    destinations     list[str]
    hic_code         str|null
    annotations      list[str]  raw text lines we couldn't classify
    source_row       int        the row containing the name (for debugging)
"""

import argparse
import csv
import datetime as _dt
import json
import os
import re
import sys
from collections import OrderedDict

# Columns where generation data lives (0-indexed)
GEN_COLS = [1, 3, 5, 7, 9]

# Header/label cells to skip (not Bobs)
LABEL_VALUES = {
    "Destination(s)", "Mystery Cohorts", "More Mentioned", "Mentioned",
    "Three other ships", "8-10 Generations by books end",
}

# Patterns
NAME_BOB_NUM = re.compile(r"\(Bob(\d+)\)")
NAME_VERSION = re.compile(r"\bv(\d+)\b")
YEAR_ONLY = re.compile(r"^\d{4}$")
DECEASED = re.compile(r"^Deceased(?:\s+(\d{4}))?", re.I)
HIC_LINE = re.compile(r"^HIC(?:-[\d\-]+)?$")
ALT_NAME_LINE = re.compile(r"^([A-Z][a-zA-Z]+)\s*\?$")  # "Jackson ?"
NAME_LIKE = re.compile(r"^[A-Z][a-zA-Z][a-zA-Z'?\s/]*$")

# Origin/destination = known systems (loaded from gazetteer)


def load_systems(gazetteer_path):
    with open(gazetteer_path) as f:
        g = json.load(f)
    systems = set(g["systems"]["catalog_star"]) | set(g["systems"]["non_physical"])
    # Add aliases used in the sheet
    aliases = {
        "Omicron2 Eridani": "Omicron² Eridani",
        "Alpha Centuri": "Alpha Centauri",  # typo in sheet
        "Earth": "Sol",
    }
    return systems, aliases


def looks_like_year(cell):
    return bool(YEAR_ONLY.match(cell.strip()))


def looks_like_system(cell, systems, aliases):
    s = cell.strip()
    if s in systems:
        return s
    if s in aliases:
        return aliases[s]
    return None


def clean_name(raw):
    """Extract canonical name from a name cell.
    Returns (name, bob_number, version, leftover_annot)."""
    s = raw.strip()
    bob_num = None
    version = None
    leftover = []
    m = NAME_BOB_NUM.search(s)
    if m:
        bob_num = int(m.group(1))
        s = NAME_BOB_NUM.sub("", s).strip()
    m = NAME_VERSION.search(s)
    if m:
        version = f"v{m.group(1)}"
        s = NAME_VERSION.sub("", s).strip()
    # Placeholder for unnamed cohort member: "???" or "9?" / "10?"
    if re.match(r"^\?+$", s) or re.match(r"^\d+\?$", s):
        return s, bob_num, version, ["unnamed cohort placeholder"]
    # Strip trailing punctuation
    s = s.rstrip("?, .").strip()
    return s, bob_num, version, leftover


# Cells that look like Bob names superficially but are annotations / non-Bob entities.
# Each pattern must match the FULL annotation phrase, not just a prefix word —
# bare "Khan"/"Bashful" are real Bob names; "Khan backup"/"Bashful Backup" are not.
ANNOTATION_PATTERNS = [
    re.compile(r"^From\s+Backup\b", re.I),
    re.compile(r"^Sent\s+(?:over|to)\b", re.I),
    re.compile(r"^Bashful\s+Backup\b", re.I),
    re.compile(r"^Khan\s+backup\b", re.I),
    re.compile(r"^Ships?\s+in\s+service\b", re.I),
    re.compile(r"^Exodu[sx]\s+(?:\d+|\?)\b", re.I),
    re.compile(r"^\d+\s+v\d+\b", re.I),
    re.compile(r"^2nd\s+Expedition\b", re.I),
    re.compile(r"^Refugee\s+\w+\b", re.I),
    re.compile(r"^Henry\s+Roberts\b", re.I),   # alien replicant, not a Bob
    re.compile(r"^\d{4}\s+\d+\s+Exodus\b", re.I),  # "2201 14 Exodus Ships in service"
    re.compile(r"^Delta\s+Pavonis\s+Defense\b", re.I),
]


def is_name_cell(cell, systems, aliases):
    """Heuristic: is this cell a Bob name row?"""
    s = cell.strip()
    if not s:
        return False
    if s in LABEL_VALUES:
        return False
    if looks_like_year(s):
        return False
    if HIC_LINE.match(s):
        return False
    if DECEASED.match(s):
        return False
    if looks_like_system(s, systems, aliases):
        return False
    # Sol-1 etc — ship name, not a Bob
    if re.match(r"^[A-Z][a-z]+-\d+$", s):
        return False
    # Explicit annotation phrases
    for ap in ANNOTATION_PATTERNS:
        if ap.match(s):
            return False
    # Plain "HIC-NNNN-N" w/o leading HIC — not a name
    if re.match(r"^HIC", s):
        return False
    # Positive signals
    if NAME_BOB_NUM.search(s):
        return True  # explicit "(BobN)" marker
    if NAME_VERSION.search(s):
        return True  # explicit "vN" marker
    # Placeholder for unnamed cohort member: "???" or "9?" / "10?"
    if re.match(r"^\?+$", s) or re.match(r"^\d+\?$", s):
        return True
    # Plain capitalized name: 1-2 capitalized words
    if re.match(r"^[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?$", s):
        return True
    return False


def parse_blocks(rows, systems, aliases):
    """Walk each generation column, group cells into blocks separated by
    fully-blank rows in that column, classify each block."""
    bobs = []
    unparsed = []

    for col in GEN_COLS:
        # Group rows into blocks. The sheet uses single blank rows as visual
        # padding within a Bob's block (between name, origin, HIC, etc.), so
        # we only flush on TWO consecutive blank rows in the column.
        block = []  # list of (row_index, cell_value)
        blanks = 0
        for ri, row in enumerate(rows):
            cell = row[col].strip() if col < len(row) else ""
            if cell:
                block.append((ri, cell))
                blanks = 0
            else:
                blanks += 1
                if blanks >= 2 and block:
                    parse_block(block, col, systems, aliases, bobs, unparsed)
                    block = []
                    blanks = 0
        if block:
            parse_block(block, col, systems, aliases, bobs, unparsed)

    # Sort bobs by source row to maintain document order, then assign parents
    bobs.sort(key=lambda b: b["source_row"])
    assign_parents(bobs)
    return bobs, unparsed


def parse_block(block, col, systems, aliases, bobs, unparsed):
    """Classify a block of (row, value) tuples in one column.
    A block usually represents one Bob, but sometimes multiple if siblings
    are stacked without a blank separator (rare)."""
    if not block:
        return
    # Find name cells in the block
    name_indices = [i for i, (_, v) in enumerate(block) if is_name_cell(v, systems, aliases)]
    if not name_indices:
        # No name found — record as unparsed
        unparsed.append({
            "column": col,
            "generation": (col // 2) + 1,
            "start_row": block[0][0],
            "cells": [v for _, v in block],
        })
        return

    # Build cohort-year timeline: each year cell becomes the default born_year
    # for subsequent names in the block (siblings stack under one cohort year).
    years_in_block = [(i, int(v)) for i, (_, v) in enumerate(block) if looks_like_year(v)]

    def cohort_year_for(name_idx):
        last = None
        for yi, yv in years_in_block:
            if yi < name_idx:
                last = yv
            else:
                break
        return last

    # Split block at each name boundary — multiple Bobs in one block
    boundaries = name_indices + [len(block)]
    for i, name_idx in enumerate(name_indices):
        next_idx = boundaries[i + 1]
        sub = block[name_idx:next_idx]
        prev_end = name_indices[i - 1] + 1 if i > 0 else 0
        pre_sub = block[prev_end:name_idx]
        bob = classify_bob(pre_sub, sub, col, systems, aliases)
        if bob:
            if bob["born_year"] is None:
                bob["born_year"] = cohort_year_for(name_idx)
            if _has_any_metadata(bob):
                bobs.append(bob)


def _has_any_metadata(bob):
    """A Bob with no surrounding metadata (no year, no origin, no hic, no
    destinations, no annotations) is almost certainly a stray cell reference,
    not a real entry. Filter these out."""
    return any([
        bob["born_year"], bob["deceased_year"], bob["origin_system"],
        bob["destinations"], bob["hic_code"], bob["annotations"],
        bob["alt_names"], bob["bob_number"],
    ])


def classify_bob(pre, sub, col, systems, aliases):
    """pre = cells above the name row (typically the birth year);
    sub = cells starting from the name row, ending before next name."""
    name_row, raw_name = sub[0]
    name, bob_num, version, leftover_annot = clean_name(raw_name)
    bob = {
        "name": name,
        "bob_number": bob_num,
        "version": version,
        "generation": (col // 2) + 1,
        "parent": None,  # filled by assign_parents
        "alt_names": [],
        "born_year": None,
        "deceased_year": None,
        "origin_system": None,
        "destinations": [],
        "hic_code": None,
        "annotations": list(leftover_annot),
        "source_row": name_row,
    }

    # Born year: look in `pre` for the closest year above
    for ri, val in reversed(pre):
        if looks_like_year(val):
            bob["born_year"] = int(val)
            break

    # Process trailing cells (after the name): origin, HIC, destinations, deceased, annot
    expecting_destinations = False
    for ri, val in sub[1:]:
        # Alt-name pattern (e.g., "Jackson ?" after "Kyle")
        m = ALT_NAME_LINE.match(val)
        if m and not bob["alt_names"]:
            bob["alt_names"].append(m.group(1))
            continue
        # Deceased
        m = DECEASED.match(val)
        if m:
            if m.group(1):
                bob["deceased_year"] = int(m.group(1))
            else:
                bob["deceased_year"] = -1  # year unknown but dead
            continue
        # HIC
        if HIC_LINE.match(val):
            bob["hic_code"] = val
            continue
        # Destination label
        if val == "Destination(s)":
            expecting_destinations = True
            continue
        # System name → origin (first) or destination (later)
        sys_id = looks_like_system(val, systems, aliases)
        if sys_id:
            if bob["origin_system"] is None and not expecting_destinations:
                bob["origin_system"] = sys_id
            else:
                bob["destinations"].append(sys_id)
            continue
        # "Sol-1" type ship name
        if re.match(r"^[A-Z][a-z]+-\d+$", val) and bob["origin_system"] is None:
            bob["annotations"].append(f"ship={val}")
            continue
        # Year cell — could be a destination year
        if looks_like_year(val):
            bob["annotations"].append(f"year_in_block={val}")
            continue
        # Anything else → annotation
        bob["annotations"].append(val)

    return bob


def assign_parents(bobs):
    """For each Bob at column C row R, parent = most recent name in column C-2
    at row <= R. Special case: gen 1 has no parent."""
    # Build per-column timeline
    by_col = {}
    for b in bobs:
        col = (b["generation"] - 1) * 2 + 1
        by_col.setdefault(col, []).append(b)
    # For each bob, find parent
    for b in bobs:
        if b["generation"] == 1:
            continue
        parent_col = (b["generation"] - 2) * 2 + 1
        candidates = by_col.get(parent_col, [])
        parent = None
        for c in candidates:
            if c["source_row"] <= b["source_row"]:
                parent = c
            else:
                break
        b["parent"] = parent["name"] if parent else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default="timelines/google-sheet-genealogy.csv")
    ap.add_argument("--gazetteer", default="gazetteer.json")
    ap.add_argument("--out", default="data/bob_index.json")
    args = ap.parse_args()

    systems, aliases = load_systems(args.gazetteer)
    with open(args.csv) as f:
        rows = list(csv.reader(f))

    bobs, unparsed = parse_blocks(rows, systems, aliases)

    out = OrderedDict()
    out["$schema_version"] = "1.0.0"
    out["$generated_from"] = args.csv
    out["$generated_at"] = _dt.datetime.utcnow().isoformat() + "Z"
    out["$bob_count"] = len(bobs)
    out["$unparsed_block_count"] = len(unparsed)
    out["bobs"] = bobs
    out["_unparsed_blocks"] = unparsed

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)

    # Console summary
    print(f"Wrote {args.out} ({len(bobs)} Bobs, {len(unparsed)} unparsed blocks).")
    print()
    by_gen = {}
    for b in bobs:
        by_gen.setdefault(b["generation"], []).append(b["name"])
    for g in sorted(by_gen):
        print(f"  gen {g} ({len(by_gen[g])}): {', '.join(by_gen[g])}")
    print()
    print(f"Bobs with bob_number: {sum(1 for b in bobs if b['bob_number'])}")
    print(f"Bobs with HIC code (specific): {sum(1 for b in bobs if b['hic_code'] and b['hic_code'] != 'HIC')}")
    print(f"Bobs with born_year:      {sum(1 for b in bobs if b['born_year'])}")
    print(f"Bobs with deceased_year:  {sum(1 for b in bobs if b['deceased_year'])}")
    print(f"Bobs with destinations:   {sum(1 for b in bobs if b['destinations'])}")
    print(f"Bobs with alt_names:      {sum(1 for b in bobs if b['alt_names'])}")


if __name__ == "__main__":
    main()
