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

**D3 — The spatial layer is a commodity; the overlay graph is the whole job.**
Val's `stars-near.bin` (54,836 stars, all within ~83 pc) and both skybox JPGs
transfer UNCHANGED — the real sky behind a local-bubble story is identical to
PHM's. Every physical Bobiverse system (all within ~30 ly) is ALREADY in that
file as an anonymous point. We are NOT adding stars; we are identifying which
existing points are named systems and attaching fictional metadata. ~100% of
original effort goes into the overlay graph + UI.

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
- **Books 1–5 Cast of Characters + Genealogy appendices** — extends lineage to
  ~24th generation (Heaven's River), defines POV enum and spoiler tiers, types
  entities (Bob vs Deltan vs human vs rival replicant). HIGHEST-VALUE
  remaining grab.
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
- `stars-near.bin` — see §2. Reuse as-is, or regenerate to re-add faint M
  dwarfs + flag named systems.

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

Full detail in `systems_and_gazetteer.json`. Summary:

1. **Poseidon = Eta Cassiopeiae**, NOT Gliese 877. (GL877 is the *Others'* home
   star, destroyed B3C70.) An earlier guess of GL877 was wrong; do not repeat.
2. **Bender's destination:** timeline says "Gamma Leporis A"; wiki list says
   "Eta Leporis". Resolve — Bender is book 4's search target.
3. **Victor/Viktor:** genealogy spells "Viktor" (born 2165); timeline says
   "Victor" cloned 2174 alongside a "Pete" missing from the genealogy.
4. **born vs online dates** disagree for the first cohort (2144 vs 2145) —
   define edge-timestamp semantics before trusting either.
5. **Genealogy JSON is ~through book 2.** Book 3+ Bobs (Marcus, Herschel, Neil,
   Icarus, Daedalus, Mack) are missing. Icarus is a book-5 POV — that line
   persists to the end.

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

- **Ambition dial.** Three tiers, escalating: (a) static spatial route explorer;
  (b) spatial map + timeline scrubber that grows the graph over in-world time
  (the Caldis model — highest-value single device for this material); (c) guided
  story mode + free explore. Data now supports (c), but the owner has not picked.
  **Ask before building beyond (a).**
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
6. THEN pause for the owner's call on the ambition dial (§8) before scaffolding.
```
