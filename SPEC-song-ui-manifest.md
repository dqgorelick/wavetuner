# SPEC — song UI manifest **v2** (parametric listen-page faceplates)

*Started 2026-08-14, v2 same day. The data model behind
`wavetuner/parametric-lab.html`. Companion:
`wavetuner-native/ios/SPEC-songs.md` (what a song is),
`SPEC-song-save-and-morph.md` (what a song captures).
v1 is frozen at `SPEC-song-ui-manifest-v1.md` + `parametric-lab-v1.html`;
the plan that produced v2 is `PLAN-parametric-lab-v2.md`.*

> ⚠️ **v3 shipped 2026-08-14 (same day, later):** `parametric-lab.html` is
> now v3 — RECIPES with per-element likelihood tables edited in a weight
> grid and persisted (localStorage + `parametric-recipes.json`), voices as
> a 2–6 range, Dan's four generative recipes, per-control `sizeMul`,
> `scopeSlot`, the detune→drift move, no cluster at 5+ voices, and the
> `song.ui` handoff surfaced per card. **Read `PLAN-parametric-lab-v3.md`
> with this file** — v2's model below still describes everything v3 did
> not touch (genome, pairs, witness rules, chrome, back face). The v2
> lab is frozen at `parametric-lab-v2.html` + `SPEC-song-ui-manifest-v2.md`.

---

## 0. What v2 changed

v1 was `(manifest, genome, seed) → faceplate`, with the manifest
hand-authored per song. v2 puts a **patch** above it and makes the
manifest **drawn**:

```
patch → [gates + weights] → manifest → (genome, seed) → faceplate
```

Four moves, in order of how much they change:

1. ⭐ **Immediacy is the plate's admission rule.** The faceplate is the
   surface where *every control moves the sound now*. Dwell, slide and
   drift fail that test and live on a back face (§4d). This is the idea
   the rest follows from.
2. **A patch layer** decides what is legal at all (§1b).
3. **Visibility weights** replace hand-authored control lists (§4b).
4. **A third element class — the witness** (the wave screen, §4c),
   which is neither control nor chrome. And the back face (§4d) is where the rest went.

⛔ **The pitch array is GONE** (Dan, same day), settling the one collision v2
opened. Frequency lives in the spectrum bar's **orb handles** — fixed chrome on
every song — so it is always reachable and no song spends pane space on it. A
pitch array and the orbs could not both be the reason the other was
unnecessary, and the orbs were there first. ⚠️ The `**` tier is therefore
`remix` alone, and the 2 cost units the array took are given back: the mean
plate went 9.7 → 8.1 units, so plates got *lighter*, not denser.

**What came out**, each because it had earned it: `backdrop` (its own
description said it "groups nothing"), `tickOnly` ("nearly invisible" —
a judgement already made), the parked right rail, the `view` family and
its quiet tier, `orbs` as a catalog row, `room`, `arpRatio`, `satButton`,
`fineTune`, and `autoPlace` with the machinery
that glued auto onto remix.

⚠️ **Every localStorage key is bumped** (`-v4` / `-locks-v3` / `-gens-v2`).
The taste model's weights are keyed to gene names and v2 cut four genes
and added nine; feeding it v1's ratings would silently mix two
vocabularies. v1 keeps its own keys.

## 1. The split

| | who writes it | what it decides |
|---|---|---|
| **patch** | **you, per song** | which controls are LEGAL |
| **manifest** | drawn from the patch + weights | WHICH of them exist on this plate |
| **genome** | seeded PRNG | HOW they're laid out and styled |
| **chrome** | the page | the rail, spectrum, orb handles, bottom rail — never varies |

**The chrome is one 46pt left rail** — play/pause · volume · auto — a hairline
away from the pane, which takes the rest (~323pt). ⛔ v1's parked right rail is
deleted; `SPEC-song-ui-manifest-v1.md` §1 keeps the reasoning.

The manifest is **drawn, never a gene**. It is a deterministic function of
`(patch, manifestSeed)`, so the same song always shows the same plate, and the
genome still cannot add or remove a control.

## 1b. The patch — the gate

```js
{ engine: 'classic' | 'granular',
  waves:  ['sine','triangle','square','saw'],   // or ['square'] — square-only
  voices: 2 | 3 | 4,
  shaping: true,                                 // does it shape its wave at all?
  noise: true, arp: false, cycle: true }
```

Catalog rows carry `requires(patch)`. Two of Dan's constraints then need no
rule of their own:

- **"not on cello grains"** — one `engine: 'granular'` retires shape, fold and
  wave level together.
- **"width only on a square-only synth, and only when there's no shape knob"** —
  a square-only patch has nothing to morph, so `shape` fails its own gate and
  `width` takes the slot. ⭐ The patch enforces it, not the layout engine.

⭐ **`shaping`** is the third gate, and the answer to "where do I switch the
wave screen off". `false` is a synth whose oscillator is what it is — no morph,
no fold, no PWM — so it gates the three waveshaping controls **and** the screen
together. ⛔ One field, two consequences, rather than two special cases: with
nothing able to redraw the silhouette there is nothing for a screen to witness,
and a picture of a wave that never changes is decoration. It is a checkbox in
the patch editor. `hello world · sine waves` is the case in point — sine, and
nothing that bends it, so no shape knob and no viewer.

⚠️ A granular patch therefore has **nothing in the tone family** and ships as
filter + reverb. Grains want their own family (size · density · position ·
spray); that is the first v2.1 job.

## 2. Manifest schema

```jsonc
{ patch,                                   // resolved from the song
  voices: 4,
  controls: ['mutes','saturation','lpf','lpfPeak','reverb','tune','remix'],
  scope: 'strong' | 'weak' | null }        // the witness — derived, see §4c
```

A song only has to author a **patch**. It may also pin `controls` to override
the draw — the way you lock a plate you have already art-directed — and `pins`
still fixes named genes (§2b).

The **frequency handles** in the spectrum bar (`SPEC-listen-orbs`) — half-size,
sitting under the line — are fixed chrome on every song, and their consequence
is large: ⛔ **no song carries a pitch control at all.** Frequency is always
reachable, so the pane is free for everything else.

Only the orbs' colour varies, via the **`orbInk`** gene — the three readings the
app itself has:

| | |
|---|---|
| `mono` | one flat tone for every orb — what the listen page ships. ⛔ The root is deliberately *not* lifted: on this page every orb does the same job, and one bright coin would say otherwise |
| `spectrum` | the voice colours, as on the instrument page. Collapses to one colour under `accent: voice0`, same coherence rule as the pane |
| `grayscale` | told apart by **value** rather than hue — root brightest, each voice stepping down. Readable without relying on colour vision |

## 2b. `pins` — a song's character

A deliberate hole in the manifest/genome split: a song may pin named genes.

It exists because two songs can want *identical controls* and a different
composure, and there is no honest way to express that as content — see the
hello-world trio in §6, where variants 2 and 3 differ only in how loosely the
mixer is arranged.

Precedence: **pins beat both the random draw and the user's locks**, because
they are what defines which variant you are looking at. The one thing that
beats a pin is the **sweep** — sweeping a pinned gene must still show its whole
range, or you could never see what the pin chose from.

Use sparingly. A pin is art direction; every gene pinned is a gene the taste
loop can no longer learn about for that song.

⚠️ **Budget: 6–9 controls.** The generator will render more, but past ~12 it
shrink-to-fits into illegibility (see the `full console (stress)` entry, kept
deliberately as the failure case). If a song wants more, that's a signal the
song wants a *pane*, not a faceplate.

## 3. Param catalog — the vocabulary

Every control is one row. Adding a control to the app = one row here and
nothing else; the layout engine, the manifest editor, the sampler and the taste
model all read from it.

⭐ **`imm` is v2's admission rule** — does moving this change the sound *now*?
`w` is the sampling weight (Dan's tiers as numbers: `**` 1.0 · `*` 0.6 · below
= situational). `cost` is what it claims of the plate.

### On the plate — immediate

| id | label | family | kind | tier | w | cost | gate |
|---|---|---|---|---|---|---|---|
| `remix` | remix | action | button | ** | 1.0 | 1 | — |
| `mutes` | mute | voices | voiceMutes | * | 0.6 | 1 | — |
| `shape` | shape | tone | knob | * | 0.6 | 1 | classic + >1 wave |
| `saturation` | drive | tone | knob | * | 0.6 | 1 | — |
| `lpf` / `lpfPeak` | lpf / peak | filter | knob | * | 0.6 | 1 | — |
| `reverb` | reverb | space | knob | * | 0.6 | 1 | — |
| `tune` | tune | action | button | * | 0.5 | 1 | — |
| `filter` / `resonance` | filter / res | filter | knob | — | 0.5 | 1 | — |
| `pans` | pan | voices | voicePans | — | 0.35 | 2 | — |
| `levels` | level | voices | voiceFaders | — | 0.7 **conditional** | 2 | rides `pans` |
| `noise` | noise | tone | knob | — | 0.4 | 1 | patch has noise |
| `waveLevel` | wave | tone | knob | — | 0.4 | 1 | classic |
| `fold` | fold | tone | knob | — | 0.4 | 1 | classic |
| `hpf` / `hpfPeak` | hpf / peak | filter | knob | — | 0.3 | 1 | — |
| `detune` | detune | tuning | knob | — | 0.3 | 1 | needs remix/tune |
| `width` | width | tone | knob | — | 0.25 | 1 | square-only |
| `detuneBtn` | spread | tuning | button | — | 0.2 | 1 | needs remix/tune |
| `arpOn` · `arpBpm` · `arpOct` · `arpDir` | | arp | | — | 0.9–0.5 | 1 | patch has arp |

⚠️ An `xor`'d row's observed rate sits below its `w`: `filter` and `lpf`/`hpf`
are two answers to one question, so whichever is offered first claims the group
(`filter` lands ~0.30 against a nominal 0.50). That is the exclusion working —
read the group's total, not the member's.

### Off the plate — the back face (§4d)

`autoCycle` (dwell) · `slide` · `drift`. Turning any of them changes what
happens *next*, not what you hear now.

⭐ **The detune split.** Dan's note listed detune under both headings, and read
physically they are two knobs: spreading the oscillators changes the beating
instantly (**`detune`**, stays), while how far the next remix *wanders* changes
nothing until the next remix (**`drift`**, exiled). Same gesture, before and
after the fact — which is why they felt like one item.

⭐ **What survived the exile:** the cycle **readout**. The dwell knob went, but
the ring around remix stayed, drawn from `patch.cycle` — a countdown is a
display, not a control, so it needs no control on the plate to have something to
say. v1's best idea kept, its failing half removed.

**`auto`** likewise stays reachable as **rail chrome** — it is transport, and
the rail is not the plate. Hence `autoPlace` is gone.

## 3b. The mixer is the rare half

⭐ Panning is **only sometimes** there and volume **rarer still** (Dan). Both
started a tier too high — pan sat with the `*` group at 0.6 and measured 0.61,
which made a mixer read as standard equipment. Now: **pan 35%, volume 18%**,
measured. Mutes stay `*` at 60%: a mute is a performance control, a fader is a
setup one.

⚠️ **`ridesWith`.** Drawn independently those rates put pan and volume together
on only **6%** of plates — and BOTH is what fires the mixer cluster, so
`mixerScatter` and `mutePlace: cluster` became things you would see once in
seventeen cards. So volume now *rides* pan: it is offered only on a plate that
already has pans. Volume's observed rate is unchanged at 18%, the cluster is
back to 18%, and it says something true — four volume faders with no pans is a
stranger object than a mixer.

⛔ A rider's `w` is **conditional**, not the rate you observe, and it is
calibrated against the measurement rather than the arithmetic (0.7, not 0.5:
the rider is judged last, and a 2-cost block is the one most often refused by
what is left of the budget).

## 3c. Voices — 2, 3 or 4

A patch field, ⛔ **not a gene**: how many voices a song has *is* the song, not
a way of drawing it, and two loads must never disagree. It trickles all the way
down — the spectrum bar's stems and orb handles, the mute grid, the pan grid,
the fader row and the mixer cluster all size themselves off the one number.
Clamped to 2–4: one voice is not a chord, and past four the per-voice blocks
stop fitting 292 pt.

## 3d. Cost, not control count

v1's budget was "6–9 controls", which mis-measures the plate the moment a
per-voice array is `**`. v2 budgets in **cost units: 11**, where a knob is 1, a
per-voice array 2, the mixer cluster 3.

The always + mostly tiers come to roughly 9 units on their own — i.e. **the `*`
tier essentially is the plate**, and the situational tier gets what is left,
usually one or two knobs. Measured over 2000 draws the mean plate costs 8.7–9.9
of 11.

## 4. Couplings — the layout atom is the PAIR, not the control

Some controls are meaningless apart. Declared once, honoured everywhere:

| pair | style | renders as |
|---|---|---|
| `levels` + `pans` | `cluster` | one block holding every voice's fader *and* its pan — see below |
| `lpf` + `lpfPeak` | `concentric` | one body, cutoff outer ring, peak inner ring |
| `hpf` + `hpfPeak` | `concentric` | ditto |
| `filter` + `resonance` | `concentric` | ditto |
| `noise` + `waveLevel` | `adjacent` | the two SOURCE volumes read as one blend, so they are glued |
| `tune` + `detune`/`detuneBtn` | `adjacent` | glued side by side, tighter gap than a normal block |

A pair fires **only when both members are present**; otherwise each control
renders alone. `pairStyle: flatten` is a *gene* — it lets the taste loop test
whether you actually prefer concentric pairs or two plain knobs.

⛔ v1's **`timerRing`** pair (remix wearing its dwell knob as a ring) is gone
with the dwell knob. The *ring* survives — it is now drawn from `patch.cycle`,
because a readout needs no control present to have something to say (§3).

**The `cluster`** is the pair that makes the abstract variant possible. A
voice's level and its pan belong to each other before they belong to the row,
so they render as one block and travel together. The **`mixerScatter`** gene
then composes that block:

- **0** — a strict console: even columns, equal fader heights, each pan
  squarely beneath its own fader.
- **1** — a composition: the faders take the spectrum bar's own stem spacing,
  so a voice sits where its *pitch* sits; heights vary; and each pan swings
  out to its own bearing and distance around its fader's foot.

⛔ **The pan never leaves its fader's neighbourhood at any scatter value.** It
orbits the foot rather than being thrown somewhere else, so which pan belongs
to which voice survives the scattering. That constraint is the whole difference
between a composition and a mess — the block is still a mixer, just an
irregular one, and the irregularity is anchored to something real (pitch)
rather than to noise.

### The per-voice set — one geometry, one shape

⭐ Pans and mutes share **one** set of three shapes — `square` · `row`
(horizontal line) · `column` (vertical line) — and ⭐ **one geometry**
(`voiceSetBlock`): same cell pitch, same mark size, same label baseline,
identical footprint for a given voice count. Before that they sat on a 19pt and
a 22pt pitch, so even a matched pair failed to line up. The mixer strip uses
the same `VMARK` too, so a voice reads as head-square · track · foot-circle at
one scale, and a cluster on one plate matches a loose set on another.

⭐ **`shapeLink`** then correlates them: `matched` (the norm) makes the pan copy
the mute's layout, so both are squares or both are lines running the same way;
`free` lets each take its own. ⚠️ It is **biased 85/15** to matched, because
this is a coherence rule with an exception rather than a menu of equals — two
per-voice sets on one plate reading as two different vocabularies is exactly
the failure the single-source `voiceInk` rule prevents for colour.

`mutePlace` adds a fourth value, `cluster`; `panPlace` has only the three, and
is overridden by `matched` and inert inside the cluster (there a pan's place is
its own fader's foot, which is the point of the cluster).

⚠️ `square` degenerates honestly below four voices: 2 is a pair either way, 3
is an L. Forcing a 2×2 with a hole would be a grid lying about how many voices
exist.

⭐ **A block declares the width it really occupies, caption included**, plus a
small inset that scales with the cell. A `column` is one cell wide (~20 pt)
while its caption is nearer 24, so two of them a `blockGap` apart had captions
almost touching while the marks looked far apart — the packer was spacing the
*grids*, not the blocks. Measuring the caption and insetting the grid fixes the
padding and the centring together: the grid is centred inside the true width
rather than flush against its left edge. Verified — in all four layouts the
marks sit dead centre under their caption (offset 0.00) and the two captions
share one baseline.

### Biased genes

Most genes are a fair draw across their options. A few are a **norm with an
exception**, and `bias` says so — verified at 85.1/14.9 over 20 000 draws.
⚠️ The bias renormalises over whatever the exclusions have left alive, so
ruling a value out never silently redistributes weight to something you also
ruled out. ⛔ A **sweep ignores it entirely**: seeing the whole range is the
point of a sweep, and a rare value you cannot see is one you cannot judge.

⭐ **v2: the mute can join the cluster.** Dan's open question — a square of four
or one mute per voice inside the strip — is made a **gene** (`mutePlace`) rather
than argued: `cluster` puts each mute at the head of its own fader so a voice's
whole strip travels as one thing (coherence); `square` is the 2×2 block Dan
described (a better shape, but it separates a voice's mute from its fader);
`row` is a plain line. ⚠️ `cluster` falls back to `square` when there is no
mixer to join — including under `pairStyle: flatten`, which stops the cluster
forming at all. Without that second fallback the mute vanished off the plate
entirely.

## 4b. The sampler — patch + weights + seed → controls

v1 hand-wrote every song's control list. Dan's v2 note gave **frequencies**
instead (`**` always, `*` mostly, "tune half as often as remix"), which is a
sampler spec:

1. Everything legal on the patch forms the pool.
2. The `**` tier is **not sampled** — it is always there. That is what "always
   visible" means.
3. The rest are offered in a shuffled order (so nothing wins a slot merely by
   sitting higher in the catalog) and taken with probability `w`, until the
   cost budget is spent.
4. Partners ride in on their principals; `xor` groups admit one member;
   `needsAction` keeps detune off a plate with neither remix nor tune.
5. **Riders** (`ridesWith`) are held to a second pass, because the first is
   shuffled — a rider judged before its host would have a rate that depends on
   where the shuffle happened to put it.

Verified over 3200 draws across every song: the `**` tier is never absent, no
patch-illegal control ever reaches a plate, no partner is ever orphaned, the
budget holds, and no plate carries two filter kinds.

## 4c. The witness — the wave screen

A third element class: **neither control nor chrome**. It never appears in a
manifest — it is a *consequence* of what the plate carries.

⭐ **It does not break the immediacy rule; it is that rule made visible.** The
plate claims every knob moves the sound now, and the screen is the plate
proving it.

**Port, don't invent.** `WaveShapePreviewView` (`SoundDesignViews.swift:33`,
itself the web's `WaveShapePreview.jsx`) already is this component: one period,
axis hairline at ink 0.1, trace at ink 0.75 in a 1.5pt round-capped line,
peak-normalised. It runs **shape → width (duty warp) → fold → dry/wet mix**.
⚠️ **Saturation is the one stage it lacks** — the lab appends a soft-clip, which
means adding that stage to the shipping view too, not just here.

⛔ **The lab computes the true trace** (`sampleShapeIdeal` from
`visualShape.js`, the fold curve, the clip). The one thing being judged is
*does this read at 40pt tall*, and a decorative squiggle makes exactly that
unjudgeable.

⛔ **A granular patch gets no screen at all.** There is no single-cycle
waveform in a grain cloud, so there is nothing honest to draw — the same rule
as below. This only became visible when the pitch array was removed: freeing
its two cost units satisfied the weak witness's "≥2 units spare" condition far
more often, and 55% of cello plates started showing a saturated sine for a
grain cloud. ⚠️ Grains want their own witness (a cloud, not a wave); until then
they get none.

⚠️ **No shape knob does not mean no shape.** A square-only patch has nothing to
morph — which is *why* it has no shape control — so the resting shape comes from
the **patch**, and the knob only overrides it when the plate carries one.
Drawing a sine there would be the screen lying about the synth.

**When it fires**, weighted by how much the control moves the *trace*:

| | |
|---|---|
| `strong` (w 0.7) | shape · fold · width — they transform the silhouette |
| `weak` (w 0.3) | saturation, and only when the plate has ≥2 cost units spare. Both readings of Dan's "(and less other things)", composed |
| none | nothing on the plate can move it |

⭐ **The size inverts:** the weak witness is drawn **bigger**. A subtle change
needs more pixels to be legible; a silhouette-transforming one survives at any
size. Measured: 73% strong on the sine song, 0% strong / 36% weak on cello
grains (granular has no shape, fold or width at all — exactly right).

**`scopePlace`** — all three are real designs:

| | |
|---|---|
| `inline` | inside the tone block, bound to its control the way the timer ring is bound to remix — *the screen belongs to shape* |
| `banner` | spanning the plate's width — *the screen belongs to the plate* |
| `hero` | the screen large, the knobs small — *the plate belongs to the screen*. ⛔ Forces the control-side hero off: two dominant elements is no dominant element |

`banner` and `hero` claim a **share of the zone**, not a multiple of the inline
size — "spanning the plate" has to mean the plate. Plus `scopeFrame`
(fill · hairline · none) and `scopeCycles` (one reads as a *shape*, two as a
*wave*).

⛔ **At most one picture.** The pane already sits under a field sliver and a
spectrum bar; a third is how a faceplate becomes a dashboard. Enforced by there
being exactly one witness, not by a rule the layout has to remember.

## 4d. The back face

Everything that fails the immediacy test, behind one `⋯` in the pane's
bottom-right corner, drawn at the quietest ink there is.

⛔ **The genome does not style it.** It is chrome: one plain list, identical on
every song — a label, a value, a track. Styling both faces would double the
search space for the surface nobody is looking at, and the whole reason these
controls are here is that they do not deserve the attention. The zoom modal
shows both faces side by side, which is the only way to judge whether the split
was drawn in the right place.

## 5. Hard rules (constraints, not genes)

1. **Play/pause and volume are page chrome**, fixed in the left column. Never
   in a manifest, never moved by a genome.
2. ⭐ **Everything on the plate is immediate.** A control that changes only
   what happens next belongs on the back face (§4d). (This replaces v1's rule
   about the `view` family, which had one member and is now cut entirely.)
2b. **Tiers have a visual consequence**, or they are only draw weights: an
   `always` control has a size floor and is the only tier eligible for hero; a
   `situational` one may render at 0.85× and is the only tier the packer may
   strand in a last row. ⛔ Deliberately *not* a position rule — pinning the
   `**` tier to the top would take the genome's job away.
3. **The pane region is a fixed 292 pt** (`ListenView.swift`) — ⛔ the field
   above must never resize, so the faceplate cannot grow. Content fits by
   scaling, and a manifest that only fits at a small scale is a manifest
   problem.
4. Everything obeys the **`simple` theme**: black ground, gray-150 chrome cap,
   round-capped lines, no dots or balls on controls, `SIMPLE_PALETTE` on
   per-voice sites only, 8 pt uppercase labels at 0.3 ink.
5. A pair's members are **never separated** by the section shuffle.
6. **Sections share rows.** One section per row wasted the zone: this
   song's 7 controls in 4 families laid out 2-1-1-1 and filled about a
   third of the width while running long vertically. Sections are packed
   as *units* — a run of blocks that must stay adjacent — separated by
   the wider `sectionGap`, with `blockGap` inside a unit and `glueGap`
   inside a pair. The gap itself is what says where one group ends; no
   rule is needed for that.
   The wrap is **balanced**, not greedy: a greedy pass finds the minimum
   row count R, then a second pass re-packs into exactly R rows at equal
   target width, so the last row is never left holding one lonely knob.
   A section wider than the zone splits into several units and wraps.
7. **The hairline separates rows, not sections** — now that sections
   share rows, a rule between them would cut a row in half rather than
   group anything.

## 5b. The style vocabulary (genome side)

**One source of per-voice colour.** Faders, pans, fine-tune lanes and pane orbs
all resolve through the same function, so a voice can never be one colour in
the mixer and another in the pan row. `voiceLit` and `accent` are separate
genes and must not contradict each other:

| | |
|---|---|
| `voiceLit: gray` | per-voice controls follow the plate's accent, whatever it is |
| `accent: voice0` | one accent means **one colour** — the voices come with it |
| otherwise | the spectrum: full-colour voices over gray chrome, the `simple` theme's own rule |

⛔ The failure this prevents: `accent: voice0` used to paint every knob one
voice's colour while the pans stayed a full rainbow. That reads as a bug, not
a choice.

The manifest picks the control; these pick how it's drawn. All are genes,
so the rating loop settles them rather than an up-front decision.

**`knobStyle`** — nine readings of the same 270° travel, swappable
anywhere a knob appears:

| | |
|---|---|
| `ring` | track arc + radial tick — the PanPot grammar |
| `ringValue` | …plus a filled arc showing the value |
| `cap` | the knob BODY: circle outline + pointer centre→rim |
| `dot` | body + a dot marker — the classic Braun cap. ⚠️ deliberately breaks the theme's no-dots-on-controls rule; it is here to be judged, not because it already fits |
| `band` | **the iOS bottom knob band's dial, ported from `SourceDial.swift`**: opaque black disc, a 270° track at ink-soft 0.10 with stroke = 10% of the diameter (floored at 3, so it grows with the circle), the value arc in the voice colour at 0.6, and the value as a **numeral inside the circle**. ⛔ No tick and no cap dot — the cap orb retired 2026-08-13 with the fader ball and the pan orb; the arc's length plus the numeral say the value between them |
| `scale` | Braun dial — 11 marks round the arc, the live one lit and longer |
| `wedge` | a solid annulus sector; the boldest of the set |
| `segments` | the arc split into 9 cells, lit up to the value |
| `needle` | a meter pointer crossing the whole face |

`band` is the only style whose value lives inside the circle, so its
block is one row shorter (no readout beneath — it would be the same
number twice). A **concentric pair keeps its readout below** even in
`band`, since it has two numbers and only one centre.

⛔ The **inner ring of a concentric pair always takes the plain form**
(`ring`), whatever the outer wears. The pair needs a hierarchy: the
primary control gets the expressive style and the secondary stays out of
its way, or two treatments compete at two radii and neither reads.

**`remixGlyph`** — four readings of "give me another one":

| | |
|---|---|
| `dots` | two abstract pips; says nothing specific |
| `dice` | a real die face — rounded square + pips, **the face drawn from the seed** so the die on screen has actually been rolled. Faces are 2·3·5·6 only: 1 reads as a bullet, 4 as a square of dots |
| `shuffle` | the media-player crossing lanes. Says re-ARRANGE, not re-roll — arguably closer to what remix does to a chord you already have |
| `cycle` | a circular arrow — just "again", the weakest claim of the four |

Both arrow marks use chevron heads on the path's own tangent, never a
filled triangle — the theme has no filled marks on controls (the die
pips are the one exception, where the dot is the subject rather than an
indicator). The shuffle puts **both heads on the right** so the glyph
has a direction; symmetric heads at both ends would read as "swap",
which is a different verb. ⛔ The die has **no outline** — the button's
own wash is already a container, and a box inside a circle was two
enclosures doing one job.

**`autoShape`** — one drawing function serves both the rail and the pane, so
the two can never drift apart:

| | |
|---|---|
| `circle` | wash circle + lemniscate + label under. Matches remix and tune, at the cost of a knob-sized footprint |
| `pill` | a rounded horizontal rectangle with AUTO set **inside** it. ⛔ Never a label under — the word *is* the button |
| `rect` | a small rounded rectangle + label under. About a third of the circle's area, for when auto shouldn't cost as much room as a knob |

⛔ **`autoPlace` is cut.** Auto is not immediate, so it cannot be a pane
control; it stays in the rail, where transport belongs. `autoShape`
(circle · pill · rect) still styles it.

**`cycleReadout`** — how the auto-cycle's countdown shows:

| | |
|---|---|
| `ring` | around the remix button, so the timer is drawn **on the thing it re-clicks** |
| `bar` | a thin capsule across the top of the pane — `ListenView`'s own `walkProgressBar`. Takes a strip off the top of the zone, so the content below never has to know about it |
| `both` | belt and braces |

Both readings share one progress constant, so the ring and the bar can never
disagree about how far through the cycle you are.

**`panFill`** — where a pan's fill begins. `none` starts it at the beginning
of travel like every other knob; `noon` starts it in the **middle**, so the
offset reads as a length growing left or right out of centre.

⛔ **No centre pip.** The fill starting at the middle *is* the centre marker,
and on the unfilled styles the plate is already a grid of knobs — a lone dot
floating over one of them was a second vocabulary for no gain.

⚠️ `panFill` is only visible on the **filled** styles (`ringValue` · `wedge` ·
`segments` · `band`). The pan wears whatever `knobStyle` the knobs wear, and
the unfilled ones have no fill to move.

**`tune`** is three VERTICAL lines, equal height and evenly spaced. The
axis is not arbitrary: the spectrum bar above draws each voice as a
vertical stem, so the button shows those stems standing level.
Horizontal lines read as a list. The equal heights *are* the message.

⛔ **`pitchOrient` / `pitchWidth` / `pitchSpacing` are cut** with the pitch
array itself (§0). v1's `fineWidth`/`fineSpacing` went the same way.

**`mutePlace`** · **`panPlace`** · **`faderOrient`** · **`faderLen`** — see §4. `faderLen:
varied` is Dan's "can be different lengths", scaled off each voice's own pitch
so the stagger means something.

**`scopePlace` / `scopeFrame` / `scopeCycles`** — see §4c.

## 6. The songs

A song is a **patch**; the controls are drawn (§4b). Two hand-authored plates
are kept so the drawn ones can be read against something composed on purpose,
plus the stress case.

```js
'square waves · immediate slide': { patch: { waves: ['square'], voices: 4, cycle: true } }
'cello grains':                   { patch: { engine: 'granular', waves: [], voices: 2,
                                             noise: false, cycle: false } }
'hello world · sine waves':       { patch: { waves: ['sine'], voices: 4, shaping: false } }
'two squares':                    { patch: { waves: ['square'], voices: 2 } }

// AUTHORED — `controls` written out rather than drawn, so a sampled plate can
// be read against one somebody composed on purpose. Identical control lists;
// they differ only in composure, which is what `pins` is for.
'authored · mixer, ordered':  { patch: { voices: 3 }, controls: [...],
                                pins: { mixerScatter: 0, align: 'center', jitter: 0, school: 0.1 } }
'authored · mixer, abstract': { patch: { voices: 4 }, controls: [...],
                                pins: { mixerScatter: 0.92, school: 0.8, hero: 'on' } }

// the one configuration `shapeLink` is about: both per-voice sets standing
// alone, side by side. In every other song the pans are absorbed by the cluster
'authored · pan + mute':      { patch: { voices: 4, shaping: false },
                                controls: ['pans','mutes','reverb','remix'] }

// kept deliberately as the failure case: everything legal at once, ~3× budget
'full console (stress)':      { patch: { voices: 4, arp: true }, controls: [20 ids] }
```

⚠️ **No drawn song carries an arp** (the arp song came out 2026-08-14), so the
arp family is reachable only by ticking `arp` in the patch editor, or on the
authored stress plate. Flip it on any song to explore it.

```

The roster deliberately spans **2, 3 and 4 voices** (§3c) so the trickle-down is
visible without editing a patch.

```

## 7. The lab

`?song=<substring>` · `?gene=<name>` · `?batch=song` · `?zoom=N` · `?light=1`
all deep-link a view, for screenshots and for sending someone a specific
decision.

**Daylight mode** (`daylight` button · **D** · `?light=1`, remembered) inverts
the lab *and the plates* — the plates are the thing being looked at, so flipping
only the page around them would not help in sunlight.

⛔ **Not an inversion of the drawing.** Every ink is alpha over the ground, so
swapping `#000` for `#fff` would leave a 0.3-alpha gray-150 label almost
invisible on paper. What flips is each ink's BASE VALUE, chosen so every alpha
step lands at the same *contrast* it has on black:

| | dark | light |
|---|---|---|
| `INK(0.30)` | gray-150 over #000 → Δ45 | gray-86 over paper → Δ47 |
| `HI(0.90)` | gray-215 over #000 → Δ194 | gray-20 over paper → Δ202 |
| `TRACK` | white 0.10 → Δ26 | black 0.11 → Δ24 |

⚠️ **The voice palette flips direction too.** `SIMPLE_PALETTE` is the classic
hues *lightened* 18% to carry on black; on paper those wash out (yellow worst),
so daylight *darkens* by 22%. Same hues, opposite correction. And ⛔ `dim()`
mixes toward the **ground**, not toward black — on paper, mixing a voice colour
with black makes it louder, the exact opposite of what every caller wants.

⚠️ The theme must be set **before the first render**: plate inks are baked into
the SVG strings, so a flip has to redraw the grid (and the modal if open) rather
than relying on CSS.

Whether the app itself ever ships this is open — but an inverted faceplate is
exactly the kind of thing this lab exists to look at.

**Two seeds.** `manifestSeed` decides which controls were drawn; `genomeSeed`
decides how they look. Splitting them is what makes the second mode possible:

| | |
|---|---|
| **style mode** (default) | one manifest, twelve arrangements. The right way to judge a LAYOUT — v1's whole workflow |
| **song mode** | twelve cards each drawing their own manifest *and* genome. ⭐ The way to rate the SYSTEM: if one draw in twelve comes out incoherent that is a WEIGHTS problem, and it is invisible in style mode because the controls never change |

The manifest editor leads with the **patch**, and shows a patch-illegal control
**greyed with the reason** rather than hidden — an id that silently vanishes
reads as a missing feature. It also names which list you are looking at
(*drawn · seed …* / *authored by the song* / *hand-edited*), because that
decides whether **re-draw** will change anything.

⚠️ **A patch edit prunes hand-picked controls, it does not reset them.** It used
to null the edits, so flipping `noise` silently redrew a plate you had just
composed by hand. A patch change can only make controls *illegal*, so the picks
survive minus the ones the new patch forbids.

## 7b. What editing the manifest does to your votes

⛔ **The model only sees genes.** A vote is stored against the genome, and
`featurize` reads gene values alone — so it cannot separate *"I disliked this
layout"* from *"I disliked these controls"*. Edit the manifest halfway through a
session, or turn on song mode, and consecutive votes are judgements about
different instruments folded into one model.

That is not fixable by bookkeeping, but it is made **visible**: every rating now
records the control list it was cast under, the stats line warns `⚠ across N
manifests` once the training set spans more than one, and the export carries the
distinct manifests. So the mixture is at least legible, and the data stays
recoverable.

⭐ **The discipline this implies:** rate a *layout* with the manifest held still
(style mode, one plate, twelve arrangements), and use song mode to judge the
*weights* rather than to collect style ratings. Two questions, two modes — and
if the warning appears while you are trying to answer the first one, the
training set has gone mixed.

## 8. Open — needs Dan

Implemented on the plan's recommendation; each is one flag to flip.

1. ✅ **RESOLVED — the pitch array vs the orb handles.** The orbs win; the
   array is deleted (Dan). Frequency is chrome, on every song.
2. **The detune split** (§3) — detune immediate, drift exiled.
3. **The manifest is drawn** (§4b) rather than hand-authored with the weights
   used only as a lint.
4. **`mutePlace` / `panPlace`** (§4) — built as genes rather than decisions,
   since square-vs-cluster is exactly the kind of question the rating loop
   exists to answer.
5. **Granular has no tone family** — ships as filter + reverb. Grains want
   size · density · position · spray.
6. **Should the wave screen be draggable** — the screen *being* the shape
   control, as the EQ graph is the filter control (`SPEC-master-filter.md`
   §15)? Built as a pure display for now; making it a control would buy back
   its whole cost.
7. **Does a granular patch want a different witness** — a grain-cloud picture?
   It now gets none at all (§4c), which is honest but silent.
8. **`arpRatio` and `satButton`** were cut as built-on-a-guess. Say the word if
   either was real.
