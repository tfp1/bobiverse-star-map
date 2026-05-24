# Bobiverse Star Map

An interactive web map of the Bobiverse (Dennis E. Taylor, books 1–5), modeled
on [`valhovey.github.io/gaia-mary`](https://valhovey.github.io/gaia-mary/) — a
recreation of the *Project Hail Mary* navigation computer built on real GAIA
DR3 star data. We re-point that idea at the Bobiverse: real nearby-star
positions as the backdrop, with the Bob replication/expansion story drawn on
top.

Unofficial fan-work. No affiliation with the author or publisher.

---

## ⚠️ Start here

**Read [`handoff.md`](./handoff.md) in full before writing any code.** It is the
design brief — the committed decisions, the data model, and (critically) a
conflicts register of canon errors that a fresh session will otherwise get
wrong. It is not a task list; it is context you cannot reconstruct from the
files alone.

The single most important decision up front: this is **graph-first**, not
map-first. The primary object is a directed replication/event graph embedded in
real space; the 3D layout is one view of it. (`handoff.md` §1 explains why
book 5 forced this.)

---

## Repo layout

| Path | What it is |
|------|------------|
| `handoff.md` | **Read first.** Decisions, data model, conflicts, open questions, first-move sequence. |
| `gazetteer.json` | 22-system enum + place→system gazetteer (confidence-flagged), conflicts register, species overlay. |
| `timelines/b1-b3-fan.txt` | Fan timeline, books 1–3 (`date - B#C# - event`). Key source for events + travel edges + reading-order/in-world-date reconciliation. **Unverified.** |
| `timelines/genealogy.json` | Fan Bob lineage tree (~through book 2). Parent/child = replication edges; depth = generation. **Not actually a timeline** despite the folder. |
| `scripts/parse_bobiverse.py` | Dateline parser for books 2–5 (POV/date/location from chapter bodies). Untested against real prose — calibrate on first run. |

Not yet in the repo (the session gathers these from the epubs it has file
access to): the five `toc.ncx` files, the Cast/Genealogy appendices, book-1
navLabel datelines, and books 4–5 events. See `handoff.md` §3.

---

## Source-trust order

When sources disagree (and they do — see `handoff.md` §6):

```
chapter dateline  >  book prose  >  fan compilation (timeline/genealogy)
```

The fan timeline and genealogy are strong scaffolds, not ground truth. The
timeline has at least one self-noted inconsistency. Treat anything marked
`unresolved` in `gazetteer.json` as needing a wiki/prose check before use.

---

## Status

Design + source-gathering phase. Data model and extraction approach are
settled; the **ambition dial** (static explorer → timeline scrubber → guided
story) is an open call for the owner — see `handoff.md` §8. Do not scaffold the
site beyond a static explorer without that decision.

---

## Acknowledgments

Dennis E. Taylor (author) · val hovey (gaia-mary) · ESA/Gaia/DPAC (DR3 data) ·
the fan timeline & genealogy authors (see `handoff.md` §7) · Bobiverse Fandom
wiki (CC-BY-SA).
