#!/usr/bin/env python3
"""
mine_edges.py

Pattern-extract REPLICATION and TRAVEL edges from event descriptions in
data/events.json. The wiki CSV's Description column encodes both edge
types in fairly regular shapes — see handoff.md §2 for the schema and
§4 for the strategy.

OUTPUT SCHEMAS:

  data/edges_replication.json
    edges[]:
      parent          str        parent Bob name
      child           str        child Bob name (one edge per child)
      in_world_date   str        from the source event
      date_year       int
      chapter_code    str        source event chapter (e.g. "B1.C17")
      reading_order   int
      first_book      int        spoiler tier
      pattern         str        which extractor matched (for debugging/audit)
      source_text     str        the substring of the description that matched
      parent_known    bool       parent appears in genealogy seed
      child_known     bool       child appears in genealogy seed
      confidence      enum       high | medium | low
      note            str|null

  data/edges_travel.json
    edges[]:
      bob                  str       subject Bob name
      verb                 enum      heads_to | arrives_at | leaves_for | returns_to | in_transit_to
      destination_raw      str       captured destination phrase
      destination_system   str|null  resolved canonical system id
      destination_type     enum      system | place_in_system | megastructure | off_map | unresolved
      in_world_date        str
      date_year            int
      chapter_code         str
      reading_order        int
      first_book           int
      pattern              str
      source_text          str
      bob_known            bool
      confidence           enum     high | medium | low
      note                 str|null

CONFIDENCE:
  high   — subject/parent is a known Bob AND destination/child resolves cleanly
  medium — one side resolves, the other is new (probably a discovery)
  low    — both sides unresolved or pattern is speculative

Coverage report at data/edges_coverage.txt.
"""

import argparse
import datetime as _dt
import json
import os
import re
import sys
from collections import Counter, OrderedDict

# ─────────────────────────── seed name set ────────────────────────────

def flatten_genealogy(node, acc):
    acc.add(node["name"])
    children = node.get("clones") or []
    if isinstance(children, dict):
        return acc
    for c in children:
        flatten_genealogy(c, acc)
    return acc


# ─────────────────────────── helpers ──────────────────────────────────

NAME_TOK = r"[A-Z][A-Za-z][A-Za-z0-9'\-]*"           # e.g. Bob, Garfield, O'Brien
NAME_OR_SLASH = rf"{NAME_TOK}(?:/{NAME_TOK})?"        # e.g. Kyle/Jackson
NAME_LIST = rf"{NAME_OR_SLASH}(?:(?:,\s+(?:and\s+)?|,?\s+and\s+){NAME_OR_SLASH})*"


def split_names(name_list_str):
    """Split 'A, B, and C' or 'A and B' into ['A', 'B', 'C']."""
    s = name_list_str.strip().rstrip(".,;:")
    s = re.sub(r",?\s+and\s+", ", ", s)
    parts = [p.strip() for p in s.split(",")]
    return [p for p in parts if p and re.match(rf"^{NAME_OR_SLASH}$", p)]


# Aliases: wiki uses "GL 877" but gazetteer has "Gliese 877" etc.
DEST_ALIASES = {}
def _build_aliases(gaz):
    """Build alias map: alternate forms → canonical system id."""
    a = {}
    for s in gaz["systems"]:
        a[s] = s
        # GL ↔ Gliese
        m = re.match(r"^Gliese\s+(\d+)$", s)
        if m:
            a[f"GL {m.group(1)}"] = s
    # Place aliases
    for place, row in gaz["places"].items():
        if row.get("system"):
            a[place] = row["system"]
    return a


def normalize_dest(raw):
    """Clean a destination phrase: trim, strip articles/trailing words."""
    s = raw.strip().rstrip(".,;:")
    s = re.sub(r"^the\s+", "", s, flags=re.I)
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s)
    s = re.sub(r"\s+system$", "", s, flags=re.I)
    return s.strip()


def resolve_destination(raw, gaz, aliases):
    """Returns (dest_type, dest_system, note)."""
    s = normalize_dest(raw)
    # Direct alias hit (handles bare systems, GL/Gliese, places-in-system)
    if s in aliases:
        canonical = aliases[s]
        if s != canonical:
            return "place_in_system" if s in gaz["places"] else "system", canonical, f"alias {s!r} → {canonical!r}"
        return "system", canonical, None
    # Strip trailing binary-star letter ("Alpha Centauri B" → "Alpha Centauri")
    m = re.match(r"^(.*?)\s+[A-Z]$", s)
    if m and m.group(1) in aliases:
        canonical = aliases[m.group(1)]
        return "system", canonical, f"stripped binary-star letter from {s!r}"
    # Numbered planet ("Delta Eridani 4" → "Delta Eridani")
    m = re.match(r"^(.*?)\s+\d+$", s)
    if m and m.group(1) in aliases:
        canonical = aliases[m.group(1)]
        return "place_in_system", canonical, f"stripped planet number from {s!r}"
    # Megastructure
    if s in gaz["megastructures"]:
        meta = gaz["megastructures"][s]
        return "megastructure", meta.get("system"), f"megastructure {s!r}"
    # Off-map system
    if s in gaz["off_map"]:
        return "off_map", None, f"off-map {s!r}"
    return "unresolved", None, f"no match for {s!r}"


def load_gazetteer(path):
    with open(path) as f:
        g = json.load(f)
    return {
        "systems": set(g["systems"]["catalog_star"]) | set(g["systems"]["non_physical"]),
        "places": {r["place"]: r for r in g["gazetteer"]},
        "megastructures": {m["name"]: m for m in g.get("megastructures", [])},
        "off_map": {r["name"]: r for r in g.get("off_map_systems", [])},
    }


def build_dest_regex(gaz):
    """Curated regex of all known destination-strings (systems, places, megas,
    off-map, GL/Gliese aliases). Longest-first to avoid prefix shadowing.
    Optionally followed by a single binary-star letter or planet number."""
    targets = list(gaz["systems"]) + list(gaz["places"]) + \
              list(gaz["megastructures"]) + list(gaz["off_map"])
    # GL ↔ Gliese aliases
    gl_aliases = []
    for s in gaz["systems"]:
        m = re.match(r"^Gliese\s+(\d+)$", s)
        if m:
            gl_aliases.append(f"GL {m.group(1)}")
    targets += gl_aliases
    # Longest first so "Alpha Centauri" wins over "Alpha"
    targets = sorted(set(targets), key=len, reverse=True)
    body = "|".join(re.escape(t) for t in targets)
    # Optional binary letter or planet number suffix
    return re.compile(rf"(?:{body})(?:\s+[A-D]\b|\s+\d+\b)?")


# ─────────────────────────── replication extractors ───────────────────

# Stop list: words that are capitalized in prose but NOT Bob names.
NON_BOB_NAMES = {
    "Deltan", "Deltans", "Quinlin", "Quinlan", "Quinlans", "Pav", "Pavs",
    "Starfleet", "Borg", "Gamers", "Skippies", "Skippy", "Resistance",
    "Council", "Brazilian", "Medeiros", "Others", "FAITH", "VEHEMENT",
    "Earth", "Sol", "Eden", "Camelot", "Caerleon",
    "Manny", "Mannies", "Mulder",  # Mulder is a Bob but special-cased elsewhere
    "Bashful", "Dopey", "Sleepy", "Hungry",  # these ARE Bobs; keep them; remove below
    # Sentence-opening adverbs that match NAME_TOK but aren't names
    "Afterwards", "Then", "Meanwhile", "Eventually", "Initially",
    "Suddenly", "Later", "Subsequently", "Finally", "However",
    # Greek-letter star-name prefixes (no Bob is named after one)
    "Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta",
    "Iota", "Kappa", "Lambda", "Omicron", "Sigma", "Tau", "Upsilon",
    "Phi", "Chi", "Psi", "Omega",
    # Star catalog designators ("GL 877", "HR 8832", etc.)
    "GL", "HR", "HIP", "HD",
}
# Re-add real Bobs that got caught in the filter
NON_BOB_NAMES -= {"Mulder", "Bashful", "Dopey", "Sleepy", "Hungry"}

QUANTIFIER = r"(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|\d+)"

# Pronouns and possessives — capitalize-able but not Bob names
PRONOUNS = {"He", "She", "They", "It", "His", "Her", "Their", "We"}

# R1: "<Parent> clones himself [once|twice|thrice|N more times]? (and creates | creating) <ChildList>"
R_CLONE_SELF = re.compile(
    rf"({NAME_TOK})\s+clones\s+himself"
    rf"(?:\s+(?:once|twice|thrice|\w+\s+(?:more\s+)?times?))?"
    rf"(?:[, ]+(?:and\s+)?(?:creat(?:es|ing)|making))\s+"
    rf"({NAME_LIST})"
)

# R7: "<Parent> and (?:his|her) clone <Child>" or "<Parent>'s clone <Child>"
R_POSSESSIVE_CLONE = re.compile(
    rf"({NAME_TOK})(?:\s+and\s+(?:his|her)|'s)\s+clone\s+({NAME_TOK})\b"
)

# R3c: bare "creates <NameList>" w/o quantifier — only emit when ALL names are known Bobs
R_BARE_CREATES_NOQTY = re.compile(
    rf"\bcreates?\s+({NAME_LIST})\b"
)

# R2: "<Parent> creates <ChildList>" (explicit subject, with or without "clones" word)
R_PARENT_CREATES = re.compile(
    rf"({NAME_TOK})\s+creates?\s+"
    rf"(?:{QUANTIFIER}\s+)?"
    rf"(?:new\s+)?(?:clones?[\s,:\(]+)?"
    rf"(?:named\s+|called\s+)?"
    rf"\(?({NAME_LIST})\)?"
)

# R3a: "creates? <N>? (new )?clones? [(,:]? <ChildList>" — parent inferred = POV; quantifier required
R_BARE_CREATES_QTY = re.compile(
    rf"\bcreates?\s+"
    rf"(?:{QUANTIFIER}\s+)"
    rf"(?:new\s+)?clones?[,:\(\s]+"
    rf"\(?({NAME_LIST})\)?"
)

# R3b: "created two new clones (X and Y)" — past tense, paren list
R_CREATED_PAREN = re.compile(
    rf"\bcreated\s+"
    rf"(?:{QUANTIFIER}\s+)"
    rf"(?:new\s+)?clones?\s*\(({NAME_LIST})\)"
)

# R4: Parenthetical "(<ChildList> clones? of <Parent>)" — explicit lineage
R_PAREN_CLONES_OF = re.compile(
    rf"\(({NAME_LIST})\s+clones?\s+of\s+({NAME_TOK})(?:'s)?\)"
)

# R5: "<ChildList> (clones? of <Parent>)" or "(a clone of <Parent>)" — children just before paren
R_INLINE_CLONES_OF = re.compile(
    rf"({NAME_LIST})\s+\((?:a\s+)?clones?\s+of\s+({NAME_TOK})(?:'s)?\)"
)

# R6: Cohort form "<First> and \w+ other <Parent> clones (<RestList>)"
R_COHORT = re.compile(
    rf"({NAME_TOK})\s+and\s+\w+\s+other\s+({NAME_TOK})\s+clones?\s*\(({NAME_LIST})\)"
)


def _clean_children(names):
    return [n for n in names if n not in NON_BOB_NAMES]


def extract_replication(ev, known_names):
    """Yield edge dicts."""
    desc = ev["description"]
    pov = ev["pov"].strip() or "<unknown>"
    out = []
    # Resolve POV "Original Bob" → "Bob"
    if pov == "Original Bob":
        pov = "Bob"

    def _clean_parent(p):
        if not p:
            return None
        if p in PRONOUNS or p in NON_BOB_NAMES:
            return None
        # Strip possessive: "Bill's" → "Bill"
        return p[:-2] if p.endswith("'s") else p

    def add(parent, children, pattern, src):
        parent = _clean_parent(parent)
        if not parent:
            return
        for c in children:
            if c in NON_BOB_NAMES or c in PRONOUNS:
                continue
            if parent == c:
                continue  # don't self-loop
            if any(p == parent and ch == c for p, ch, _, _ in out):
                continue
            out.append((parent, c, pattern, src))

    # R1: "X clones himself ... creates Y, Z"
    for m in R_CLONE_SELF.finditer(desc):
        add(m.group(1), _clean_children(split_names(m.group(2))), "R1_clone_self", m.group(0))

    # R2: "X creates Y, Z" (explicit subject)
    for m in R_PARENT_CREATES.finditer(desc):
        parent = m.group(1)
        if parent in NON_BOB_NAMES:
            continue
        children = _clean_children(split_names(m.group(2)))
        if not children:
            continue
        # Confidence guard: require parent to be a known Bob OR at least one child to be
        if not (parent in known_names or any(c in known_names for c in children)):
            continue
        add(parent, children, "R2_parent_creates", m.group(0))

    # R3a: "creates two new clones A, B" — parent = POV (quantifier required)
    for m in R_BARE_CREATES_QTY.finditer(desc):
        add(pov, _clean_children(split_names(m.group(1))), "R3a_bare_qty_pov", m.group(0))

    # R3b: "created two new clones (X and Y)" — past tense, paren list, parent = POV
    for m in R_CREATED_PAREN.finditer(desc):
        add(pov, _clean_children(split_names(m.group(1))), "R3b_created_paren_pov", m.group(0))

    # R4: parenthetical "(A and B clones of X)" — explicit
    for m in R_PAREN_CLONES_OF.finditer(desc):
        add(m.group(2), _clean_children(split_names(m.group(1))), "R4_paren_clones_of", m.group(0))

    # R5: inline "A and B (clones of X)"
    for m in R_INLINE_CLONES_OF.finditer(desc):
        add(m.group(2), _clean_children(split_names(m.group(1))), "R5_inline_clones_of", m.group(0))

    # R6: cohort form "Khan and N other Bill clones (Hannibal, Tom, ...)"
    for m in R_COHORT.finditer(desc):
        first_child = m.group(1)
        parent = m.group(2)
        rest = _clean_children(split_names(m.group(3)))
        all_children = ([first_child] if first_child not in NON_BOB_NAMES else []) + rest
        add(parent, all_children, "R6_cohort", m.group(0))

    # R7: "Bill and his clone Garfield" or "Bill's clone Garfield"
    for m in R_POSSESSIVE_CLONE.finditer(desc):
        add(m.group(1), [m.group(2)], "R7_possessive_clone", m.group(0))

    # R3c: bare "creates A and B" w/o quantifier — strict: ALL extracted names must be known Bobs,
    # AND no named Bob may immediately precede "creates" (that's R2's territory).
    for m in R_BARE_CREATES_NOQTY.finditer(desc):
        prefix = desc[max(0, m.start() - 30):m.start()]
        last_name = re.search(rf"({NAME_TOK})\s*$", prefix)
        if last_name and last_name.group(1) not in PRONOUNS:
            continue  # explicit subject named; let R2 handle it
        children = _clean_children(split_names(m.group(1)))
        if not children:
            continue
        if not all(c in known_names for c in children):
            continue
        add(pov, children, "R3c_bare_creates_known", m.group(0))

    # Dedupe by (parent, child) preserving first occurrence
    seen = set()
    edges = []
    for parent, child, pattern, src in out:
        if (parent, child) in seen:
            continue
        seen.add((parent, child))
        parent_k = parent in known_names
        child_k = child in known_names
        # Confidence
        if pattern in ("R1_clone_self", "R4_paren_clones_of", "R5_inline_clones_of",
                       "R3b_created_paren_pov", "R6_cohort", "R7_possessive_clone",
                       "R3c_bare_creates_known"):
            conf = "high"
        elif pattern == "R2_parent_creates" and parent_k:
            conf = "high"
        elif pattern.startswith("R3") and parent_k:
            conf = "high" if child_k else "medium"
        else:
            conf = "medium" if (parent_k or child_k) else "low"
        edges.append({
            "parent": parent,
            "child": child,
            "in_world_date": ev["in_world_date"],
            "date_year": ev["date_year"],
            "chapter_code": ev["chapter_code"],
            "reading_order": ev["reading_order"],
            "first_book": ev["first_book"],
            "pattern": pattern,
            "source_text": src,
            "parent_known": parent_k,
            "child_known": child_k,
            "confidence": conf,
            "note": None,
        })
    return edges


# ─────────────────────────── travel extractors ────────────────────────

def build_cohort_travel_patterns(dest_re):
    """Cohort travel patterns — mirror R6_cohort but for travel verbs.
    Captures: group(1)=first_name, group(2)=rest_list, group(3)=dest.
    Emits one edge per name in [first] + rest_list."""
    D = dest_re.pattern
    COHORT_SUBJ = rf"({NAME_TOK})\s+and\s+\w+\s+other\s+{NAME_TOK}\s+clones?\s*\(({NAME_LIST})\)"
    return [
        ("arrives_at", "T_COHORT_arrives",
         re.compile(rf"\b{COHORT_SUBJ}\s+arrives?\s+(?:at|in)\s+({D})")),
        ("heads_to", "T_COHORT_heads",
         re.compile(rf"\b{COHORT_SUBJ}\s+heads?\s+(?:out\s+|back\s+|over\s+|off\s+|on\s+)?(?:to|toward[s]?|for)\s+({D})")),
        ("leaves_for", "T_COHORT_leaves",
         re.compile(rf"\b{COHORT_SUBJ}\s+leaves?\s+(?:heading\s+)?(?:to|toward[s]?|for|back\s+to)\s+({D})")),
        ("returns_to", "T_COHORT_returns",
         re.compile(rf"\b{COHORT_SUBJ}\s+returns?\s+(?:back\s+)?to\s+({D})")),
        ("leaves_for", "T_COHORT_sets_off",
         re.compile(rf"\b{COHORT_SUBJ}\s+sets?\s+(?:off|out)\s+(?:for|to|toward[s]?)\s+({D})")),
    ]


def build_hidden_subject_patterns(dest_re):
    """Subjectless travel patterns — verb + destination only, no leading NAME_LIST.
    Subject is back-tracked from the enclosing sentence (most recent known Bob).
    Captures: group(1)=dest."""
    D = dest_re.pattern
    return [
        ("heads_to", "T1H_heads_hidden",
         re.compile(rf"\bheads?\s+(?:out\s+|back\s+|over\s+|off\s+|on\s+)?(?:to|toward[s]?|for)\s+({D})")),
        ("arrives_at", "T2H_arrives_hidden",
         re.compile(rf"\barrives?\s+(?:at|in)\s+({D})")),
        ("leaves_for", "T3H_leaves_hidden",
         re.compile(rf"\bleaves?\s+(?:heading\s+)?(?:to|toward[s]?|for|back\s+to)\s+({D})")),
        ("returns_to", "T4H_returns_hidden",
         re.compile(rf"\breturns?\s+(?:back\s+)?to\s+({D})")),
        ("leaves_for", "T8H_sets_off_hidden",
         re.compile(rf"\bsets?\s+(?:off|out)\s+(?:for|to|toward[s]?)\s+({D})")),
    ]


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z])")
_NAME_TOK_FINDER = re.compile(NAME_TOK)


def _sentence_for_position(desc, pos):
    """Return (start, end) of the sentence in desc containing character index pos."""
    # Sentence boundaries: . ! ? followed by whitespace + capital
    start = 0
    for m in _SENTENCE_SPLIT.finditer(desc):
        if m.end() > pos:
            break
        start = m.end()
    # End is next sentence boundary (or end of string)
    end = len(desc)
    for m in _SENTENCE_SPLIT.finditer(desc, pos):
        end = m.start()
        break
    return start, end


def _paren_spans(text):
    """Return list of (start, end) character spans that lie inside parentheses."""
    spans = []
    depth = 0
    open_at = None
    for i, ch in enumerate(text):
        if ch == "(":
            if depth == 0:
                open_at = i
            depth += 1
        elif ch == ")" and depth > 0:
            depth -= 1
            if depth == 0:
                spans.append((open_at, i))
    return spans


def _backtrack_subject(desc, sentence_start, verb_start, known_names):
    """Find the subject of a subjectless travel verb by scanning the sentence
    prefix for NAME_TOK candidates.

    Rule: take the *most recent* candidate (excluding stopwords, pronouns, and
    names inside parentheses). Emit only if that most-recent candidate is a
    known Bob. Don't fall back to an earlier known Bob — if the most recent
    is unknown, the real subject is probably the unknown one, and attributing
    travel to an earlier mention causes false positives (e.g. "Mulder greets
    Marcus and Monty as they arrive at X" → must not emit Mulder → X).
    """
    prefix = desc[sentence_start:verb_start]
    paren_spans = _paren_spans(prefix)
    candidates = []
    for m in _NAME_TOK_FINDER.finditer(prefix):
        tok = m.group(0)
        if tok in NON_BOB_NAMES or tok in PRONOUNS:
            continue
        if any(s <= m.start() < e for s, e in paren_spans):
            continue
        # Genitive/agent: "request of Bill", "produced by Bob" — not the subject.
        prev_word = re.search(r"(\w+)\s*$", prefix[:m.start()])
        if prev_word and prev_word.group(1).lower() in ("of", "by", "other"):
            continue
        # Cohort parent: "other Bill clones" — Bill is the parent type, not subject.
        # (Also catches the bare "Bill clones" descriptor.)
        after = prefix[m.end():m.end() + 10]
        if re.match(r"\s+clones?\b", after):
            continue
        candidates.append(tok)
    if not candidates:
        return None
    last = candidates[-1]
    return last if last in known_names else None


def build_travel_patterns(dest_re):
    """Build the travel-verb patterns parametrized by the curated dest regex.
    Destination is captured precisely from the gazetteer-derived alternation."""
    D = dest_re.pattern  # already a non-capturing group with optional suffix
    return [
        # T1: heads (out|back|over|off|on)? (to|for|toward) <dest>
        ("heads_to", "T1_heads",
         re.compile(rf"\b({NAME_LIST})\s+heads?\s+(?:out\s+|back\s+|over\s+|off\s+|on\s+)?(?:to|toward[s]?|for)\s+({D})")),
        # T2: arrives (at|in|with) <dest>
        ("arrives_at", "T2_arrives",
         re.compile(rf"\b({NAME_LIST})\s+arrives?\s+(?:at|in|with\s+\d+\s+colony\s+ships?\s+at)\s+({D})")),
        # T3: leaves (heading)? (for|to|back to) <dest>
        ("leaves_for", "T3_leaves",
         re.compile(rf"\b({NAME_LIST})\s+leaves?\s+(?:heading\s+)?(?:to|toward[s]?|for|back\s+to)\s+({D})")),
        # T4: returns to <dest>
        ("returns_to", "T4_returns",
         re.compile(rf"\b({NAME_LIST})\s+returns?\s+(?:back\s+)?to\s+({D})")),
        # T5: in transit / on route / on the way to <dest>
        ("in_transit_to", "T5_transit",
         re.compile(rf"\b({NAME_LIST})\s+(?:is|are)\s+(?:on\s+(?:the\s+)?route\s+to|in\s+transit\s+(?:to|toward[s]?))\s+({D})")),
        # T6: heads back to <dest>
        ("returns_to", "T6_heads_back",
         re.compile(rf"\b({NAME_LIST})\s+heads?\s+back\s+to\s+({D})")),
        # T7: hightails it (out|away)? — exit verb; no dest. Skip for now.
        # T8: sets off (for|to) <dest>
        ("leaves_for", "T8_sets_off",
         re.compile(rf"\b({NAME_LIST})\s+sets?\s+(?:off|out)\s+(?:for|to|toward[s]?)\s+({D})")),
        # T9: passive "sent to <dest>" — emit with bob=<NameList>, verb=leaves_for
        ("leaves_for", "T9_sent_to",
         re.compile(rf"\b({NAME_LIST})\s+(?:was|is|were|are)\s+sent\s+to\s+({D})")),
    ]


def extract_travel(ev, known_names, gaz, travel_patterns, aliases,
                   cohort_patterns=None, hidden_patterns=None):
    desc = ev["description"]
    out = []
    seen = set()

    def _conf(dest_type, bob_known):
        if dest_type in ("system", "place_in_system", "megastructure") and bob_known:
            return "high"
        if dest_type in ("system", "place_in_system", "megastructure", "off_map"):
            return "medium"
        if bob_known:
            return "medium"
        return "low"

    def _emit(bob, verb, dest_raw, dest_type, dest_sys, note, pattern_id, source_text):
        key = (bob, verb, dest_raw)
        if key in seen:
            return
        seen.add(key)
        bob_known = bob in known_names
        out.append({
            "bob": bob,
            "verb": verb,
            "destination_raw": dest_raw,
            "destination_system": dest_sys,
            "destination_type": dest_type,
            "in_world_date": ev["in_world_date"],
            "date_year": ev["date_year"],
            "chapter_code": ev["chapter_code"],
            "reading_order": ev["reading_order"],
            "first_book": ev["first_book"],
            "pattern": pattern_id,
            "source_text": source_text,
            "bob_known": bob_known,
            "confidence": _conf(dest_type, bob_known),
            "note": note,
        })

    # Standard subject-prefixed patterns
    for verb, pattern_id, regex in travel_patterns:
        for m in regex.finditer(desc):
            subj_str = m.group(1)
            dest_raw = m.group(2).strip()
            subjects = split_names(subj_str)
            subjects = [s for s in subjects if s not in NON_BOB_NAMES]
            if not subjects:
                continue
            dest_type, dest_sys, note = resolve_destination(dest_raw, gaz, aliases)
            for bob in subjects:
                _emit(bob, verb, dest_raw, dest_type, dest_sys, note,
                      pattern_id, m.group(0).strip())

    # Cohort patterns — "Khan and seven other Bill clones (Hannibal, Tom, ...) arrive at X"
    for verb, pattern_id, regex in (cohort_patterns or []):
        for m in regex.finditer(desc):
            first = m.group(1)
            rest_str = m.group(2)
            dest_raw = m.group(3).strip()
            subjects = [first] if first not in NON_BOB_NAMES else []
            subjects += [s for s in split_names(rest_str) if s not in NON_BOB_NAMES]
            if not subjects:
                continue
            dest_type, dest_sys, note = resolve_destination(dest_raw, gaz, aliases)
            for bob in subjects:
                _emit(bob, verb, dest_raw, dest_type, dest_sys, note,
                      pattern_id, m.group(0).strip())

    # Hidden-subject patterns — back-track to find a known Bob in the sentence.
    # Standard/cohort passes already populated `seen`, so dedupe is automatic.
    for verb, pattern_id, regex in (hidden_patterns or []):
        for m in regex.finditer(desc):
            sent_start, sent_end = _sentence_for_position(desc, m.start())
            bob = _backtrack_subject(desc, sent_start, m.start(), known_names)
            if not bob:
                continue
            dest_raw = m.group(1).strip()
            dest_type, dest_sys, note = resolve_destination(dest_raw, gaz, aliases)
            _emit(bob, verb, dest_raw, dest_type, dest_sys, note,
                  pattern_id, m.group(0).strip())

    return out


# ─────────────────────────── main ─────────────────────────────────────

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--events", default="data/events.json")
    ap.add_argument("--gazetteer", default="gazetteer.json")
    ap.add_argument("--genealogy", default="timelines/genealogy.json")
    ap.add_argument("--out-repl", default="data/edges_replication.json")
    ap.add_argument("--out-travel", default="data/edges_travel.json")
    ap.add_argument("--report", default="data/edges_coverage.txt")
    args = ap.parse_args()

    with open(args.events) as f:
        events_doc = json.load(f)
    events = events_doc["events"]

    with open(args.genealogy) as f:
        gen = json.load(f)
    known_names = flatten_genealogy(gen, set())

    gaz = load_gazetteer(args.gazetteer)
    aliases = _build_aliases(gaz)
    dest_re = build_dest_regex(gaz)
    travel_patterns = build_travel_patterns(dest_re)
    cohort_patterns = build_cohort_travel_patterns(dest_re)
    hidden_patterns = build_hidden_subject_patterns(dest_re)

    rep_edges = []
    trv_edges = []
    for ev in events:
        rep_edges.extend(extract_replication(ev, known_names))
        trv_edges.extend(extract_travel(
            ev, known_names, gaz, travel_patterns, aliases,
            cohort_patterns=cohort_patterns,
            hidden_patterns=hidden_patterns,
        ))

    # New names discovered = children in replication not in known_names
    new_bobs = sorted({e["child"] for e in rep_edges if not e["child_known"]})

    # ── write outputs ──
    os.makedirs("data", exist_ok=True)
    now = _dt.datetime.utcnow().isoformat() + "Z"

    rep_doc = OrderedDict([
        ("$schema_version", "1.0.0"),
        ("$generated_at", now),
        ("$source_events", args.events),
        ("$edge_count", len(rep_edges)),
        ("$confidence_breakdown", dict(Counter(e["confidence"] for e in rep_edges).most_common())),
        ("$known_parents_seed", sorted(known_names)),
        ("$new_bobs_discovered", new_bobs),
        ("edges", rep_edges),
    ])
    with open(args.out_repl, "w") as f:
        json.dump(rep_doc, f, indent=2, ensure_ascii=False)

    trv_doc = OrderedDict([
        ("$schema_version", "1.0.0"),
        ("$generated_at", now),
        ("$source_events", args.events),
        ("$edge_count", len(trv_edges)),
        ("$confidence_breakdown", dict(Counter(e["confidence"] for e in trv_edges).most_common())),
        ("$verb_breakdown", dict(Counter(e["verb"] for e in trv_edges).most_common())),
        ("$destination_type_breakdown", dict(Counter(e["destination_type"] for e in trv_edges).most_common())),
        ("edges", trv_edges),
    ])
    with open(args.out_travel, "w") as f:
        json.dump(trv_doc, f, indent=2, ensure_ascii=False)

    # ── coverage report ──
    lines = []
    lines.append("Edge mining coverage report")
    lines.append(f"Generated: {now}")
    lines.append(f"Source events: {len(events)}")
    lines.append("")
    lines.append(f"REPLICATION edges: {len(rep_edges)}")
    for k, n in Counter(e["confidence"] for e in rep_edges).most_common():
        lines.append(f"  confidence={k}: {n}")
    lines.append(f"  by pattern:")
    for k, n in Counter(e["pattern"] for e in rep_edges).most_common():
        lines.append(f"    {k}: {n}")
    lines.append(f"  new Bobs discovered ({len(new_bobs)}): {', '.join(new_bobs) if new_bobs else '(none)'}")
    lines.append("")
    lines.append(f"TRAVEL edges: {len(trv_edges)}")
    for k, n in Counter(e["confidence"] for e in trv_edges).most_common():
        lines.append(f"  confidence={k}: {n}")
    lines.append(f"  by verb:")
    for k, n in Counter(e["verb"] for e in trv_edges).most_common():
        lines.append(f"    {k}: {n}")
    lines.append(f"  by destination_type:")
    for k, n in Counter(e["destination_type"] for e in trv_edges).most_common():
        lines.append(f"    {k}: {n}")
    lines.append("")
    lines.append("Unresolved travel destinations (raw → count):")
    unres = Counter(
        e["destination_raw"] for e in trv_edges if e["destination_type"] == "unresolved"
    )
    if not unres:
        lines.append("  (none)")
    else:
        for d, n in unres.most_common(40):
            lines.append(f"  {n:3d}  {d!r}")
    lines.append("")
    lines.append("Low-confidence travel edges (sample, first 30):")
    low = [e for e in trv_edges if e["confidence"] == "low"][:30]
    for e in low:
        lines.append(f"  RO{e['reading_order']:3d} {e['chapter_code']:10s}  bob={e['bob']!r:14s} dest={e['destination_raw']!r}  src={e['source_text']!r}")

    with open(args.report, "w") as f:
        f.write("\n".join(lines) + "\n")

    print(f"Wrote {args.out_repl} ({len(rep_edges)} replication edges).")
    print(f"Wrote {args.out_travel} ({len(trv_edges)} travel edges).")
    print(f"Wrote {args.report}.")
    print()
    print(f"Replication confidence:", dict(Counter(e["confidence"] for e in rep_edges)))
    print(f"Travel      confidence:", dict(Counter(e["confidence"] for e in trv_edges)))
    print(f"New Bobs discovered ({len(new_bobs)}): {', '.join(new_bobs[:20])}{'...' if len(new_bobs) > 20 else ''}")


if __name__ == "__main__":
    main()
