# PLAN — parametric lab v4: the guidance round — ✅ BUILT 08-15 late

*All five items landed in `parametric-lab.html` on 08-15, verified with
a 46-check headless suite (scratch, v3 §7 pattern) — highlights: the
synced `…fixtures_200cases_2026-08-15-2053` export replays **bit-for-bit
(200/200 cases)** through the edited lab (sampler untouched, iOS parity
suite needs nothing); v5→v6 rating migration verbatim; champion weight
demonstrably pulls a synthetic gene positive; the sim's filtered rolls
chase a synthetic model while the off/model-less path costs exactly one
`newSeed()`; pins carry an out-of-bounds float verbatim into a draw;
`?voices` narrows batch+pick while both exports stay byte-identical.
Per-item as-built notes inline below. Remaining follow-through = §6's:
**Dan exports taste from his browser** (now with champions in the fit)
→ sync → parity.*

*2026-08-15 late. Five lab-side work items that sharpen how the app's
generated faceplates are guided, following the P8 taste filter landing
app-side and Dan's closing decision round (iOS spec §9.13: champions
never ship — generative-only; the lab is where the system LEARNS).
Scope: `wavetuner/parametric-lab.html` only. No Swift work in here —
one item ends with a data re-export the existing iOS pipeline already
consumes.*

*Read first: `PLAN-parametric-lab-v3.md` (the lab's current design +
the §7 headless-check pattern) and the iOS side's
`wavetuner-native/ios/SPEC-parametric-faceplates.md` §6 (the P8 filter
this round mirrors) + §12 (the data these items answer to).*

---

## 0. Ground rules (all bitten before — do not relearn)

- ⛔ **Never edit `parametric-lab-v1.html` / `-v2.html`** — archives.
- ⛔ **The lab is the REFERENCE implementation.** Nothing in this round
  may change `drawManifest` / `drawGenome` / the GENES-PARAMS tables /
  RNG consumption order. Every item here sits ABOVE the sampler
  (which manifests get drawn for rating, which seeds get kept, what
  trains the model, what rides the recipes export). Consequence: **no
  fixtures re-export and no Swift re-port is needed by any item** —
  the iOS parity suite must stay green untouched. If an item seems to
  need a sampler change, stop and flag it.
- ⛔⛔ **Never run a headless EXPORT.** A fresh headless profile has
  none of Dan's curated locks/ratings/champions — exporting from one
  and syncing WIPES the curated state downstream. Headless Chrome is
  for CHECKS only (the v3 §7 pattern); exports are Dan's browser
  action, always.
- ⚠️ Key-bump discipline (the header comment at `STORE_KEY`): stores
  are keyed per vocabulary version. This round bumps the RATING store
  (W1, reasoned there); it does NOT bump locks/champions/recipes/sim.
- ⚠️ Verify with the headless-check suite pattern (v3 §7): each item
  below names its checks. Run the existing checks too — green before
  and after.

## W1. Rating modes adopt `voiceBias` (iOS spec §11.3 — the key-bump) — ✅ built 08-15

*As built: `buildManifest` gains `vbias = VOICE_BIAS` as its default third
arg — every rating mode draws biased. The replay audit found ONE
re-deriving path: `manifestFor` (generation history restores). Fixed by
provenance, not annotation: fresh items are tagged `vb: 1` and
`manifestFor` replays untagged (pre-bias) items UNIFORM, so a restored
generation re-derives the exact manifest it was rated under; a vote on
such an item also records no `vb`. v5→v6 migration verbatim, one-time,
v5 left in place.*

**Why.** The app draws voice counts through `VOICE_BIAS`
(4>2>3>6>5, line ~1152); the rating modes still draw uniform —
`buildManifest()` (~1167) calls `drawManifest` with NO `vbias` while
the app sim passes it (~3916). Dan is therefore rating a different
distribution than users see: 5–6v plates are over-represented in the
rating stream. Adopting the bias makes every future vote land on the
shipping distribution.

**What.**
1. `buildManifest()` passes `VOICE_BIAS` — this is the one functional
   line. It flows to the live manifest, batch/song cards
   (`manifestFor`), pick mode, and the manifest editor's redraws.
2. **Key-bump `STORE_KEY` `wt-parametric-lab-v5` → `-v6`**, marking
   the distribution boundary. One-time migration: if v6 is empty and
   v5 exists, import v5's records verbatim — the GENOME vocabulary is
   unchanged (`featurize` untouched), so old ratings stay valid
   training data; the bump marks which manifest distribution a record
   was collected under. New records gain **`vb: 1`**.
3. ⚠️ Audit every place that RE-DERIVES a manifest from a stored
   `mseed` (generation history, any replay path): under the bias the
   same mseed now draws a different manifest. Champions are safe (they
   store manifest objects inline — the Swift goldens read
   `c.manifest`), and the fixtures export builds its own cases; fix or
   annotate anything else found.
4. ⛔ The fixtures export must keep passing `VOICE_BIAS` exactly as it
   already does (~4051) — no change there.

**Checks.** Distribution test (N=2000 draws over a [2,6] recipe:
biased frequencies within tolerance of the table; uniform when vbias
absent — the existing bit-identity guard); migration test (seeded v5
store → v6 import verbatim); new records carry `vb: 1`.

## W2. Champions train the taste model (Dan 08-15: "it should learn from these") — ✅ built 08-15

*As built: per-sample multiplier `S[i]` in the SGD update (`CHAMP_W = 3`),
champions appended as positives after the ratings; the <8-ratings gate
stays on ratings alone (champions are all-positive — they can season a
model, not found one). Retrain hooks added everywhere the champion set
changes: star, un-star, delete, import.*

**Why.** `trainModel()` (~3173) fits on ratings only. The 146
champions are Dan's strongest signal — curated keepers, and the 111
bred ones never entered the ratings at all (breeding bypasses the vote
path). Champions never ship (§9.13), so the ONLY way they reach the
app is through what they teach the model.

**What.** `trainModel()` appends the champion genomes as positive
examples with weight `CHAMP_W = 3` (a named const — "one champion ≈
three likes"; implement as repetition or a per-sample multiplier in
the SGD update, whichever reads cleaner). All champions included, no
dedupe against ratings — a champion that was ALSO liked earns the
extra weight honestly. The taste EXPORT format is unchanged (weights
block only), so `sync-parametric.sh` and the Swift side need nothing:
after this lands, Dan re-exports taste and the app's P8 filter starts
pulling draws toward champion territory.

**Checks.** With a synthetic champion set favouring a known gene value,
the trained weight for that feature moves positive vs a
champions-off fit; model still trains with 0 champions (no regression
when the store is empty).

## W3. The app sim draws through the P8 filter — ✅ built 08-15

*As built: `simRollGseed(key)` (K = `ROLL_CANDIDATES = 8`, scored on
`drawGenome(seed, key)` so locks + the song's pins are in the scored
genome), wired into `simEnter`'s fresh draw and both shuffle tiers; the
winning SEED persists. `taste` chip on the app bar, default ON. The
fixtures export path never touches it — verified identical with a live
model present.*

**Why.** Since P8 the app's every fresh genome seed is best-of-8 under
the taste model (`PlateTaste.rollGenomeSeed`, iOS spec §6 as-built).
The lab's `mode=app` — the sandbox that exists to show exactly what
the app will do — still rolls one raw seed, so Dan is judging a stream
users no longer see. (The batch grid's `biasChk` top-12-of-96 is a
different, coarser mechanism — leave it alone.)

**What.** In the app sim's fresh-draw paths (song entry roll and the
shuffle buttons around ~3935): roll `K = 8` candidate gseeds
(`newSeed()`), score `drawGenome(seed)` for each — under the same
locks/pins the sim's draw applies, since the scored genome must be the
rendered one — and keep the best candidate's SEED. The winning seed is
what persists into `simStore`, so stored plates stay reproducible from
seeds alone, exactly the app's design. `K` mirrors the Swift
`PlateTaste.rollCandidates`; name it accordingly. Add a small
**`taste` toggle chip** to the app-sim bar (default ON, matching the
app) so Dan can A/B the raw vs filtered stream. No model → identical
to today's single roll.

- ⛔ The FIXTURES export must never go through the filter — its 200
  cases are deterministic sampler-parity data, not draws.
- ⚠️ The sim scores with the lab's LIVE in-browser model, which may be
  fresher than the app's synced weights. That is the point (judging
  tomorrow's sync), not a bug — note it in a comment.

**Checks.** With a synthetic model favouring `flow=rows`, the filtered
draw picks the rows-drawing candidate (the Swift
`tasteBehaviorInvariants` twin); toggle OFF or model-absent ⇒ first
candidate (bit-identical to the old roll); fixtures export unchanged
byte-for-byte given the same profile state.

## W4. Champion → pins distillation (bred designs re-enter generatively) — ✅ built 08-15

*As built: per-champion **pins** button → gene checklist (core
pre-checked: flow · knobStyle · accent · school · hero · heroPick ·
scopePlace · chipStyle · orbInk · knobSize; the six noise genes
unchecked + dimmed). **Apply** REPLACES the chosen recipe's `pins`
whole (merging two champions' pins would describe a hybrid neither
champion is) + `saveRecipes()`; **copy json** for hand-authoring.
Values verbatim, GENES order, out-of-bounds floats kept (pins beat
bounds — verified through a draw).*

**Why.** Dan: bred designs he loves should be reachable IN the app —
but the app is generative-only and bred genomes have no reproducing
seed (§0). The reconciliation: distill a champion's CHARACTER into
recipe `pins`, so the app draws fresh plates that orbit the design —
same identity, generative variation. The app side already honors
recipe pins end-to-end (draw, render, P8 scoring) — zero Swift work.

**What.** In the champions panel, a per-champion **"pins"** action
opening a gene checklist: every gene row shows the champion's value,
with a curated CHARACTER CORE pre-checked — suggest `flow`,
`knobStyle`, `accent`, `school`, `hero` + `heroPick`, `scopePlace`,
`chipStyle`, `orbInk`, `knobSize` — and the ARRANGEMENT/NOISE genes
(`jitter`, `orderSeed`, `mixerScatter`, `margin`, `gapScale`,
`faderW`) unchecked and visually de-emphasised (pinning them freezes
the layout, killing the variation that makes distillation worth
having). Principle to preserve whatever the final default set:
**pin STYLE, leave ARRANGEMENT free**; Dan tunes per champion.

Two outputs:
1. **Apply to a recipe** — write the checked map into
   `RECIPES[<chosen recipe>].pins` (+ `saveRecipes()`), so it rides
   the next recipes export into the app (`PlateRecipe.pins` shape —
   a flat gene→value map, values as the genome stores them).
2. **Copy JSON** — the same map on the clipboard, for hand-authoring.

⚠️ Applying pins to a recipe changes that recipe's future draws in
both runtimes — by design — but does NOT invalidate fixtures (they
embed their own recipes) or champions. ⚠️ If a pinned float sits
outside the current bounds, keep the champion's value verbatim (pins
beat locks/bounds in both samplers — that's the contract).

**Checks.** Output shape validates against a recipes-export decode of
`pins`; a draw under the applied pins carries the pinned values
verbatim; noise genes absent from the default set.

## W5. 5–6 voice session affordance (`?voices=lo,hi`) — ✅ built 08-15

*As built: the override is applied inside `buildManifest` — the rating
modes' single entry — rather than inside `recipePatch`, so the app sim
and both exports cannot leak it BY CONSTRUCTION (`recipePatch` stays
pure). Orange `#voicesChip` banner in the top bar; records gain
`vr: [lo, hi]`; clamps to [2,6], single value locks.*

**Why.** Dan is collecting targeted 5–6v ratings (iOS spec §11.6: the
range stays [2,6]; the study is to LEARN what makes dense plates work,
feeding future locks/bounds — not to re-litigate the cap). Pick/batch
sessions need dense manifests on demand without editing recipes.

**What.** A `?voices=5,6` URL param that overrides the session's draw
range in `recipePatch()` (clamped to [2,6]; single value = locked
count). Session-only: ⛔ it must not leak into the recipes export, the
fixtures export, or the app sim. Show a visible banner chip while
active so a normal session can't be silently polluted; rating records
collected under it gain **`vr: [lo, hi]`** so analysis can slice the
dense-plate study out of the global pool.

**Checks.** Param narrows batch/pick draws to the range; exports
byte-identical with and without the param; records carry `vr`.

## 6. Order + the follow-through

Build order: **W1 → W5 → W2 → W3 → W4.** W1 first (its key-bump
defines where every later rating lands), W5 next (small; unblocks
Dan's rating sessions immediately), then the training/filter pair,
then distillation.

After W1+W2 land, the loop closes only when **Dan exports taste from
his browser** (the ~50-vote grains session is still unexported as of
this writing — first order of business) → `parametric_saves/` →
`./sync-parametric.sh` → `ios/scripts/run-parametric-parity.sh`
(the vocabulary guard proves the new weights line up; featurize is
untouched so it must pass without any Swift change).

## 7. Out of scope, deliberately

- The `?device=ipad` packer pass (v3 §13.5) — waits on iPhone caps
  settling.
- Any GENES/sampler/table change (would demand fixtures re-export +
  Swift re-port — nothing here needs one).
- `songWeights` UI — decided equal-for-now (iOS spec §9.13); the
  export block stays absent until Dan wants numbers.
- Champion import into the app — retired (§9.13); W4 is its
  replacement.
