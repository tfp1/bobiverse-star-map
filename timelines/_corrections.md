# Source Corrections

Edits made to the fan-source files in this directory, with the prose evidence
that justified the change. Per the project's source-trust order
(chapter dateline > book prose > fan compilation), the chapter dateline is the
tiebreaker.

## google-sheet-timeline.csv

### POV: B2 C15 — `Bill` → `Mario`
- **Original**: `,,2180,Nov,2,15,Bill,"Mario gets SCUT and joins Bobnet, reports on Others"`
- **Corrected**: `,,2180,Nov,2,15,Mario,"Mario gets SCUT and joins Bobnet, reports on Others"`
- **Evidence**: B2 chapter 15 dateline reads
  `15. A Visit From Bill / Mario / November 2180 / Gliese 54`.
  The chapter title contains Bill because Bill is visiting; the POV is Mario.
  The wiki CSV had this right.
- **Surfaced by**: cross-check pass in `scripts/normalize_wiki_csv.py`.

### POV: B3 C39 — `Howard` → `Marcus`
- **Original**: `,,2218,Feb,3,39,Howard,"Marcus has no further duties on Poseidon, considers exploring the ocean"`
- **Corrected**: `,,2218,Feb,3,39,Marcus,"Marcus has no further duties on Poseidon, considers exploring the ocean"`
- **Evidence**: B3 chapter 39 dateline reads
  `39. Retirement / Marcus / February 2218 / Poseidon`.
  The wiki CSV had this right.
- **Surfaced by**: cross-check pass in `scripts/normalize_wiki_csv.py`.

Both corrections close GitHub issue #4.
