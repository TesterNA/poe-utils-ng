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

## Minesweeper

A port of [PoeMinesweeper](https://github.com/SteffenBlake/PoeMinesweeper): a stash search that
hides landmines. A *landmine* is an expensive item parked among cheap ones, waiting for a fast
click. You give the price band you expect to pay and the tool writes the search to paste into the
stash you are buying out of — only items noted that way stay lit, so anything dark is a mine.

The search is a list of space-separated terms which the game ands together; quotes are what let a
term hold spaces. On top of the price band you can pin item level, area level and map tier, filter
on corruption (`pte` is the shortest run of letters that appears in *Corrupted* and nowhere else on
an item, and a leading `!` inverts any term), and append your own terms verbatim. The output is
counted against the 250 characters the search box takes.

The price band is the interesting part: `1` to `20` has to become `([1-9]|1\d|20)`, because a range
stops being a character class the moment it crosses a digit boundary. `regex-range.ts` cuts the
range at every "…999" and "…000" inside it, turns each piece into a pattern digit by digit, and
folds neighbouring pieces that differ only in how many digits are free into one `{n,m}`. It is a
port of [to-regex-range](https://github.com/micromatch/to-regex-range) narrowed to non-negative
integers with no zero padding, so it emits the same string the original tool did.

Being exact matters more here than being short — a pattern that let `100` through when you asked
for `1-20` would light up the landmine it exists to hide. `npm run test:regex` checks every range
up to 60 and 3,000 random ones up to 9,999, in both directions and twice over: anchored, and
embedded in the real search term, where a loose pattern could otherwise match the `1` inside `100`.

Prices are whole numbers, so an item noted `1.5 divine` stays dark. That is the safe way round: the
tool only ever fails towards calling something a mine.

State persists in `localStorage` under `poe_minesweeper_state`, and "Copy link" carries the form in
a `?s=` parameter which is stripped once applied. The payload keys are the ones the original tool
used, so its links open here too.

## Atlas Selector

Interactive Atlas passive tree with two planning modes.

**1 · Path** — the poeplanner behaviour: clicking a node allocates the shortest path from the Atlas
centre through whatever is already allocated. Clicking an allocated node drops it along with
everything that hung off it. Hovering previews the path and its cost.

**2 · Targets** — click as many nodes as you want and the tool works out the tree that takes **all**
of them for the fewest points. "Apply route" turns the result into a real allocation you can keep
extending by hand in mode 1.

Either way the **Summary** tab says what the tree on screen actually grants, mechanic by mechanic,
with everything that says the same thing added together.

### What costs a point

Not every node in a tree is a passive you buy. The Atlas centre is free, and so is the unnamed
junction beside it — the fan-out point with no name, stats or icon that every route crosses. Both
stay *in* the tree, since paths run through them and a share code has to reproduce them; they simply
do not count. Counting the junction is why a full tree used to read 138 points where the game charges
137.

The rule comes from the data (no name and no stats), not a hardcoded id, so a new league's
equivalent is recognised on its own. Neither node can be clicked, so the junction cannot be removed.

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

### What the tree adds up to

A hundred allocated nodes is a hundred lines of "3% increased Scarabs found in your Maps", and
reading them one at a time tells you nothing. The **Summary** adds up the ones that say the same
thing and files each under the mechanic it belongs to, which is the form you would write a strategy
in. Keystones are listed whole instead — they change how maps play, and folding one into a running
total would bury it.

It is a tab of the panel rather than another section of it. A real tree's summary runs to fifty-odd
lines, which is longer than everything else in the panel put together, and having it in the same
scroll pushed Share and Saved builds somewhere you had to go looking for them. The point count, the
tabs and Reset stay put; only the tab's own contents scroll.

Two things make that harder than grouping strings.

**Which number to add.** "Tier 1-15 Maps found have 5% chance to become 1 tier higher" has three
numbers and only the middle one is yours. The parameter is found from the data rather than guessed:
across the whole tree, the number that differs between nodes with the same wording is the one being
handed out, and the rest are part of the sentence. When every node grants the same amount there is
nothing to compare, so it falls back to the numbers written as percentages.

**What the total reads as.** Once a chance reaches 100% the game stops writing it as a chance —
"Your Maps have +100% chance to contain Niko" becomes "Your Maps contain Niko" — but only for the
modifiers GGG wrote a second wording for. "chance for your Maps to attract Beyond Demons" has one
wording and simply climbs past 100%. Nothing in the English says which is which, so it is looked up:
`stat-rules.json` holds the wordings and the ranges they apply over, generated from GGG's own stat
descriptions by `npm run fetch:atlas-stats -- <version>`. The same mechanism reads singular and
plural, so one Blight chest is a chest and two are chests.

The rules come from [RePoE](https://github.com/lvlvllvlvllvlvl/RePoE), an export of the game files.
The atlas set alone is 12 MB and covers every stat in the game, so the script keeps only the ones
this tree uses *and* whose wording can change at all — about 130 rules, a few kilobytes.

A modifier the export does not know — a mechanic newer than it, which currently means most of the
Mercenary and Trarthan lines — is still added up, in the wording the tree already gave it. That is
the same answer minus the threshold rewrite. It is the case worth getting right, because it is where
poeplanner gives up and prints the modifier once with an "×7" beside it, leaving you to do the
arithmetic. Lines with no rule behind them are dimmed, so it is clear which totals are the game's
wording and which are ours.

Which mechanic a modifier belongs to comes from the tree, not from a keyword list: every wheel has a
mastery at its centre naming the mechanic, and that names every node around it. About a fifth of the
nodes sit in wheels with no mastery — the generic Scarab, Map and item-quantity clusters, and the
keystones — and those fall back to matching on the text.

`npm run test:summary` checks that no modifier line is lost or invented, that only the varying number
is summed, that the rewrite fires at 100% for Niko and never for Beyond Demons, and that a modifier
with no rule is still totalled.

### Finding the rest of a mechanic

Most mechanics are spread over several wheels — Mercenaries has five, scattered across the tree —
which makes "have I taken all the Delve nodes?" a question you answer by scrolling around. Hovering
a mechanic in the Summary, or the icon at the centre of any of its wheels, rings every one of its
passives and puts a beacon on each of its other centres. Clicking a centre pins it, so you can let
go of the mouse and go looking; clicking it again puts the tree back.

A cluster centre is a mastery node. Those are decoration — they cost nothing and cannot be
allocated — so they only answer to the pointer when nothing else is under it: they are the largest
things on the tree and would otherwise swallow clicks meant for the passives around them.

### Sharing a plan

"Copy code" produces something like `AT3:AQKKApndluC4YRIx…`; "Copy link" wraps it in a `?c=` URL,
which applies the plan and then strips the parameter so a later refresh keeps your edits instead of
re-importing the original.

A code carries **the finished tree and nothing else**. Targets and blocked nodes are working state
for planning your own tree, so whoever opens your link gets the result — as an allocated tree in path
mode, not as somebody else's targets. Sharing while you are still planning sends the route currently
on screen, which is the same thing one click earlier.

There is no way to make a *short* link without a backend — a short token has to be looked up
somewhere — so the plan travels inside the URL and the only lever is encoding it well. A real 132
node plan is 55 characters, or a 103 character link.

The format is `AT<formatVersion>:<base64url>`. The payload starts with the **atlas tree version** the
plan was built against, so a code can never be silently applied to a different dataset: importing one
for another known tree switches to it, and one for a tree this build does not have is refused by
name.

The tree is never an arbitrary subset — it is always connected to the Atlas centre — so it is stored
as one bit per decision along a fixed walk of the real graph, which the decoder replays. On that 132
node plan the tree alone is 46 characters against 178 as a list of positions, and it beats deflating
the list without needing a compressor. A set that somehow is not connected falls back to a position
list, and a flag says which was used.

Formats 1 and 2 also carried targets and blocked nodes. They still decode, with that state dropped;
a code that held nothing *but* targets still opens as targets, so old links are not dead ends.

`npm run test:share` simulates 500 trees — grown from the centre at every size, plus empty, single
node, the entire tree and deliberately disconnected sets — and checks each comes back node for node,
that older formats read correctly, that malformed codes are refused, and that the tree version
travels with the code. `scripts/share-size.mjs [code]` re-measures the encodings against each other.

### Saved builds

Name the tree on screen and it goes into a library in `localStorage` under
`poe_atlas_builds`; clicking an entry loads it, and the one matching what you are looking at is
marked, so an edit is visible. Saving under an existing name replaces it.

A build is a name plus a share code — about 150 bytes — so a hundred of them is a few kilobytes
against localStorage's ~5 MB. IndexedDB was not used: it buys large values, indexes and transactions,
none of which apply here, and costs an asynchronous API in a component whose state is otherwise
synchronous. It is also no more durable — both live in the same origin storage and are evicted
together, and Safari's ITP clears both after seven days without a visit.

Which is why "copy all" exists: local storage is per browser and per device, so the library needs a
way out that does not depend on it. It produces one `name<TAB>code` line per build, and pasting that
back into the import box merges it in — the same box takes a single code, told apart by the tab.

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
5. `npm run fetch:atlas-stats -- <league>` to write `stat-rules.json` beside the tree

The version selector appears by itself once there is more than one entry. Never renumber an existing
`id` or repoint it at different data — old share codes resolve through it.

Step 5 is optional and can be done later: without it the summary still adds everything up, it just
never rewrites a total that has reached its threshold. Rerunning it is safe — the file is derived
from the tree and the export, and nothing else refers to it.

The `line` and `masteryOverlay` sheets are intentionally skipped — nothing draws them.

## Map Strategy

A tree is only half of what you set up before mapping. The other half is the map device: up to
**five** scarabs and allflame embers, each with its own cap on how many copies one map takes. This
tool holds both, plus a note about how the thing is meant to be run.

It is a tab of its own rather than another panel on the Atlas Selector. A tree and a scarab set have
different lifetimes — the tree lasts a league, the scarabs change with what is cheap this week — and
one tree usually backs several strategies. Keeping them apart lets a tree be swapped without
dragging a device behind it, and lets the atlas share code stay what it already is: a tree and
nothing else.

The tree is attached as an atlas share code, picked from your saved atlas builds or pasted. That is
the join between the two tools, and it is what decides which game version the items are read
against — a code names the dataset it was built against, so a strategy cannot describe a 3.29 tree
and a 3.31 scarab without saying so.

Three things are checked as you build, because all three are things the game would simply refuse:

- **five slots**, counting copies — three of one scarab and two of another is a full device
- **each item's own limit**, which is 1 for most and up to 5 for a few
- **Unwavering Vision**, which says your maps cannot be modified by fragments. With it allocated
  the device takes nothing at all, so the picker goes dead and anything already in there is an
  error. The keystone is found by its stat text rather than its node id, because ids are not stable
  across GGG's exports and the wording largely is.

The picker refuses to add what would break a rule; an imported code is judged rather than refused,
since it may come from a league where the rule was different.

### Item data

`public/assets/strategy/items.json` is every scarab and ember, scraped from
[poedb](https://poedb.tw/us/Scarab) by `npm run fetch:strategy -- <version>`. Icons are downloaded
alongside rather than hotlinked, so the page does not put poedb's CDN in its render path. A couple
of icons that CDN refuses to serve ship as blank — the row keeps the gap.

The file is a **merge**, never a replacement, which is what makes an old strategy readable:

- `code` is the number share codes name an item by. Assigned once, never reused, kept even after
  the item leaves the game.
- `removedIn` is filled in by the first scrape that no longer finds an item. The item stays in the
  file, so a strategy that used it can say "removed in 3.31" instead of showing a blank slot.
- `since` is the mirror for items added later. It is absent on everything the first scrape saw:
  those existed at or before the earliest version we ever looked at, and pinning each to the league
  it was introduced in would be inventing data the scrape never had.

So adding a league is `npm run fetch:strategy -- 3.30` after the tree for it is in place. Rerunning
against a version already in the file is safe and idempotent.

### Sharing a strategy

`ST1:…`, the same shape as the atlas codes, and "Copy link" wraps it in a `?s=` URL which is
stripped once applied. It carries the tree, the items and the notes — a real one with a 20 point
tree and a note is about 110 characters.

The atlas plan travels as the raw bytes out of its own code rather than as the code's text: base64
of base64 would cost a third more for nothing, and re-encoding through a decode would quietly
upgrade an old atlas code to the current format and change what the tree meant. The paste box takes
an atlas code too — pasting the tree you just planned into the only paste box on the page is the
obvious thing to try — and a tab tells an exported library from a single code, the same way the
atlas one does.

`npm run test:strategy` covers the format round trip (including an embedded older atlas code, notes
with an emoji, and item codes past one varint byte), the three rules, the version arithmetic, and
the shipped data itself: distinct codes, distinct ids, every named icon actually present.
