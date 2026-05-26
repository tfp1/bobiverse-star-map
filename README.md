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

v0 scaffold landing: SvelteKit + adapter-static + Three.js, with the Gaia DR3
nearby-star sample (`static/stars-near.bin`, extended with 18 named Bobiverse
host systems — see `scripts/append_named_systems.py`) rendered as a point cloud
in Explore mode. The Bobiverse overlay graph (replication + travel edges,
spoiler selector, info panels) is the next slice — see issue #11.

## Run it

```bash
npm install
npm run dev        # localhost dev server
npm run build      # static site → build/
npm run preview    # serve the built site locally
npm run check      # svelte-check + typescript
```

Controls (Explore mode): WASD to fly, drag mouse to look, R/F up/down, Q/E
roll. Sol sits at the origin.

## Deploy

Auto-deploys to GitHub Pages from `main` via `.github/workflows/deploy.yml`.
The workflow sets `BASE_PATH=/bobiverse-star-map` so asset URLs match the
project-page subpath. The site is published at
`https://tfp1.github.io/bobiverse-star-map/`.

## stars-near.bin provenance

The committed `static/stars-near.bin` is **not** the raw Gaia DR3 sample
shipped with gaia-mary. It is that file with 18 records appended for
Bobiverse-relevant named host systems that Gaia dropped to its bright-star
saturation cut (Alpha Cen, Epsilon Eridani, Epsilon Indi, Eta Cas, Eta Lep,
Omicron² Eri, etc.). See `scripts/append_named_systems.py` and handoff.md §D3.
The append is idempotent and one-shot; re-running needs the original 53,836-
record file checked out fresh.

---

## Acknowledgments

Dennis E. Taylor (author) · val hovey (gaia-mary) · ESA/Gaia/DPAC (DR3 data) ·
the fan timeline & genealogy authors (see `handoff.md` §7) · Bobiverse Fandom
wiki (CC-BY-SA).
