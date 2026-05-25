# Bobiverse Star Map — Project Handoff

A handoff brief for a fresh REPL/Claude Code session with GitHub access. You
(the new session) did **not** see the design conversation that produced this.
This document is the transfer of decisions and gotchas, not just a task list.
Read it fully before writing code.

---

## 0. What this project is

A web-based interactive map of the Bobiverse (Dennis E. Taylor, books 1–5),
modeled on `valhovey.github.io/gaia-mary` — a recreation of the *Project Hail
Mary* in-ship navigation computer using real GAIA DR3 star data. We are
re-pointing that idea at the Bobiverse: real nearby-star positions as the
backdrop, with the Bob replication/expansion story drawn on top.

Reference (study, do not assume forkable — see §5):
- Live: https://valhovey.github.io/gaia-mary/
- Source (build output only): github.com/valhovey/valhovey.github.io/tree/master/gaia-mary
- HN thread: news.ycombinator.com/item?id=48225297

---

## 1. Committed decisions (do not relitigate without reason)

**D1 — GRAPH-FIRST, not map-first.** The primary object is a directed
replication/event GRAPH embedded in real space, with the 3D spatial layout as
the *default view* of that graph — not the other way around. PHM is map-first
(one trajectory through real space); the Bobiverse is a branching lineage +
event sequence spanning ~150 years. This was *forced* by book 5: a journey to
Sagittarius A* (~26,000 ly, ~300× the radius of the whole local star cloud)
and wormhole travel cannot be drawn on a literal Euclidean scale. A graph edge
doesn't care about Euclidean distance; a map line does. So: local-bubble
systems get true XYZ; distant/wormhole/megastructure nodes are flagged
non-spatial and drawn with a different convention.

**D2 — Spoiler gating is by READING ORDER (max-book selector 1–5), not by
in-world date.** The series is heavily non-linear (flashbacks; the fan timeline
shows chapter codes wildly out of date order). An in-world-date filter would
leak late reveals into early-feeling moments. Gate the *existence* of nodes,
edges, species, and events — not just their labels — because several entities
(the Others, Bender's fate, the Quinlans) are themselves spoilers. Store BOTH
axes per record: reading-order (for gating) and in-world-date (for spatial
animation/scrubber).

**D3 — The spatial layer is BESPOKE (not commodity); the overlay graph is
still the bulk of the job.** Val's skybox JPGs transfer unchanged, but
`stars-near.bin` does NOT contain most of the systems we care about. Empirical
check (`data/system_to_star_index.json`): **15 of 17** Bobiverse systems we
need — Alpha Centauri, Epsilon Eridani, Epsilon Indi, Eta Cassiopeiae,
Eta Leporis, Omicron² Eridani, etc. — are **missing** from the file. Cause:
Gaia DR3 saturates on bright nearby stars; the original bin is a volume
sample of the faint background, not a catalogue of named hosts.

Resolved this session by appending 19 named-system records to the file
(indices 53836–53854) via `scripts/append_named_systems.py`, with source
positions in `data/named_systems.json`. The bin format is unchanged; the
header count was bumped and records concatenated.

Implication: the spatial layer carries fictional content, so the bin is no
longer a drop-in inherited asset — re-running the append script is part of
the build. ~80% of remaining effort still goes to the overlay graph + UI.

**D4 — Hosting: GitHub Pages**, matching Val. Do NOT deploy onto the owner's
`.coffee`/`.pizza` domains (other services run there; avoid exposure and avoid
associating fan-work with personal infra). Easy to move later.

**D5 — Legal posture:** Facts (who/where/when) are not copyrightable — dateline
and event extraction is fine. Do NOT redistribute prose. Fandom wiki text is
CC-BY-SA (attribute if used). See §7 for acknowledgments.

---

## 2. The data model

Two files with a hard seam between them:

```
stars-near.bin   (commodity, inherited)   — real astrometry, never touched
overlay graph    (the project)            — all Bobiverse content
```

### stars-near.bin format (DECODED — verified by byte inspection)
Little-endian. `uint32` count at offset 0 (= 53836), then `count` records of
5×`float32` (20 bytes each):
```
[0] x parsec   [1] y parsec   [2] z parsec   (heliocentric, Sol at origin)
[3] M  absolute magnitude (Gaia G), faint limit ~13
[4] BP-RP colour index (-0.54 .. 4.58) -> RGB ramp
```
Sphere radius ~83 pc; nearest point 1.30 pc (Proxima distance — Sol itself is
the origin, excluded from the file). It's a VOLUME sample, not brightness-
limited (brightness/distance corr ≈ 0.04).

**CAVEAT:** the ~M<13 faint cut likely dropped the dimmest red-dwarf hosts
(Proxima at M≈15.6 almost certainly absent; Gliese 877, NN 4285 at risk).
A handful of M-dwarf host systems may need manual re-adding when crossmatching.
Run a validation pass that confirms all 20 *physical* systems resolve to a
real index.

### Overlay graph — node/edge schema
```
node (system):  name, type{catalog_star|off_map_distant|megastructure|
                wormhole|internal}, star_id (crossmatch into stars-near.bin,
                null if non-spatial), fictional metadata (planets, colonies),
                first_book (spoiler tier)
node (bob):     name, generation (= genealogy depth), parent, birth/online date,
                first_book
edge (replicate): from_bob -> to_bob, timestamp(approx)   [from genealogy]
edge (travel):    bob, from_system -> to_system, date      [from timeline + datelines]
event:            chapter_code, reading_order, in_world_date, date_precision,
                  pov, location, text, first_book, evidence
```

---

## 3. Source inventory (in ./sources and to be gathered)

### In this bundle
- `timeline_fan_b1-3.txt` — fan timeline, books 1–3. Format
  `date - B#C# - event`. THE key source: gives events[], travel edges (parse
  "X leaves for Y"), and reading-order vs in-world-date reconciliation.
  UNVERIFIED (has a self-noted inconsistency at B1C41/42). Strong scaffold,
  not gospel.
- `genealogy_fan.json` — Bob lineage tree (~through book 2). Parent/child =
  replication edges; depth = generation. Birth years approximate spawn dates.
- `systems_and_gazetteer.json` — 22-system enum, place→system gazetteer
  (seeded from timeline evidence w/ confidence flags), conflicts register,
  species overlay. READ THE CONFLICTS (§6).
- `scripts/parse_bobiverse.py` — dateline parser for books 2–5 (see §4).

### To gather (REPL has file access to the epubs)
- **Books 1–5 toc.ncx** — chapter sequence. (Book 1 also carries datelines in
  the navLabel; books 2–5 do not.)
- **Book 1 datelines** — from navLabel (format `N. POV – date – location`).
  Separate adapter from the body parser; note hyphen-vs-endash drift.
- **Books 2–5 chapter bodies** — datelines in first lines (POV / date /
  location). Use `parse_bobiverse.py`.
- **Cast of Characters + Genealogy appendices** — only **Book 2** carries
  these (`part0085.html` Cast, `part0086.html` Genealogy). Verified by
  inspecting all 5 epubs:

  | Book | Cast | Genealogy |
  |---|---|---|
  | 1 | ❌ | ❌ |
  | 2 | ✅ | ✅ |
  | 3 | ❌ | ❌ |
  | 4 | ❌ (only Glossary of Quinlan Terms) | ❌ |
  | 5 | ❌ | ❌ |

  Do NOT chase phantom appendices in books 3/4/5. Gen-8+ parentage
  (Marcus, Herschel, Neil, Mack, Hugh, Lenny, Mud, Conan, etc.) must be
  mined from B3+ prose directly — see issue #5.
- **Books 4–5 events** — no fan timeline located for these yet (VERIFY one
  doesn't exist before committing to LLM prose extraction). This is the only
  part that genuinely needs prose scraping.

---

## 4. Data extraction — how (be playful here, per owner)

**Sequencing always comes from the ncx via recursive document order.** Do NOT
parse chapter-title numbering for sequence — the format drifts across all five
books (`1. `, `1.` + tab, `1.Face-Off`, `Chapter One:`). playOrder is NOT
unique or dense (book 5 has duplicates and gaps). Walk the ncx tree, follow
`content src` to each file, keep title as a label only.

**Datelines:** book 1 from navLabel; books 2–5 from the first ~15 lines of each
chapter body. Anchor on the DATE line (regex `Month YYYY` or `Month D, YYYY`),
then POV = line above, location = line below. This survives multi-line titles,
missing fields, and front matter (front matter has no date line → skipped).

**Events (books 1–3):** parse `timeline_fan_b1-3.txt`, don't re-scrape prose.
The timeline already encodes travel edges in its event text.

**Replication & travel edges:** `scripts/mine_edges.py` extracts directed
edges from `data/events.json` event descriptions. Current coverage: 40
replication + 48 travel edges, all high/medium confidence, no unresolved
destinations. Pattern families (full docstrings in the script):

- **Replication R1–R7** — clone-self (`R1`), explicit-parent (`R2`), bare-
  POV (`R3a/b/c`), parenthetical-of (`R4/R5`), cohort (`R6`: "Khan and N
  other Bill clones (...)"), and possessive (`R7`).
- **Travel T1–T9** — heads/arrives/leaves/returns/sets-off/in-transit/
  passive-sent-to. Subject and verb may be separated by `together`/`all`/
  `both` ("Calvin and Goku together head to X", "Howard, Bert, and Ernie
  all arrive at Y").
- **`T_COHORT_*`** — mirrors of R6_cohort for the same cohort subject form
  with travel verbs ("Khan and seven other Bill clones (...) arrive at
  82 Eridani" emits 8 edges).
- **Hidden-subject `T*H_*_hidden`** — fires when no NAME_TOK precedes the
  verb; back-tracks within the sentence to recover elided subjects
  ("Marvin decides to leave and heads out to Pi3 Orionis"), with multi-
  subject coordination grouping that follows `,`/`and` markers leftward
  ("Bert and Ernie ... return to Earth" → both). Skips parenthesized
  names, genitives (`of Bill`/`by Bob`), cohort-parents (`other Bill
  clones`), and tokens that fall inside a gazetteer dest-regex match
  (so "Eridani"/"Vulcan" are not mistaken for Bob names).

Coverage report at `data/edges_coverage.txt`; new Bobs surface in
`$new_bobs_discovered` (replication) and as `bob_known: false` rows
(travel — e.g. Hugh, discovered via "Bill and Hugh ... return to
Skippyland").

**Known mining limitations** (tractable, not blockers): the hidden-
subject back-track stops at the first non-coordinated unknown
NAME_TOK to the left of the verb. So "Milo finishes... with a high-
level AMI per the request of Bill (...), then heads out to 82
Eridani" loses Milo — `AMI` is unknown, isn't part of a coordinated
list with Milo, and isn't filtered as a stopword. Recovering this
needs a longer-distance heuristic or grammatical parsing.

**Location resolution:** normalize against the closed 22-system enum, THEN the
gazetteer (place→system), THEN fall through to open categories (en_route,
off_map_distant, megastructure, internal, unknown). Unresolved named places
(Skippyland, KKP, Big Top) flag for prose/wiki lookup — do not force-fit.

REPL is encouraged to run greps/scripts directly on the epub files rather than
working purely from this bundle. The parser is a starting point, not the last
word — it's untested against real chapter bodies (only against ncx + 4
dateline snippets). Treat first run as calibration; widen heuristics from the
`needs_review:true` rows.

---

## 5. What's forkable from gaia-mary

The published repo is **SvelteKit + adapter-static build OUTPUT** (minified,
hash-named bundles in `_app/immutable/{chunks,entry,nodes}`) — NOT editable
source. Commits are co-authored "valhovey and claude" (built with Claude Code),
so readable source exists elsewhere (likely private). Options: ask Val (active
& friendly on HN), or regenerate clean source (owner has a multi-agent Claude
Code setup well-suited to this).

**Directly reusable (in Val's `data/`):**
- `skybox.jpg`, `skybox-color.jpg` — equirectangular GAIA renders, one per view
  mode (Color/Petrova toggle = texture swap). Transfer unchanged.
- `stars-near.bin` — inherited as the base file, but **not drop-in**: we
  append named-system records that Gaia DR3 dropped (see §D3). Treat the
  shipped bin as a build artifact, not a vendored asset.

**CHECK LICENSE before copying verbatim.** GitHub Pages projects often ship no
license (= all rights reserved). Learn from architecture; rebuild if unclear.

**Other references:**
- `Caldis/project-hail-mary` — Three.js + timeline scrubber w/ narrative-order
  vs chronological-order toggle (directly relevant to D2). Closest existing
  thing to what we're building.
- `david-a-wheeler/plot-stars` — static Python coordinate-conversion +
  dropline reference.
- `mkenworthy/3dgaia` — Gaia star-field rendering technique.

---

## 6. Conflicts register (CRITICAL — a cold session WILL get these wrong)

Full detail in `gazetteer.json` and `data/bobs.json._conflicts_resolved` /
`._unresolved`. Summary:

**Resolved this session:**

1. **Poseidon = Eta Cassiopeiae**, NOT Gliese 877. (GL877 is the *Others'* home
   star, destroyed B3C70.) An earlier guess of GL877 was wrong; do not repeat.
2. **Bender's destination = Eta Leporis** (intended Gamma Leporis A, actually
   arrived at Eta Leporis). Wiki row 219 (B4-1 C2) is the canonical source.
   `gazetteer.json` updated.
3. **Vulcan = Omicron² Eridani** (canonical). `gazetteer.json` updated.
4. **Victor/Viktor** — canonical is "Victor". Epub grep: B2 7×, B4 2×;
   "Viktor" appears 0× in prose. `genealogy.json` had the typo;
   renamed in `bobs.json._conflicts_resolved`.
5. **Dexter parent = Charles** (genealogy.json preferred over bob_index.json
   "Riker"). Logged in `bobs.json._conflicts_resolved`.
6. **Thor parent = Calvin** (genealogy.json preferred over bob_index.json
   "Bill"). Logged.
7. **Mulder/Moulder, Jonny/Johnny** — canonical spellings "Mulder" and
   "Jonny". Logged.

**Still open:**

8. **born vs online dates** disagree for the first cohort (2144 vs 2145) —
   define edge-timestamp semantics before trusting either.
9. **`jonny-skinner-born-year`** — sheet has `online_year=2070` for both,
   impossible (pre-Bob's creation 2133). Sheet appears to misread a column.
   In `bobs.json._unresolved`. Tracked in issue #7.
10. **`missing-parents-gen8+`** — Marcus, Monty, Herschel, Neil, Mack, Hugh,
    Lenny, Mud, Conan, ANEC, etc. have no canonical parent from any current
    source. Must be mined from B3+ prose. Tracked in issue #5.
11. **Unresolved system placements** — Quin, Jabberwocky, Skippyland, Gamma
    Leporis. Need prose check. Tracked in issue #3.
12. **POV / parentage disagreements** — B2C15, B3C39 POV calls; Mack's
    children (Isaac/Jack/Owen). Tracked in issue #4.

---

## 7. Acknowledgments to include in the final site

- **Dennis E. Taylor** — author of the Bobiverse.
- **val hovey (valhovey)** — gaia-mary, the project this is modeled on.
- **ESA / Gaia / DPAC** — DR3 star data (standard Gaia acknowledgment string).
- **Fan timeline author** — via Pastebin qwfY3PMU.
- **Fan genealogy author** — Pastebin qwfY3PMU; birth-year data cites
  kurt-anderson.com/main/uploads/2017/04/Bob-by-construction.pdf.
- **Bobiverse Fandom wiki** — CC-BY-SA (if any text used).
- Note: this is unofficial fan-work; no affiliation with the author/publisher.

---

## 8. OPEN QUESTIONS (owner has NOT decided — do not assume)

- **View modes (not exclusive tiers).** The UI exposes three switchable
  modes over the same underlying graph + spatial data — not three separate
  apps:
  - **Explore mode** — free fly-through; all content visible up to the
    reading-order selector (1–5).
  - **Timeline mode** — in-world-date scrubber; nodes/edges appear as their
    date passes (the Caldis device, applied to graph + map together).
  - **Story mode** — guided tour following a chosen POV (Bob, Riker, Bill,
    Bender, Icarus…) chapter-by-chapter.

  The data model already supports all three: reading-order for gating (D2),
  in-world-date on every replication/travel edge for animation, POV +
  chapter_code on every event for story playback. Build Explore mode's
  data plumbing first; Timeline and Story are additive overlays on the
  same graph.
- **Books 4–5 fan timeline** — does one exist? Determines size of the prose-
  extraction gap. Search before committing to LLM scraping.
- **Non-spatial rendering convention** — how to draw Sgr A* (off-scale beacon),
  wormhole edges (topological, no path), and megastructures/internal locations
  (Heaven's River, Skippyland). Decided THAT they're separate; not WHAT they
  look like.
- **Source-of-truth on conflicts** — precedence rule agreed (dateline > prose
  summary > fan compilation), but each conflict in §6 still needs a human call.

---

## 9. Suggested first moves

1. Confirm epub file access; locate all 5 toc.ncx + Cast/Genealogy appendices.
2. Run `parse_bobiverse.py` on book 5 first (most format stress) → calibrate
   from `needs_review` rows → extend to books 2–4 → write the book-1 navLabel
   adapter.
3. Parse `timeline_fan_b1-3.txt` into events + travel-edge tables keyed by
   chapter code; join to the dateline output (this also validates the parser).
4. Flatten `genealogy_fan.json` into replication edges; reconcile §6 conflicts.
5. Search for a books 4–5 timeline; scope the remaining prose-extraction work.
6. Scaffold Explore mode first (§8) — Timeline and Story mode reuse the
   same graph + spatial data and can be layered on after Explore is solid.
```
