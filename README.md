# PoE Tools (Angular)

Angular rewrite of the vanilla-JS [poe-utils](https://github.com/TesterNA/poe-utils) site, plus a
new **Atlas Selector** and **Kingsmarch Shipment Planner**.

## Running

```bash
npm install
```

```bash
npm start
```

Open http://localhost:4200

```bash
npm run build
```

## Structure

- `src/styles.css` — the original PoE theme, carried over verbatim so every tool looks the same as
  before. All the `poe-*`, `tool-*`, `.trade-*`, `.exp-*`, `.chrom-*` classes live here, plus a new
  `ATLAS SELECTOR` section. Components deliberately have no `styleUrl`.
- `src/app/tools.ts` — the single list of tools; the sidebar reads from it.
- `src/app/app.routes.ts` — one lazy route per tool. Paths match the old site's hash ids, so the
  old `#exp` maps onto `/exp`.
- `src/app/shared/` — `poe-tool-page` (header with pips/title/subtitle) and `poe-card` (the bordered
  panel with ornamental corners) used by every tool.
- `src/app/tools/<id>/` — one standalone component per tool, state held in signals.
- `public/vendor/PoEChromaticCalc.js` — the vendored Haxe-compiled Vorici solver. It is fetched on
  demand by `chromatic-solver.ts` rather than from `index.html`, because it self-invokes a `main()`
  that walks the original page's DOM. The loader hands it a throwaway hidden host with the two ids
  it dereferences, so it finishes silently instead of throwing on every page load.

## Kingsmarch Shipment Planner

You enter what is in the warehouse and the shipment value you are aiming for; the tool works out
which units to load. Every resource takes a spending priority (*spend first* → *don't ship*), an
optional Favoured Resource quota (+20% … +100%, which multiplies its value per unit), and the
shipment can be topped up with Thaumaturgic Dust. State persists in `localStorage` under
`poe_kingsmarch_state`.

Reaching a target costs exactly that much value however it is split, so there is no "cheaper" mix —
the priorities only decide *which* goods pay for it. `shipment-solver.ts` therefore minimises
`Σ value × weight` subject to hitting the target exactly, which is a min-cost bounded knapsack where
the item weight *is* the shipment value.

Targets run to 50,000,000, so a DP over the whole target is out. It is solved in two passes:

1. **Bulk** — spend whole resources in priority order until only a 40,000 window is left. With a
   linear cost that prefix is exactly what the LP relaxation would do, so nothing is given away by
   fixing it. Each resource holds back 2,000 value for the second pass; without that reserve the
   bulk pass drains every cheap resource and hands the tail a set whose values share a factor (ship
   out all the ore and what remains is 90/12/15/18/21/24 — all multiples of three), and two targets
   in three become unreachable.
2. **Exact** — min-cost bounded knapsack over what is left. Each resource is done in one O(span)
   sweep with a monotone deque rather than by binary-splitting its stock: walking one residue class
   mod `value`, taking `t` units means reaching back `t` places, so the state is a sliding minimum.

Quotas are whole tenths, so the moment one is set the whole calculation moves to tenths of a point
to stay on integers.

## Atlas Selector

Interactive Atlas passive tree with two planning modes.

**1 · Path** — the poeplanner behaviour: clicking a node allocates the shortest path from the Atlas
centre through whatever is already allocated. Clicking an allocated node drops it along with
everything that hung off it. Hovering previews the path and its cost.

**2 · Targets** — click as many nodes as you want and the tool works out the tree that takes **all**
of them for the fewest points. "Apply route" turns the result into a real allocation you can keep
extending by hand in mode 1.

### How mode 2 is solved

Every atlas passive costs exactly one point, and a tree with `V` nodes has `V-1` edges — so "fewest
points" is exactly the **Steiner tree** problem with unit edge weights. The terminals are the Atlas
centre plus every picked target.

1. **Constructive heuristic** (`steiner.ts`) — shortest path heuristic with randomised restarts,
   then local improvement and removal of redundant nodes.
2. **Candidate pruning** — a node `v` can only belong to a tree of cost `≤ UB` if
   `(d(v,a) + d(v,b) + d(a,b)) / 2 ≤ UB` for every pair of terminals `a,b`. This usually cuts the
   ~900 node graph down to a couple hundred.
3. **Exact pass** — Dreyfus–Wagner (DP over terminal subsets) on the pruned graph, with edge
   relaxation by Dial's algorithm. Results are labelled "✓ optimal".

The exact pass realistically covers about 13–15 targets within a few seconds; past that the
heuristic result is returned, marked "≈". Everything runs in `solver.worker.ts`, and rapid clicking
is debounced — a stale search is abandoned by discarding the worker.

State (mode, tree version, allocated nodes, targets, blocked nodes) persists in `localStorage` under
`poe_atlas_state`. The URL is only used to carry an inbound share code or tree version, and both are
stripped once applied.

### Sharing a plan

"Copy code" produces something like `AT1:AQExAg4LBzIF…` — a full 138 point tree is about 220
characters. "Copy link" wraps the same code in a `?c=` URL; opening it applies the plan and then
strips the parameter, so a later refresh keeps your edits instead of re-importing the original.

The format is `AT<formatVersion>:<base64url>`. The payload starts with the **atlas tree version** the
plan was built against, so a code can never be silently applied to a different dataset: importing one
for another known tree switches to it, and one for a tree this build does not have is refused by
name. Node positions are stored as gaps between allocatable nodes sorted by id — a numbering derived
from the tree data alone, so it is identical for everyone on that version. See `share-code.ts`;
`npm run test:share` checks round-tripping and that malformed codes are rejected.

### Adding a tree for a new league

Tree data and sprite sheets come from GGG's official export,
[grindinggear/atlastree-export](https://github.com/grindinggear/atlastree-export). Each version lives
in its own folder because icons and sheet layouts change between leagues — the data and its art have
to move together for an old plan to stay renderable.

1. create `public/assets/atlas/<league>/`, e.g. `3.30/`
2. copy `data.json` into it as `tree.json`
3. copy these sheets (the sharpest zoom level, which is all the renderer draws) alongside it:
   `atlas-skills-4.jpg`, `atlas-skills-disabled-4.jpg`, `atlas-frame-4.png`, `atlas-mastery-4.png`,
   `atlas-group-background-4.png`, `atlas-background-4.jpg`, `background-4.png`
4. add an entry to `TREE_VERSIONS` in `tree-versions.ts` with the next free `id`

The version selector appears by itself once there is more than one entry. Never renumber an existing
`id` or repoint it at different data — old share codes resolve through it.

The `line` and `masteryOverlay` sheets are intentionally skipped — nothing draws them.
