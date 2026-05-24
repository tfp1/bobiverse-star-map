#!/usr/bin/env python3
"""
consolidate_bobs.py

Merge three Bob sources into canonical data/bobs.json:
  1. timelines/genealogy.json     — nested tree, canonical lineage (~book 2)
  2. data/bob_index.json          — sheet extract, Bob# / HIC / online-year /
                                    deceased-year / destinations / annotations
  3. data/edges_replication.json  — mined parents for late Bobs missing from 1+2

Canon renames (per epub grep):
  Moulder → Mulder
  Johnny  → Jonny
  Viktor  → Victor
Parent disagreements: prefer genealogy.json (tracks book prose).
  Dexter: Charles (not Riker)
  Loki:   Khan (not Bill); restored_from=Khan
  Thor:   Calvin (not Bill)
  Skinner, Jonny: Mulder (after rename)

Born-year semantics:
  created_year = genealogy.json's `born` (when instantiated)
  online_year  = bob_index.json's `born_year` (when activated)
  replication_edge_year = online_year ?? created_year

Sheet sanity check: bob_index.json `born_year` values < SHEET_YEAR_FLOOR (2100)
are impossible (Bob himself created 2133). These are misread columns — the raw
value is preserved in provenance.online_year_raw, but online_year is left null
so replication_edge_year falls back to created_year. Affects Jonny/Skinner
(both flagged 2070 in the sheet; canonical year 2171 from genealogy.json).

v4 backups (2nd 82 Eri expedition) become separate nodes: id = name + "_v4".

OUTPUT SCHEMA: see docstring at top of repo / README; key fields:
  id, name, bob_number, version, generation, parent_id, parent_source,
  alt_names, spelling_aliases, created_year, online_year,
  replication_edge_year, deceased_year, origin_system, destinations,
  hic_code, annotations, restored_from, sources, provenance

Writes data/bobs.json. Does not modify any source file.
"""

import argparse
import datetime as _dt
import json
import os
import sys
from collections import Counter, OrderedDict

# ─────────────────────────── canon rules ──────────────────────────────

CANON_RENAMES = {
    "Moulder": "Mulder",
    "Johnny": "Jonny",
    "Viktor": "Victor",
}

# Sheet's born_year < this is impossible (Bob created 2133). Treated as a
# column-misread: raw value preserved in provenance, online_year nulled.
SHEET_YEAR_FLOOR = 2100

# Per-Bob parent overrides (after rename). Source: handoff §6 + epub grep.
PARENT_OVERRIDES = {
    "Dexter": ("Charles", "genealogy.json"),
    "Loki": ("Khan", "genealogy.json"),
    "Thor": ("Calvin", "genealogy.json"),
    "Skinner": ("Mulder", "genealogy.json"),
    "Jonny": ("Mulder", "genealogy.json"),
}

# Bobs flagged as restored from a backup of another Bob.
RESTORED_FROM = {
    "Loki": "Khan",
}


def canon_name(name):
    """Apply canon renames. Returns canonical form."""
    return CANON_RENAMES.get(name, name)


# ─────────────────────────── loaders ──────────────────────────────────

def flatten_genealogy(node, parent_name, out):
    """Walk nested tree, emit {name, parent, created_year, generation}."""
    raw = node["name"]
    name = canon_name(raw)
    gen = 1 if parent_name is None else out[parent_name]["generation"] + 1 if parent_name in out else None
    # gen via depth: pass it in explicitly
    out[name] = {
        "name": name,
        "raw_name": raw,
        "parent": canon_name(parent_name) if parent_name else None,
        "created_year": node.get("born"),
        "generation": gen,
    }
    children = node.get("clones") or []
    if isinstance(children, dict):
        return
    for c in children:
        flatten_genealogy(c, name, out)


def walk_genealogy_with_depth(node, parent_name, depth, out):
    """Same as flatten_genealogy but tracks depth explicitly."""
    raw = node["name"]
    name = canon_name(raw)
    out[name] = {
        "name": name,
        "raw_name": raw,
        "parent": canon_name(parent_name) if parent_name else None,
        "created_year": node.get("born"),
        "generation": depth,
    }
    children = node.get("clones") or []
    if isinstance(children, dict):
        return
    for c in children:
        walk_genealogy_with_depth(c, name, depth + 1, out)


# ─────────────────────────── merge ────────────────────────────────────

def new_bob(id_, name):
    return {
        "id": id_,
        "name": name,
        "bob_number": None,
        "version": None,
        "generation": None,
        "parent_id": None,
        "parent_source": "n/a",
        "alt_names": [],
        "spelling_aliases": [],
        "created_year": None,
        "online_year": None,
        "replication_edge_year": None,
        "deceased_year": None,
        "origin_system": None,
        "destinations": [],
        "hic_code": None,
        "annotations": [],
        "restored_from": None,
        "sources": [],
        "provenance": {},
    }


def add_source(bob, src):
    if src not in bob["sources"]:
        bob["sources"].append(src)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    ap.add_argument("--out", default=None, help="Output path (default: <repo>/data/bobs.json)")
    args = ap.parse_args()

    genealogy_path = os.path.join(args.repo, "timelines", "genealogy.json")
    index_path = os.path.join(args.repo, "data", "bob_index.json")
    edges_path = os.path.join(args.repo, "data", "edges_replication.json")
    out_path = args.out or os.path.join(args.repo, "data", "bobs.json")

    with open(genealogy_path) as f:
        genealogy = json.load(f)
    with open(index_path) as f:
        index = json.load(f)
    with open(edges_path) as f:
        edges = json.load(f)

    conflicts = []

    # ---- 1. Build base map from genealogy.json (canonical lineage) ----
    gen_flat = OrderedDict()
    walk_genealogy_with_depth(genealogy, None, 1, gen_flat)

    bobs = OrderedDict()  # id → bob dict
    for name, info in gen_flat.items():
        b = new_bob(name, name)
        b["generation"] = info["generation"]
        b["created_year"] = info["created_year"]
        if info["parent"]:
            b["parent_id"] = info["parent"]
            b["parent_source"] = "genealogy.json"
            b["provenance"]["parent_id"] = "genealogy.json"
        if info["created_year"] is not None:
            b["provenance"]["created_year"] = "genealogy.json"
        if info["raw_name"] != name:
            b["spelling_aliases"].append(info["raw_name"])
            conflicts.append({
                "bob": name,
                "issue": f"genealogy.json spelling {info['raw_name']!r} renamed to canonical {name!r}",
                "resolution": "renamed",
            })
        add_source(b, "genealogy.json")
        bobs[name] = b

    # ---- 2. Layer bob_index.json ----
    for entry in index["bobs"]:
        raw_name = entry["name"]
        # Skip unnamed cohort placeholders
        if raw_name.startswith("???") or raw_name.endswith("?"):
            # Still record; give them stable ids using source_row to disambiguate.
            placeholder_id = f"unnamed_row{entry['source_row']}"
            b = new_bob(placeholder_id, raw_name)
            b["generation"] = entry.get("generation")
            b["version"] = entry.get("version")
            parent_raw = entry.get("parent")
            if parent_raw:
                b["parent_id"] = canon_name(parent_raw)
                b["parent_source"] = "bob_index.json"
                b["provenance"]["parent_id"] = "bob_index.json"
            raw_by = entry.get("born_year")
            if raw_by is not None:
                if raw_by < SHEET_YEAR_FLOOR:
                    b["provenance"]["online_year_raw"] = raw_by
                    b["provenance"]["online_year_dropped"] = (
                        f"sheet value {raw_by} < {SHEET_YEAR_FLOOR}; treated as column-misread"
                    )
                else:
                    b["online_year"] = raw_by
                    b["provenance"]["online_year"] = "bob_index.json"
            b["deceased_year"] = entry.get("deceased_year")
            if b["deceased_year"] is not None:
                b["provenance"]["deceased_year"] = "bob_index.json"
            b["origin_system"] = entry.get("origin_system")
            b["destinations"] = list(entry.get("destinations") or [])
            hic = entry.get("hic_code")
            b["hic_code"] = hic if (hic and hic != "HIC") else None
            b["annotations"] = list(entry.get("annotations") or [])
            b["alt_names"] = list(entry.get("alt_names") or [])
            add_source(b, "bob_index.json")
            bobs[placeholder_id] = b
            continue

        name = canon_name(raw_name)
        version = entry.get("version")
        is_v4_backup = version == "v4"

        # Decide node id. v4 backups are separate nodes (rebuilds).
        if is_v4_backup:
            node_id = f"{name}_v4"
        else:
            node_id = name

        if node_id not in bobs:
            bobs[node_id] = new_bob(node_id, name)

        b = bobs[node_id]
        add_source(b, "bob_index.json")

        # Track sheet spelling if it differs from canon
        if raw_name != name and raw_name not in b["spelling_aliases"]:
            b["spelling_aliases"].append(raw_name)
            conflicts.append({
                "bob": name,
                "issue": f"bob_index.json spelling {raw_name!r} renamed to canonical {name!r}",
                "resolution": "renamed",
            })

        # bob_number: sheet is authoritative
        if entry.get("bob_number") is not None:
            b["bob_number"] = entry["bob_number"]
            b["provenance"]["bob_number"] = "bob_index.json"

        # version: sheet
        if version:
            b["version"] = version

        # generation: prefer genealogy; only fill if missing
        if b["generation"] is None and entry.get("generation") is not None:
            b["generation"] = entry["generation"]
            b["provenance"]["generation"] = "bob_index.json"

        # parent: prefer genealogy; sheet only if missing
        sheet_parent_raw = entry.get("parent")
        sheet_parent = canon_name(sheet_parent_raw) if sheet_parent_raw else None
        if b["parent_id"] is None and sheet_parent:
            b["parent_id"] = sheet_parent
            b["parent_source"] = "bob_index.json"
            b["provenance"]["parent_id"] = "bob_index.json"
        elif b["parent_id"] and sheet_parent and b["parent_id"] != sheet_parent:
            # Disagreement — keep JSON, record conflict
            conflicts.append({
                "bob": name,
                "issue": f"parent disagreement: genealogy.json={b['parent_id']!r}, "
                         f"bob_index.json={sheet_parent!r}",
                "resolution": f"kept {b['parent_id']!r} (genealogy.json preferred)",
            })

        # v4 backups: parent should match the original's lineage
        if is_v4_backup and b["parent_id"] is None and sheet_parent:
            b["parent_id"] = sheet_parent
            b["parent_source"] = "bob_index.json"
            b["provenance"]["parent_id"] = "bob_index.json"

        # online_year (sheet's born_year is activation). Drop impossible
        # values (column-misread sentinels like Jonny/Skinner's 2070) and
        # preserve them in provenance only.
        raw_by = entry.get("born_year")
        if raw_by is not None:
            if raw_by < SHEET_YEAR_FLOOR:
                b["provenance"]["online_year_raw"] = raw_by
                b["provenance"]["online_year_dropped"] = (
                    f"sheet value {raw_by} < {SHEET_YEAR_FLOOR}; treated as column-misread"
                )
                conflicts.append({
                    "bob": name,
                    "issue": f"bob_index.json born_year={raw_by} is implausible (<{SHEET_YEAR_FLOOR})",
                    "resolution": f"dropped; replication_edge_year falls back to created_year",
                })
            else:
                b["online_year"] = raw_by
                b["provenance"]["online_year"] = "bob_index.json"

        # deceased
        if entry.get("deceased_year") is not None:
            b["deceased_year"] = entry["deceased_year"]
            b["provenance"]["deceased_year"] = "bob_index.json"

        # origin
        if entry.get("origin_system"):
            if not b["origin_system"]:
                b["origin_system"] = entry["origin_system"]
                b["provenance"]["origin_system"] = "bob_index.json"

        # destinations (merge)
        for d in entry.get("destinations") or []:
            if d not in b["destinations"]:
                b["destinations"].append(d)

        # HIC (skip generic "HIC" placeholder)
        hic = entry.get("hic_code")
        if hic and hic != "HIC" and not b["hic_code"]:
            b["hic_code"] = hic
            b["provenance"]["hic_code"] = "bob_index.json"

        # annotations (merge)
        for a in entry.get("annotations") or []:
            if a not in b["annotations"]:
                b["annotations"].append(a)

        # alt_names (merge, applying canon rename)
        for alt in entry.get("alt_names") or []:
            canon_alt = canon_name(alt)
            if canon_alt not in b["alt_names"]:
                b["alt_names"].append(canon_alt)

    # ---- 3. Layer edges_replication.json (mined parents for late Bobs) ----
    for e in edges["edges"]:
        child_raw = e["child"]
        # Some mined children are slash-forms like "Kyle/Jackson"; prefer first
        # token as the canonical, and add the second as alt_name.
        if "/" in child_raw:
            primary, alt = child_raw.split("/", 1)
            child_name = canon_name(primary.strip())
            alt_name = alt.strip()
        else:
            child_name = canon_name(child_raw)
            alt_name = None

        parent_name = canon_name(e["parent"])

        if child_name not in bobs:
            b = new_bob(child_name, child_name)
            b["parent_id"] = parent_name
            b["parent_source"] = "edges_mined"
            b["provenance"]["parent_id"] = "edges_replication.json"
            # generation = parent + 1 if parent known
            if parent_name in bobs and bobs[parent_name]["generation"] is not None:
                b["generation"] = bobs[parent_name]["generation"] + 1
            b["online_year"] = e["date_year"]
            b["provenance"]["online_year"] = "edges_replication.json"
            add_source(b, "edges_replication.json")
            bobs[child_name] = b
        else:
            add_source(bobs[child_name], "edges_replication.json")

        if alt_name:
            if alt_name not in bobs[child_name]["alt_names"]:
                bobs[child_name]["alt_names"].append(alt_name)

    # ---- 4. Apply per-Bob parent overrides ----
    for bob_name, (override_parent, src) in PARENT_OVERRIDES.items():
        if bob_name in bobs:
            current = bobs[bob_name]["parent_id"]
            if current != override_parent:
                conflicts.append({
                    "bob": bob_name,
                    "issue": f"parent override: was {current!r}, set to {override_parent!r}",
                    "resolution": f"applied override (source: {src})",
                })
                bobs[bob_name]["parent_id"] = override_parent
                bobs[bob_name]["parent_source"] = src
                bobs[bob_name]["provenance"]["parent_id"] = src

    # ---- 5. Restored-from markers ----
    for bob_name, origin in RESTORED_FROM.items():
        if bob_name in bobs:
            bobs[bob_name]["restored_from"] = origin
        # v4 backups also need flagging
    for nid, b in bobs.items():
        if b["version"] == "v4":
            # Elmer_v4 specifically is "From Backup"
            if "From Backup" in b["annotations"] and not b["restored_from"]:
                b["restored_from"] = b["name"]  # restored from own predecessor
            if "Khan backup" in b["annotations"] and not b["restored_from"]:
                b["restored_from"] = "Khan"

    # ---- 6. Compute replication_edge_year ----
    for b in bobs.values():
        b["replication_edge_year"] = b["online_year"] if b["online_year"] is not None else b["created_year"]

    # ---- 7. Validate: every parent_id must exist; flag implausible years ----
    unresolved = []
    all_ids = set(bobs.keys())
    for b in bobs.values():
        if b["parent_id"] and b["parent_id"] not in all_ids:
            unresolved.append({
                "bob": b["id"],
                "issue": f"dangling parent_id {b['parent_id']!r} not in bobs list",
            })
        # Sanity check: Bob himself was created 2133. Any earlier year is wrong.
        for fld in ("created_year", "online_year"):
            yr = b.get(fld)
            if yr is not None and yr != -1 and yr < 2100:
                unresolved.append({
                    "bob": b["id"],
                    "issue": f"implausible {fld}={yr} (before 2100); likely sheet column-misread",
                })

    # ---- 8. Coverage stats ----
    bob_list = list(bobs.values())
    by_gen = Counter(b["generation"] for b in bob_list if b["generation"] is not None)
    by_src_set = Counter(",".join(sorted(b["sources"])) for b in bob_list)
    coverage = {
        "total_bobs": len(bob_list),
        "by_generation": dict(sorted(by_gen.items())),
        "with_bob_number": sum(1 for b in bob_list if b["bob_number"] is not None),
        "with_created_year": sum(1 for b in bob_list if b["created_year"] is not None),
        "with_online_year": sum(1 for b in bob_list if b["online_year"] is not None),
        "with_deceased_year": sum(1 for b in bob_list if b["deceased_year"] is not None),
        "with_hic_code": sum(1 for b in bob_list if b["hic_code"]),
        "with_origin_system": sum(1 for b in bob_list if b["origin_system"]),
        "with_destinations": sum(1 for b in bob_list if b["destinations"]),
        "by_source_set": dict(by_src_set),
    }

    output = {
        "$schema_version": "1.0.0",
        "$generated_at": _dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "$source_files": [
            "timelines/genealogy.json",
            "data/bob_index.json",
            "data/edges_replication.json",
        ],
        "$bob_count": len(bob_list),
        "_canon_rules_applied": [f"{k}→{v}" for k, v in CANON_RENAMES.items()],
        "_conflicts_resolved": conflicts,
        "bobs": bob_list,
        "_coverage": coverage,
        "_unresolved": unresolved,
    }

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    # ---- 9. Summary to stdout ----
    print(f"Wrote {out_path}")
    print(f"  total bobs: {coverage['total_bobs']}")
    print(f"  by generation: {coverage['by_generation']}")
    print(f"  with bob_number: {coverage['with_bob_number']}")
    print(f"  with created_year: {coverage['with_created_year']}")
    print(f"  with online_year: {coverage['with_online_year']}")
    print(f"  with deceased_year: {coverage['with_deceased_year']}")
    print(f"  with hic_code: {coverage['with_hic_code']}")
    print(f"  with origin_system: {coverage['with_origin_system']}")
    print(f"  source-set breakdown:")
    for k, v in coverage["by_source_set"].items():
        print(f"    {v:3d}  {k}")
    print(f"  conflicts resolved: {len(conflicts)}")
    for c in conflicts:
        print(f"    - {c['bob']}: {c['issue']} → {c['resolution']}")
    print(f"  unresolved: {len(unresolved)}")
    for u in unresolved:
        print(f"    - {u['bob']}: {u['issue']}")


if __name__ == "__main__":
    main()
