#!/usr/bin/env python3
"""
normalize_wiki_csv.py

Transform timelines/bobiverse-wiki-timeline.csv (357 rows, Fandom-style
event list covering all 5 books) into a normalized events.json keyed by
chapter, with locations resolved against gazetteer.json.

The wiki CSV is the event spine for the project. This script lifts the
CSV's implicit schema into a concrete one, applies the location
resolver, and reports coverage.

OUTPUT SCHEMA (events.json):

  $schema_version : "1.0.0"
  $generated_from : path to source CSV
  $generated_at   : ISO timestamp
  events[]:
    reading_order   int        1-based index in (book, part, chapter) order
    chapter_code    str        canonical "B<book>[.P<part>].C<chapter>"
    book            int        1..5
    part            int|null   1 or 2 for B4; null otherwise
    chapter         int        within-book (or within-part for B4) chapter num
    pov             str        POV character (verbatim from CSV "Bob" column)
    in_world_date   str        canonical: "YYYY", "YYYY-MM", "YYYY-MM-DD", or "YYYY-<season>"
    date_precision  enum       day | month | season | year
    date_year       int
    date_month      int|null   1..12
    date_day        int|null   1..31
    date_season     str|null   one of Spring/Summer/Fall/Winter
    location_raw    str        verbatim from CSV "Location"
    location_type   enum       system | place_in_system | en_route | virt |
                               megastructure_internal | off_map_distant |
                               off_map_unknown | vehicle | unresolved
    system_id       str|null   canonical system name (from gazetteer.systems)
    place           str|null   named in-system place (Eden, Trantor City, ...)
    megastructure   str|null   name of megastructure (Heaven's River, Hub Zero, ...)
    target_system   str|null   for location_type=en_route, the destination system
    off_map_name    str|null   for off_map_*, the name (Centaurvania, Roanoke, ...)
    vehicle         str|null   for location_type=vehicle (Bellerophon, ...)
    secondary       obj|null   for compound scenes: parsed second half
    is_compound     bool       true if location spans two scenes (split "X / Y")
    needs_review    bool       resolver couldn't fully classify; eyeball it
    note            str|null   resolver explanation for review rows
    description     str        verbatim from CSV "Description"
    first_book      int        spoiler tier = book of first appearance (= this row's book)
    source          str        "wiki"

  _coverage:
    by_type        : count of events per location_type
    unresolved     : list of (location_raw, count) needing review
    systems_seen   : list of canonical system_ids touched
"""

import argparse
import csv
import datetime as _dt
import json
import os
import re
import sys
from collections import Counter, OrderedDict

MONTH_MAP = {
    "Jan": 1, "Feb": 2, "Mar": 3, "Apr": 4, "May": 5, "Jun": 6,
    "Jul": 7, "Aug": 8, "Sep": 9, "Sept": 9, "Oct": 10, "Nov": 11, "Dec": 12,
}
SEASONS = {"Spring", "Summer", "Fall", "Autumn", "Winter"}

VIRT_NAMES = {"Virt", "BobNet", "Bobiverse"}

EN_ROUTE_PREFIXES = re.compile(
    r"^(En [Rr]oute to|On [Rr]oute to|Approaching|Heading to)\s+(.+)$"
)
GENERIC_EN_ROUTE = {"Interstellar Space"}
SOMEWHERE_RE = re.compile(r"^Somewhere\b", re.I)
BSC_PLANET_RE = re.compile(r"^Planet BSC-", re.I)


def load_gazetteer(path):
    with open(path) as f:
        g = json.load(f)
    systems = set(g["systems"]["catalog_star"]) | set(g["systems"]["non_physical"])
    place_to_system = {row["place"]: row for row in g["gazetteer"]}
    megastructures = {m["name"]: m for m in g.get("megastructures", [])}
    off_map = {row["name"]: row for row in g.get("off_map_systems", [])}
    vehicles = {v["name"] for v in g.get("vehicles", [])}
    internals = {x["name"] for x in g.get("internal_locations", [])}
    return {
        "systems": systems,
        "places": place_to_system,
        "megastructures": megastructures,
        "off_map": off_map,
        "vehicles": vehicles,
        "internals": internals,
    }


def parse_chapter(book_part, chapter):
    """'4-1' or '4' + '12' → (book=4, part=1|None, chapter=12, code='B4.P1.C12').
    Returns None for empty rows (where Book[-Part] is blank — events with no
    chapter, just date narration)."""
    if not book_part or not str(chapter).strip():
        return None
    bp = str(book_part).strip()
    if "-" in bp:
        book_str, part_str = bp.split("-", 1)
        book = int(book_str)
        part = int(part_str)
    else:
        book = int(bp)
        part = None
    ch = int(str(chapter).strip())
    code = f"B{book}" + (f".P{part}" if part else "") + f".C{ch}"
    return {"book": book, "part": part, "chapter": ch, "code": code}


def parse_date(year_str, month_str):
    """Parse Year + Month columns into structured date.
    Year is always YYYY. Month may be: empty, '11' (numeric), 'Jun', 'Jun 24', 'Summer'."""
    year = int(year_str)
    m = (month_str or "").strip()
    if not m:
        return {
            "in_world_date": str(year),
            "date_precision": "year",
            "date_year": year, "date_month": None, "date_day": None, "date_season": None,
        }
    if m in SEASONS:
        return {
            "in_world_date": f"{year}-{m}",
            "date_precision": "season",
            "date_year": year, "date_month": None, "date_day": None, "date_season": m,
        }
    if m.isdigit():
        mon = int(m)
        return {
            "in_world_date": f"{year}-{mon:02d}",
            "date_precision": "month",
            "date_year": year, "date_month": mon, "date_day": None, "date_season": None,
        }
    parts = m.split()
    mon_name = parts[0]
    if mon_name not in MONTH_MAP:
        return {
            "in_world_date": f"{year} ({m})",
            "date_precision": "year",
            "date_year": year, "date_month": None, "date_day": None, "date_season": None,
        }
    mon = MONTH_MAP[mon_name]
    if len(parts) == 1:
        return {
            "in_world_date": f"{year}-{mon:02d}",
            "date_precision": "month",
            "date_year": year, "date_month": mon, "date_day": None, "date_season": None,
        }
    day = int(parts[1])
    return {
        "in_world_date": f"{year}-{mon:02d}-{day:02d}",
        "date_precision": "day",
        "date_year": year, "date_month": mon, "date_day": day, "date_season": None,
    }


def _empty_loc():
    return {
        "location_type": "unresolved",
        "system_id": None,
        "place": None,
        "megastructure": None,
        "target_system": None,
        "off_map_name": None,
        "vehicle": None,
        "secondary": None,
        "is_compound": False,
        "needs_review": True,
        "note": None,
    }


def _resolve_one(raw, gaz):
    """Resolve a single (non-compound) location string."""
    out = _empty_loc()
    s = raw.strip()

    # 1. Internal / virt — bare match
    if s in VIRT_NAMES or s in gaz["internals"]:
        out.update(location_type="virt", needs_review=False)
        return out

    # 2. Composite "Place-Qualifier, Virt" or "Virt, Place-Qualifier" → virt with place note
    if "," in s and any(part.strip() in VIRT_NAMES for part in s.split(",")):
        parts = [p.strip() for p in s.split(",")]
        non_virt = [p for p in parts if p not in VIRT_NAMES]
        place_note = ", ".join(non_virt) if non_virt else None
        # If the non-virt half names a known place/system, attach the system_id
        sys_id = None
        if place_note:
            # try resolve right-hand as place_in_system or system
            sub = _resolve_one(place_note, gaz)
            if sub["location_type"] in ("system", "place_in_system"):
                sys_id = sub["system_id"]
        out.update(location_type="virt", place=place_note, system_id=sys_id, needs_review=False)
        return out

    # 3. Megastructure-internal: anything with "Heaven's River" in it
    if "Heaven's River" in s:
        mega = gaz["megastructures"].get("Heaven's River")
        sys_id = mega["system"] if mega else None
        # Split "Place, Heaven's River" → place=Place
        place = None
        if "," in s:
            head, tail = [p.strip() for p in s.split(",", 1)]
            if tail == "Heaven's River":
                place = head
            elif head == "Heaven's River":
                # "Heaven's River, X" form (Quin, Heaven's River edge case)
                place = tail
        out.update(
            location_type="megastructure_internal",
            megastructure="Heaven's River",
            system_id=sys_id,
            place=place,
            needs_review=False,
        )
        return out

    # 4. Other named megastructures (bare match)
    if s in gaz["megastructures"]:
        mega = gaz["megastructures"][s]
        out.update(
            location_type="megastructure_internal",
            megastructure=s,
            system_id=mega.get("system"),
            needs_review=False,
        )
        return out
    # Special: "Hub Zero and Roanoke" — wormhole-network composite of two non-spatial nodes
    if s == "Hub Zero and Roanoke":
        out.update(
            location_type="megastructure_internal",
            megastructure="Hub Zero",
            note="composite with Roanoke (off-map alien world)",
            needs_review=False,
        )
        return out

    # 5. En route — prefixed patterns
    m = EN_ROUTE_PREFIXES.match(s)
    if m:
        target_raw = m.group(2).strip()
        target_sys = None
        if target_raw in gaz["systems"]:
            target_sys = target_raw
        elif target_raw in gaz["off_map"]:
            target_sys = target_raw  # off-map target
        else:
            # Look up via places (e.g., "Heading to Centaurvania" — Centaurvania is in off_map)
            pass
        out.update(
            location_type="en_route",
            target_system=target_sys,
            needs_review=(target_sys is None),
            note=None if target_sys else f"unresolved en-route target: {target_raw!r}",
        )
        return out
    if s in GENERIC_EN_ROUTE or SOMEWHERE_RE.match(s):
        out.update(
            location_type="en_route",
            target_system=None,
            needs_review=False,
            note="generic en-route, no stated target",
        )
        return out

    # 6. Off-map systems (bare)
    if s in gaz["off_map"]:
        out.update(
            location_type="off_map_distant",
            off_map_name=s,
            needs_review=False,
        )
        return out
    if BSC_PLANET_RE.match(s):
        out.update(
            location_type="off_map_distant",
            off_map_name=s,
            needs_review=False,
            note="BSC = Bobiverse Star Catalog (presumed); newly explored system",
        )
        return out

    # 7. "Place, System" form (comma-separated)
    if "," in s:
        head, tail = [p.strip() for p in s.split(",", 1)]
        # 7a. tail is a known system → head is a named place within it
        if tail in gaz["systems"]:
            place_info = gaz["places"].get(head)
            out.update(
                location_type="place_in_system",
                system_id=tail,
                place=head,
                needs_review=False,
                note=None if place_info else "place not in gazetteer; new entry candidate",
            )
            return out
        # 7b. tail is a known place that resolves to a system → use that system,
        #     keep head as the more-specific place (e.g. "Trantor City, Big Top" → Epsilon Indi)
        tail_row = gaz["places"].get(tail)
        if tail_row and tail_row.get("system"):
            out.update(
                location_type="place_in_system",
                system_id=tail_row["system"],
                place=head,
                needs_review=False,
                note=f"composite place: {head!r} on {tail!r} ({tail_row['system']})",
            )
            return out

    # 8. Bare system in enum
    if s in gaz["systems"]:
        out.update(location_type="system", system_id=s, needs_review=False)
        return out

    # 9. Bare place in gazetteer
    if s in gaz["places"]:
        row = gaz["places"][s]
        sys_id = row.get("system")
        if sys_id:
            out.update(
                location_type="place_in_system",
                system_id=sys_id,
                place=s,
                needs_review=False,
                note=f"resolved via gazetteer (confidence={row.get('confidence')})",
            )
            return out
        # Place known but unresolved system
        out.update(
            location_type="unresolved",
            place=s,
            needs_review=True,
            note=f"place known in gazetteer but system unresolved (confidence={row.get('confidence')})",
        )
        return out

    # 10. Vehicle
    if s in gaz["vehicles"]:
        out.update(location_type="vehicle", vehicle=s, needs_review=False)
        return out

    # 11. Fully unresolved
    out["note"] = "no match in gazetteer, systems, megastructures, off_map, or vehicles"
    return out


def resolve_location(raw, gaz):
    """Top-level resolver. Handles compounds (X / Y) then delegates to _resolve_one."""
    s = (raw or "").strip()
    if not s:
        out = _empty_loc()
        out["note"] = "empty location"
        return out
    if " / " in s:
        primary_raw, secondary_raw = s.split(" / ", 1)
        primary = _resolve_one(primary_raw.strip(), gaz)
        secondary = _resolve_one(secondary_raw.strip(), gaz)
        primary["is_compound"] = True
        primary["secondary"] = secondary
        return primary
    return _resolve_one(s, gaz)


def assign_reading_order(events):
    """Sort by (book, part_or_0, chapter); assign 1-based reading_order."""
    def key(e):
        return (e["book"], e["part"] or 0, e["chapter"])
    ordered = sorted(events, key=key)
    for i, e in enumerate(ordered, 1):
        e["reading_order"] = i
    return ordered


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--csv", default="timelines/bobiverse-wiki-timeline.csv")
    ap.add_argument("--gazetteer", default="gazetteer.json")
    ap.add_argument("--out", default="data/events.json")
    ap.add_argument("--report", default="data/events_coverage.txt")
    args = ap.parse_args()

    gaz = load_gazetteer(args.gazetteer)
    events = []
    skipped = []

    with open(args.csv) as f:
        reader = csv.DictReader(f)
        for raw_row in reader:
            ch = parse_chapter(raw_row.get("Book[-Part]", ""), raw_row.get("Chapter", ""))
            if ch is None:
                skipped.append(raw_row)
                continue
            date = parse_date(raw_row["Year"], raw_row.get("Month", ""))
            loc = resolve_location(raw_row.get("Location", ""), gaz)

            ev = OrderedDict()
            ev["reading_order"] = None  # filled by assign_reading_order
            ev["chapter_code"] = ch["code"]
            ev["book"] = ch["book"]
            ev["part"] = ch["part"]
            ev["chapter"] = ch["chapter"]
            ev["pov"] = (raw_row.get("Bob") or "").strip()
            ev.update(date)
            ev["location_raw"] = raw_row.get("Location", "")
            for k in ("location_type", "system_id", "place", "megastructure",
                      "target_system", "off_map_name", "vehicle", "secondary",
                      "is_compound", "needs_review", "note"):
                ev[k] = loc[k]
            ev["description"] = raw_row.get("Description", "")
            ev["first_book"] = ch["book"]
            ev["source"] = "wiki"
            events.append(ev)

    events = assign_reading_order(events)

    # Coverage
    by_type = Counter(e["location_type"] for e in events)
    unresolved_locs = Counter(
        e["location_raw"] for e in events if e["needs_review"]
    )
    systems_seen = sorted({e["system_id"] for e in events if e["system_id"]})

    out_obj = OrderedDict()
    out_obj["$schema_version"] = "1.0.0"
    out_obj["$generated_from"] = args.csv
    out_obj["$generated_at"] = _dt.datetime.utcnow().isoformat() + "Z"
    out_obj["$row_count"] = len(events)
    out_obj["$skipped_rows"] = len(skipped)
    out_obj["events"] = events
    out_obj["_coverage"] = OrderedDict([
        ("by_location_type", dict(by_type.most_common())),
        ("unresolved_locations", unresolved_locs.most_common()),
        ("systems_seen", systems_seen),
        ("systems_seen_count", len(systems_seen)),
    ])

    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(out_obj, f, indent=2, ensure_ascii=False)

    # Plain-text coverage report
    lines = []
    lines.append(f"Wiki CSV → events.json normalization report")
    lines.append(f"Source: {args.csv}")
    lines.append(f"Events: {len(events)}  Skipped (no chapter code): {len(skipped)}")
    lines.append("")
    lines.append("--- Location type coverage ---")
    for k, n in by_type.most_common():
        lines.append(f"  {n:4d}  {k}")
    lines.append("")
    lines.append("--- Unresolved locations (needs_review=true) ---")
    if not unresolved_locs:
        lines.append("  (none)")
    else:
        for loc, n in unresolved_locs.most_common():
            lines.append(f"  {n:4d}  {loc!r}")
    lines.append("")
    lines.append(f"--- Systems touched ({len(systems_seen)}) ---")
    for s in systems_seen:
        lines.append(f"  {s}")
    if skipped:
        lines.append("")
        lines.append("--- Skipped rows (no Book[-Part]/Chapter) ---")
        for r in skipped:
            lines.append(
                f"  Year={r.get('Year')}  Loc={r.get('Location')!r}  Desc={(r.get('Description') or '')[:80]!r}"
            )

    with open(args.report, "w") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Wrote {args.out} ({len(events)} events).")
    print(f"Wrote {args.report}.")
    print()
    print(f"Location-type coverage:")
    for k, n in by_type.most_common():
        print(f"  {n:4d}  {k}")
    if unresolved_locs:
        print(f"\n{sum(unresolved_locs.values())} events still need review across {len(unresolved_locs)} distinct location strings.")


if __name__ == "__main__":
    main()
