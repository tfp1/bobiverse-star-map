#!/usr/bin/env python3
"""
parse_bobiverse.py

Extract per-chapter dateline data (POV / in-world date / location) from
Bobiverse epubs, books 2 through 5. Book 1 carries its datelines in the
ncx navLabel and needs the separate navLabel adapter; this handles the
body-embedded format used by books 2-5.

Design notes:
  - Sequencing comes from the ncx (recursive document order + content src),
    NOT from chapter-title numbering, which changes format every book.
  - Field extraction anchors on the in-body DATE line. POV is the line
    above it, location the line below. This survives multi-line titles,
    front matter, and missing fields.
  - Location is normalized against the 22-system enum plus an OPEN set of
    non-catalog categories (en_route, off_map_distant, megastructure,
    internal, unknown) so later-book chapters have somewhere valid to land.

Usage:
  python parse_bobiverse.py book2.epub book3.epub book4.epub book5.epub -o datelines.jsonl
  python parse_bobiverse.py ./book5_unzipped/ -o out.jsonl        # also accepts a dir
  python parse_bobiverse.py book5.epub --cast bobs.txt            # optional POV validation

Deps: beautifulsoup4  (pip install beautifulsoup4)
"""

import argparse
import io
import json
import os
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

from bs4 import BeautifulSoup

# --------------------------------------------------------------------------
# Controlled vocabulary
# --------------------------------------------------------------------------

# The 22 canonical Bobiverse systems. Sol and the two non-physical entries
# (Federation Capital, Sagittarius A*) are included for classification, but
# only the local-bubble stars carry real XYZ in stars-near.bin.
SYSTEMS = [
    "Sol", "Alpha Centauri", "Epsilon Eridani", "Epsilon Indi",
    "Delta Eridani", "Delta Pavonis", "Gamma Pavonis", "Beta Hydri",
    "Zeta Tucanae", "Kappa Ceti", "Eta Cassiopeiae", "Eta Leporis",
    "Pi3 Orionis", "82 Eridani", "Omicron\u00b2 Eridani", "Gliese 54",
    "Gliese 877", "NN 4285", "HIP 14101", "HIP 84051",
    "Federation Capital", "Sagittarius A*",
]

# lower-cased alias -> canonical. Built from SYSTEMS plus known textual variants.
ALIASES = {}
for s in SYSTEMS:
    ALIASES[s.lower()] = s
ALIASES.update({
    "omicron2 eridani": "Omicron\u00b2 Eridani",
    "omicron 2 eridani": "Omicron\u00b2 Eridani",
    "omicron-2 eridani": "Omicron\u00b2 Eridani",
    "40 eridani": "Omicron\u00b2 Eridani",
    "gl 54": "Gliese 54",
    "gl54": "Gliese 54",
    "gl 877": "Gliese 877",
    "gl877": "Gliese 877",
    "pi 3 orionis": "Pi3 Orionis",
    "sag a*": "Sagittarius A*",
    "sgr a*": "Sagittarius A*",
})
# NOTE: "Epsilon2 Eridani" deliberately NOT aliased. The book-2 Cast entry
# uses it for Vulcan's system, but the datelines say Omicron2 Eridani. Leave
# it to surface as needs_review rather than silently rewriting canon.

MEGASTRUCTURE_HINTS = ("heaven's river", "heaven\u2019s river", "topopolis")
DISTANT_HINTS = ("sagittarius a", "galactic center", "galactic centre", "sgr a")
ENROUTE_HINTS = ("en route", "interstellar space", "in transit")

MONTHS = {
    m.lower(): i for i, m in enumerate(
        ["January", "February", "March", "April", "May", "June", "July",
         "August", "September", "October", "November", "December"], start=1)
}

# "February 2167"  /  "June 25, 2133"  /  "March 2309"
DATE_RE = re.compile(
    r"^\s*(" + "|".join(MONTHS.keys()) + r")"
    r"(?:\s+(\d{1,2}))?\s*,?\s*(\d{4})\s*$",
    re.IGNORECASE,
)

FRONTMATTER_TITLES = {
    "title page", "copyright page", "copyright", "dedication",
    "acknowledgements", "acknowledgments", "table of contents",
    "appendices", "list of terms", "cast of characters", "genealogy",
}

NCX_NS = "{http://www.daisy.org/z3986/2005/ncx/}"

# --------------------------------------------------------------------------
# Source access: works for both a .epub (zip) and an unzipped directory
# --------------------------------------------------------------------------

class Book:
    def __init__(self, path):
        self.path = path
        self.is_zip = zipfile.is_zipfile(path) if os.path.isfile(path) else False
        if self.is_zip:
            self.zf = zipfile.ZipFile(path)
            self.names = self.zf.namelist()
        elif os.path.isdir(path):
            self.zf = None
            self.names = []
            for root, _, files in os.walk(path):
                for f in files:
                    rel = os.path.relpath(os.path.join(root, f), path)
                    self.names.append(rel.replace(os.sep, "/"))
        else:
            raise ValueError(f"Not an epub or directory: {path}")

    def read(self, name):
        if self.is_zip:
            return self.zf.read(name)
        return open(os.path.join(self.path, name.replace("/", os.sep)), "rb").read()

    def find_ncx(self):
        cands = [n for n in self.names if n.lower().endswith(".ncx")]
        if not cands:
            raise FileNotFoundError("No .ncx found in book")
        # prefer the shortest path (usually the real toc.ncx)
        return sorted(cands, key=len)[0]

# --------------------------------------------------------------------------
# ncx parsing -> ordered chapter index
# --------------------------------------------------------------------------

def parse_ncx(book):
    ncx_path = book.find_ncx()
    ncx_dir = posixpath.dirname(ncx_path)
    root = ET.fromstring(book.read(ncx_path))

    title_el = root.find(f"{NCX_NS}docTitle/{NCX_NS}text")
    book_title = title_el.text.strip() if title_el is not None and title_el.text else "Unknown"

    chapters = []

    def walk(nav):
        label = nav.find(f"{NCX_NS}navLabel/{NCX_NS}text")
        content = nav.find(f"{NCX_NS}content")
        title = (label.text or "").strip() if label is not None else ""
        src = content.get("src") if content is not None else None
        if src:
            src_file = src.split("#", 1)[0]
            # resolve relative to the ncx's own directory inside the package
            full = posixpath.normpath(posixpath.join(ncx_dir, src_file)) if ncx_dir else src_file
            chapters.append({"title": title, "src": full})
        for child in nav.findall(f"{NCX_NS}navPoint"):
            walk(child)

    navmap = root.find(f"{NCX_NS}navMap")
    for nav in navmap.findall(f"{NCX_NS}navPoint"):
        walk(nav)

    return book_title, chapters

# --------------------------------------------------------------------------
# Body dateline extraction
# --------------------------------------------------------------------------

def body_lines(book, src):
    try:
        html = book.read(src)
    except Exception:
        # some ncx entries point at files with case/path quirks; try a match
        alt = next((n for n in book.names if n.lower().endswith(src.lower().split("/")[-1])), None)
        if not alt:
            return []
        html = book.read(alt)
    text = BeautifulSoup(html, "html.parser").get_text("\n")
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def looks_like_name(s):
    # short, no terminal sentence punctuation, not obviously prose
    return (len(s) <= 40 and not s.endswith((".", "?", "!", ":", ",", ";"))
            and len(s.split()) <= 6)


def looks_like_location(s):
    return len(s) <= 80 and not s.endswith((".", "?", "!"))


def extract_dateline(lines, scan=15):
    """Anchor on the first DATE line within the opening `scan` lines."""
    for i, ln in enumerate(lines[:scan]):
        m = DATE_RE.match(ln)
        if not m:
            continue
        month, day, year = m.group(1), m.group(2), m.group(3)
        precision = "day" if day else "month"
        mm = MONTHS[month.lower()]
        dd = int(day) if day else 1
        date_iso = f"{int(year):04d}-{mm:02d}-{dd:02d}"

        pov = lines[i - 1] if i - 1 >= 0 else None
        loc = lines[i + 1] if i + 1 < len(lines) else None

        return {
            "date_raw": ln,
            "date_iso": date_iso,
            "date_precision": precision,
            "pov_raw": pov,
            "location_raw": loc,
            "date_line_index": i,
        }
    return None

# --------------------------------------------------------------------------
# Location normalization (closed enum + open categories)
# --------------------------------------------------------------------------

def classify_location(raw):
    if not raw:
        return {"location_norm": None, "location_type": "missing",
                "edge_target": None, "needs_review": True}
    low = raw.lower()

    # en route / interstellar: pull an edge target out of "(en route to X)"
    if any(h in low for h in ENROUTE_HINTS):
        target = None
        paren = re.search(r"\(([^)]*)\)", raw)
        seg = paren.group(1) if paren else raw
        mt = re.search(r"\bto\s+(.*)$", seg, re.IGNORECASE)
        if mt:
            tgt_norm = classify_location(mt.group(1).strip())
            target = tgt_norm["location_norm"] or mt.group(1).strip()
        return {"location_norm": None, "location_type": "en_route",
                "edge_target": target, "needs_review": target is None}

    if any(h in low for h in DISTANT_HINTS):
        return {"location_norm": "Sagittarius A*", "location_type": "off_map_distant",
                "edge_target": None, "needs_review": False}

    if any(h in low for h in MEGASTRUCTURE_HINTS):
        return {"location_norm": raw, "location_type": "megastructure",
                "edge_target": None, "needs_review": False}

    if low in ALIASES:
        return {"location_norm": ALIASES[low], "location_type": "catalog_star",
                "edge_target": None, "needs_review": False}

    # substring fallback: a system name embedded in a longer phrase
    for alias, canon in ALIASES.items():
        if alias in low:
            return {"location_norm": canon, "location_type": "catalog_star",
                    "edge_target": None, "needs_review": True}  # review the loose match

    return {"location_norm": None, "location_type": "unknown",
            "edge_target": None, "needs_review": True}

# --------------------------------------------------------------------------
# Driver
# --------------------------------------------------------------------------

def process_book(path, cast=None):
    book = Book(path)
    book_title, chapters = parse_ncx(book)
    rows, order = [], 0

    for ch in chapters:
        if ch["title"].strip().lower() in FRONTMATTER_TITLES:
            continue
        lines = body_lines(book, ch["src"])
        dl = extract_dateline(lines)
        if dl is None:
            # no date line: front matter, a Part divider, or an anomaly
            continue

        order += 1
        loc = classify_location(dl["location_raw"])

        pov = dl["pov_raw"]
        pov_review = False
        if pov is not None and not looks_like_name(pov):
            pov_review = True
        if cast and pov and pov.lower() not in cast:
            pov_review = True

        row = {
            "book": book_title,
            "doc_order": order,
            "chapter_title": ch["title"],
            "source_file": ch["src"],
            "pov_raw": pov,
            "date_raw": dl["date_raw"],
            "date_iso": dl["date_iso"],
            "date_precision": dl["date_precision"],
            "location_raw": dl["location_raw"],
            "location_norm": loc["location_norm"],
            "location_type": loc["location_type"],
            "edge_target": loc["edge_target"],
            "needs_review": bool(loc["needs_review"] or pov_review
                                 or not looks_like_location(dl["location_raw"] or "")),
        }
        rows.append(row)

    return book_title, rows


def main():
    ap = argparse.ArgumentParser(description="Parse Bobiverse books 2-5 datelines.")
    ap.add_argument("inputs", nargs="+", help="epub files or unzipped book dirs")
    ap.add_argument("-o", "--out", default="datelines.jsonl", help="output JSONL path")
    ap.add_argument("--cast", help="optional file of known POV names (one per line) to validate against")
    args = ap.parse_args()

    cast = None
    if args.cast:
        raw = open(args.cast, encoding="utf-8").read()
        cast = {n.strip().lower() for n in re.split(r"[\n,]", raw) if n.strip()}

    all_rows = []
    for path in args.inputs:
        try:
            title, rows = process_book(path, cast)
        except Exception as e:
            print(f"[ERROR] {path}: {e}", file=sys.stderr)
            continue
        review = sum(r["needs_review"] for r in rows)
        print(f"{title}: {len(rows)} chapters parsed, {review} need review", file=sys.stderr)
        all_rows.extend(rows)

    with open(args.out, "w", encoding="utf-8") as f:
        for r in all_rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\nWrote {len(all_rows)} rows -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
