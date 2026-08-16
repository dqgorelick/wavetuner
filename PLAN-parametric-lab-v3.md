# PLAN — parametric lab v3

*2026-08-14. ✅ **BUILT** — implemented in `parametric-lab.html` the same day.
v2 is frozen at `parametric-lab-v2.html` + `SPEC-song-ui-manifest-v2.md`
(⛔ don't edit the frozen copies). This file is v3's reasoning record, the
way `PLAN-parametric-lab-v2.md` is v2's.*

---

## 0. What changed

v2 was `patch → [gates + one global weight table] → manifest → (genome, seed)
→ faceplate`. v3 makes the weight table **per-recipe and editable**:

```
RECIPE = patch + likelihood table (+ voice range)
recipe → manifest → (genome, seed) → faceplate     weights live IN the recipe,
                                                   edited in the lab, persisted
```

Dan's framing: *"each should be a different recipe, and then from there we
can generate the batches."* A recipe is a distribution over plates, not a
plate — which is also exactly what the app will do per song (§6).

## 1. Recipes and their weights

`RECIPES` replaces `SONGS`. Each entry is a patch plus `weights: {id: 0…1}`:

| value | meaning |
|---|---|
| absent | never on this recipe's plates |
| `1.0` | always there — the `**` tier, now *per recipe* |
| between | the draw rate the grid's slider shows |

The four shipped recipes are Dan's, verbatim:

1. **hello world · sine waves** — mute, pan, remix, tune, saturation, level.
   `shaping: false` kills tone family + wave screen in one field.
2. **square waves · immediate slide** — pan, mute, lpf(+peak), reverb, remix,
   tune, levels, saturation, width, wave screen. Square-only ⇒ width legal,
   shape not.
3. **cello grain** — pan, mute, lpf(+peak), reverb, remix, tune, levels,
   noise. Granular ⇒ no tone family, no screen, `voices: [2,4]`.
4. **sine waves + extras** — hello world + noise, lpf(+peak), shape, fold,
   wave screen. Full wave list, because a shape knob needs something to morph.

Plus `full console (stress)` — still AUTHORED (`controls: [...]` bypasses the
weights), kept as the doesn't-fit failure case.

Notes that fell out of writing them:

- **"peak" is not a row.** `lpfPeak` is a partner — it rides in on `lpf` 1:1
  (verified 340/340 over 400 draws). Dan's "filter (LPF), peak" is one row.
- **`scope` (the waveshape viewer) IS a row** — a witness in the renderer, but
  an element of the recipe's list exactly as Dan wrote it. Its weight is the
  strong-case rate; the weak case (saturation alone) fires at 0.4× of it
  (v2's 0.7/0.3 ratio preserved). ⛔ The patch still gates it absolutely —
  a slider at 100% on cello grains draws nothing.
- **Tiers now read the recipe.** The renderer's size floor / strand rules
  (`tierOf`) use the recipe's weight, not the catalog's — the manifest
  carries `weights` through for exactly this.

## 2. The weight grid (the editor, rebuilt)

`edit recipe` opens rows — **every element the manifest can carry is a row**,
family-tagged, in family order, the wave screen last as family `screen`.
An active row **grows a likelihood column**: the slider and the percentage
(100% renders as `always`, green). Inactive rows keep the column's space
(`visibility`, not `display`) so the grid never reflows as you toggle.

- Patch-illegal rows are greyed + struck **with the reason on hover**, never
  hidden (v2's rule, kept).
- Dependency notes ride in the row, ellipsized: `+ peak rides in`,
  `offered only with pans`, `needs remix/tune`, `one filter kind per plate`.
- Ticking a row on seeds it at the catalog's v2 rate (scope at 0.7); a slider
  dragged to 0 removes the id from the table.
- The patch strip leads, with **voices as a min–max pair, 2–6** (Dan's range).
  Inputs cross-clamp rather than erroring.

## 3. Persistence — localStorage is the database

Every edit (weights AND patch) writes through to `RECIPES` and autosaves to
`wt-parametric-lab-recipes-v1` — a stored recipe replaces its default whole,
so a slider stays where you left it across reloads; recipes the store has
never seen keep their shipped defaults.

- **export recipes** downloads `parametric-recipes.json`
  (`{version: 3, recipes}`) — the file that will seed the Swift side.
- **import** accepts that file (or a bare recipe map) and merges by key.
- **reset recipe** restores the current recipe's shipped values.
- The taste export (`export json`) now embeds `recipes` too, so a rating
  session carries the distribution it was rated under.

⚠️ All rating keys bumped (`-v5` / `-locks-v4` / `-gens-v3`): v3 adds a gene
and rebases manifests on recipe weights, so v2's votes stay on v2's keys.

## 4. Voices 2–6

`patch.voices` is now a **range** (`[2,6]`; a bare number still reads as a
one-value range — the stress plate). The count is **the draw's first act**,
so it is stable per `manifestSeed` no matter how the sliders move afterwards.
Clamped 2–6.

What 5–6 voices changes downstream:

- Stems, orb handles, mute/pan grids, fader rows all already size off the
  resolved count. `square` degenerates honestly (5 = 3+2, 6 = 3×2).
- ⛔ **No cluster at 5+** — Dan: *"for 5 it might not look appealing in a
  cluster."* The levels+pans pair flattens to separate blocks and the mute
  never joins. A constant, not a gene: it is a legibility floor, not a taste.

## 5. Dan's dependency rules, and where each landed

| Dan's note | mechanism |
|---|---|
| mutes and pans similar style, most of the time | already `shapeLink` 85/15 (v2) — unchanged |
| remix + tune generally a little smaller | `sizeMul: 0.85` on both (catalog, so it holds on every plate) |
| detune as "tune drift", mostly close to remix + tune | relabelled **drift**, moved to the `action` family, glue pairs `tune+detune` and (fallback) `remix+detune`; the back face's drift renamed **wander** so the two never share a name; `tuning` family deleted (empty) |
| largest knob ≈ LPF | `sizeMul: 1.25` on `lpf` and `filter`, **plus** `heroPick` biased 0.44 toward filter |
| pans more prominent | `PANMARK = 1.2 × VMARK` — bigger mark, same shared cell so matched sets still align |
| peak next to LPF | already the concentric pair (v2) — unchanged |
| waveshape banner in other places than the top | new gene **`scopeSlot`**: `lead · mid · end` for banner/hero screens; `mid` slips between the two shelves nearest the middle, falls back to `end` on a single-row plate |

The catalog owns the size hierarchy (`sizeMul` multiplies tier × hero); the
genome still owns everything else — so the hierarchy holds on every plate
without stealing a gene's job.

## 6. The iOS handoff (song save → SongUI)

The lab's loop is now literally the app's intended loop: **enter a song →
regenerate the plate from the recipe → show the seed → save it if liked.**
Mapping, per `SPEC-patch-to-faceplate.md` §5:

| lab | app |
|---|---|
| recipe key | the song (its patch projects the gates; the weights are the song's `ui` recipe) |
| `manifestSeed` | `SongUI.manifestSeed` — WHICH controls + HOW MANY voices |
| `genomeSeed` | `SongUI.genomeSeed` — layout + style |
| weight table | ships in `parametric-recipes.json`, ported as data (⛔ one table, two runtimes — port the table, never fork the code) |

- Every card's meta shows both seeds + the voice count
  (`g4f921a m57e6 · 6v`); the zoom modal shows the **`song.ui` json,
  click-to-copy** — the exact object a saved song would store.
- **draw-per-card is now the default batch mode** (style mode is one
  checkbox / `?batch=style` away): rating the distribution is the point,
  because the app will draw from it, not from one arrangement.
- ⚠️ The voice count is drawn from `manifestSeed`, which matches "it will
  depend on the voices" only if the app lets the draw own the count. If a
  real song's `oscillatorCount` must win instead (the §1.3 projection),
  the app passes a one-value range — the sampler needs no change.

## 6b. Champions — what a wave of breeding leaves behind

*Added 08-15, after Dan's first breeding session.* Converging on a plate
produced nothing durable, because none of the three stores can hold one:

- **the seed can't** — a bred genome's `seed` is a fresh `newSeed()`, so
  `drawGenome(seed)` returns a *different* plate. ⛔ For anything
  `bred: true` the seed is a label, not a recipe. The card meta and the
  modal's `song.ui` json are only truthful for randomly-drawn cards.
- **`ratings` can't** — flat, unlabelled, and `evolve` only reads its
  last 24 rows.
- **`generations` can't** — `GEN_CAP` 40 with an oldest-first `shift()`,
  so around wave eight the early waves fall off the front.

So **★ / `S` banks a champion**: a record that is *resolved, never
referenced* — `genome` (all genes), `manifest` (controls + voices as
drawn), `recipe` (deep-copied, so a later slider drag can't rewrite the
conditions it was chosen under), `locks`, both seeds + `bred`/`parents`,
a name, notes, and **the rendered SVG**.

⭐ The SVG is the point. genome+manifest+recipe are the tier-3 packer's
**input**; the SVG is its **expected output**. A folder of these is a
golden-file suite to port Swift against — without it a champion is a
spec with no acceptance test. ⚠️ `svgFor` prefers the *stored* picture
and only re-renders as a fallback: a regenerated SVG uses today's
renderer and so cannot witness what the plate looked like when chosen.

⚠️ Resolved rather than seed-referenced on purpose — seeds only
reproduce a plate while the sampler's draw order never changes, and it
will (v3 added a gene, which is why every key bumped). This is the same
argument as §6's storage note, and it is why the app should store the
resolved plate too.

`wt-parametric-lab-champions-v1` · `export/import champions` →
`parametric-champions.json` (`kind` + `version`, merged by `id`, so
re-importing your own file is a no-op). ⚠️ On a localStorage quota
failure the list is re-persisted **without** pictures rather than lost —
genes are irreplaceable, pictures are regenerable.

Fixed on the way: `#modal .genes` had no height cap, so on a short
window flex-centring pushed the column's top to a negative y — the
champion button was literally unclickable. Now `max-height: 92vh` +
scroll.

## 6c. v3.1 — mutes and levels are one question

*2026-08-15, Dan: "mute/unmute kind of accomplishes the same thing as a
mixer but with less granularity … the cluster can be mute and pan, mixer
and pan, but never all three, and each can also be individually added."*

`mutes` and `levels` now share an **`xor` group** (`voiceCoarse`) — the
same mechanism as one-filter-kind-per-plate. At most one per plate;
neither is fine (the group has no floor); each still stands alone. The
cluster is therefore always a **pair**, never a triple:

| strip | head | foot |
|---|---|---|
| `mixer` | fader track | pan |
| `mute` | mute cap | pan |

⭐ One object with the head swapped, not two objects — `clusterBlock`
takes a `kind` and everything else (scatter, stem spacing, bounding box,
`VMARK`) is shared, so a voice reads the same way in both and
`mixerScatter` needs no second calibration.

- ⛔ **`mutePlace: cluster` changed meaning** — it was "the mute joins
  the mixer", which was the banned triple. It now gates the mute+pan
  pair, so the gene keeps a real job and the other three placements keep
  mutes and pans as separate blocks. Falls back to square with no pans,
  and at 5+ voices where no cluster is allowed.
- `mixerScatter`'s `needs` widened to `pans && (levels || mutes)` — left
  alone it would have reported "inert" on the very plates it was visibly
  scattering.
- New `LAST_CLUSTER` witness (`'mixer' | 'mute' | null`), same pattern as
  `LAST_HERO`, shown on the card meta. ⚠️ It is the only honest way to
  ASK whether a plate clustered: `labels: hidden` suppresses the drawn
  label and the standalone mute grid carries the same word, so reading
  the SVG cannot tell you.
- ⚠️ The stress plate is unaffected — `controls: [...]` bypasses the
  weights, so it still carries both. That is what it is for.

### The split is now a decision — 40 · 40 · 20 (Dan, same day)

The first cut left the ratio to draw order (mutes ~70% · levels ~14%,
from two equal 0.7 weights — whichever member the shuffle reached first
claimed the group). Two sequential coin-flips simply cannot express a
chosen split, so `voiceCoarse` became **one categorical draw**:

```
total = Σ member weights, capped at 1     ("something coarse")
share = w / Σ member weights              (which one)
```

⭐ The sliders keep meaning exactly what they read: **a member's weight
IS its share of all plates.** `0.4 + 0.4` → 40% mutes · 40% levels · 20%
neither, measured 39.6–40.8 / 39.2–40.8 / 19.6–20.5 over 20k draws per
recipe. Move them and the rates follow: `0.6/0.2` → 60/20/20, `0.5/0.5`
→ 50/50/0, and a sum over 1 saturates (0.9/0.9 → 50/50/0, no neither).

- ⛔ `CATEGORICAL_XOR` lists which groups get this. **`filterKind` is
  deliberately absent** — adding it would move the filter rates §5
  measured, so lpf stays at 0.85 (verified 85.1%).
- ⛔ **`levels` dropped `ridesWith: 'pans'`.** A categorical member
  cannot be a rider — its rate would land at share × P(host) = 28%, and
  the slider would stop meaning what it says. Dan's "each can also be
  individually added" licenses it, and the rider's original job is
  obsolete: it was calibrated against pans at 0.35, where it lifted the
  cluster from 6% to 18%; the recipes weight pans at **0.7**, so the
  mixer strip now lands near 28% of level-bearing plates without it.
  ⚠️ Consequence: faders with no pans, on ~12% of all plates.
- The four recipes' `mutes`/`levels` weights moved 0.7 → **0.4**. Dan's
  recipe *lists* are unchanged — a weight is a rate, not membership.

🔴 **The two strips are not equally likely, and that is a gate not a
weight.** The mixer pair fires automatically; the mute pair is gated on
`mutePlace: cluster`, one of four equal placements. So:

| | fires on | why |
|---|---|---|
| mixer strip | ~8–13% of plates | `levels × pans × pairStyle × <5v` |
| mute strip | ~2–3% of plates | the same, **× ¼** for `mutePlace` |

About one card in forty. If the mute strip should be as common as the
mixer's, the fix is to bias `mutePlace` toward `cluster` or to make the
mute pair unconditional the way the mixer pair is — a taste call Dan has
not made, so nothing was invented for it.

### Fader pitch, both orientations (Dan, same day)

*"More of a gap for the horizontal levels, to match the vertical levels
gap."* The horizontal set sat on a **13pt** row against the vertical
set's **20pt** lane, at the same track thickness either way — so the same
four faders read tight lying down and airy standing up. Both now take a
shared `VLANE = 20`, so they cannot drift apart again.

⚠️ Still unscaled by `knobSize`, unlike the `VCELL` immediately above it
in the source — at the top of that gene's range the faders stay put while
the mutes and pans grow. Left alone deliberately: matching them is a
separate change with its own look.

## 6d. v3.2 — the lab freeze (2026-08-15 evening)

*The pre-P1 gate of `wavetuner-native/ios/SPEC-parametric-faceplates.md`
§13: promote what ~1,600 ratings and 146 champions already say from
"what Dan keeps picking" into "what the lab draws". Four changes, all in
`parametric-lab.html`.*

**1 · Layout caps in the packer — rows ≤ 3, columns ≤ 4.** Constants
(`ROW_CAP`/`COL_CAP`), not genes: they belong to the 393×292 pane, and
the iPad pass re-reads them off a bigger one. Enforced as a post-pack
invariant, two mechanisms:

- *rows*: the decision is taken straight after `packRows()` and before
  the first `rng()` of the place pass — unit building and packing are
  pure — so an over-cap rows plate simply lays out as **columns**
  instead, at no cost to the seed. Data says a 4-row plate is 10% liked
  and a 5-row plate 0%, so there is nothing to preserve.
- *columns*: the existing merge loop stops when a merge "buys no fit";
  past the cap a second loop keeps taking the highest-fit adjacent merge
  (ties left-most) until ≤ 4. Refusing there would have left the
  invariant unenforced on exactly the plates that need it.

⛔ Deterministic per seed — an over-cap plate is re-laid, never
re-rolled. `g.flow` stays the gene that was drawn; the effective flow,
and what the cap did, go to `__WT_DEBUG` as `flow` / `flowGene` / `cap`.

**2 · Locks, bounds and a bias** (§12 champion consensus): `shapeLink =
matched` (85% of champions) and `dividers = hairline` (79%) are LOCKED,
`knobSize` is BOUNDED to [1.5, 2.3] (champions live in 1.52–2.28; the
top of the old range forces shrink-to-fit and correlates with dislikes),
and `flow` gets a **15/85 bias toward columns** (89% of champions). The
lock store key bumps to `-v5` and seeds these three as defaults; the
defaults win once, on the way up from v4, and the stored copy wins
after — so unlocking one in the chips still sticks. ⛔ No rating-store
key bump: gene names are unchanged, only the draw distribution moved.

**3 · Champion goldens.** `staleWitness`, not `precap`. The measurement
behind §13.3's "26 champions over-cap" does not survive replay: under
today's packer **no champion exceeds either cap** (max 4 columns, max 3
rows, the cap never fires on one). What is real is that **28 of the 146
were starred before the 18:02 column-merge pass** and their stored SVGs
are pictures of a packer the lab no longer has — that is where the 5–6
column champions came from. So the export (v4) gains, per champion:
`current` = today's element boxes + flow + cap, and `staleWitness` +
`current.svg` for those 28. The Swift golden test asserts against
`current`; `svg` stays the untouched historical witness.
⚠️ Stale is judged on SHAPE — `svgShape()` normalises colours away —
because a champion starred in light and re-rendered in dark differs in
hundreds of characters and not one box (118/146 matched byte-for-byte in
light, 0/146 in dark; the same 28 come out stale in either).

**4 · The exports carry their draw conditions.** `locks`/`excludes`/
`bounds` now ride in the **recipes** file as well as the fixtures one
(recipes v4, `caps` alongside for the port's benefit). An app that
shipped the recipe table without the locks would draw genomes the
fixtures never saw, and the parity suite would be green while the two
runtimes disagreed on every plate.

⚠️ The re-export ran headless, so it has **no `simStore`**: all 200
fixture cases are the deterministic `0xf1c7…` seeds and none is marked
`stored`. Nothing is lost — Dan's own export from the browser will pick
his songs back up.

## 7. Verified (headless Chrome, 35 checks + 58 for champions + 30 for v3.1, all green)

Boot clean on file://; 5 recipes; per-recipe pools exact (hello world can
only draw its six ids; cello never draws tone or screen; square gets width
never shape); remix 400/400; tune ≈ 0.5; peak rides lpf 1:1; levels never
without pans; draws deterministic per seed; 200-plate render smoke + all
scopeSlot × scopePlace combos NaN-free; grid rows gate/appear correctly;
slider edits write through to localStorage and survive a fresh load; reset
restores; card meta + modal `song.ui` present.

Champions (51 + 7): star saves/un-saves from card, modal and `S`; record
carries every gene, a resolved manifest, a deep-copied recipe (proved by
mutating a weight afterwards), locks and both seeds; **`drawGenome(seed)`
≠ the stored genome on a bred champion** — the assertion that makes
storing the object load-bearing; name/notes write through; survives
reload; export tagged `kind`+`version` with SVGs (~14 KB/plate); import
by file picker restores genome+SVG, merges by `id` idempotently, and
rejects a non-champions file; no star in sweep mode.

v3.1 split (12): 40/40/20 holds within ±1.5pt on all four recipes over
20k draws each; the sliders steer it (0.6/0.2 → 60/20/20, 0.5/0.5 →
50/50/0, 0.9/0.9 saturates); `filterKind` measurably unchanged at 85.1%;
1000-plate smoke NaN-free.

Fader pitch (3): a run of *voices−1* equal gaps exists in every case at
3·4·5·6 voices in both orientations, and that pitch is **20** in all
eight. ⚠️ Measured off the drawn SVG, scanning from every start index —
the plate's chrome emits rects of the same shape (the master VOL rail at
x 22.5), and one landing between two lanes silently split a naive run.

v3.1 (15): mutes+levels never co-occur over 8k weighted draws; both
strips fire; mute-only / level-only / neither all still happen;
`mutePlace≠cluster` never fuses (1.5k cases) and `=cluster` with pans
under 5 voices always does (2k cases); falls back with no pans; no
cluster of either kind at 5+; 1000-plate smoke with the cluster forced,
NaN-free; the authored stress plate is untouched by the xor.

v3.2 caps (§6d): **3,500 draws — 700 × all five recipes — 0 over-cap
plates**, counting the packer's own lanes (distinct `ri`) against the
cap for the flow it actually used. The cap had to act on 673 of them
(19%): 482 column merges, 95 rows→columns, 96 both. Distribution lands
where the ratings wanted it — 84.5% columns, and rows plates only ever
at 1–3 shelves. Fixture spot-checks: every genome `shapeLink=matched`
and `dividers=hairline`, `knobSize` inside [1.502, 2.297], flow 169/31,
voices 86·53·50·6·5 for 4·2·3·6·5. Champions: 0 over-cap, 0 capped, 28
stale witnesses, identical set under both themes. Every lab mode boots
clean (batch · sweep · pick · app), the app sim enters and shuffles all
five songs with no console error, and the stress plate — 20 controls,
the deliberate failure case — comes out at exactly 4 columns.

## 8. Open — needs Dan

1. **Weights per element are flat probabilities.** Should a recipe also
   bound cost (a per-recipe BUDGET row) so "very simple" is enforced, not
   just likely?
2. **`scope` weak-case at 0.4×** of the slider — good ratio, or should the
   grid show the weak rate as its own row once a recipe leans on saturation?
3. **Recipe authoring in the lab** — new-recipe / rename / delete buttons,
   or is editing the four (plus import) enough for now?
4. **`?batch=style` vs draw-per-card** — right default?
5. When the app regenerates on song entry, does a **saved** seed pin both
   seeds, or genome only (fresh layout each visit, same controls)?
