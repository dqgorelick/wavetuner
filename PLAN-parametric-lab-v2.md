# PLAN — parametric lab v2

*2026-08-14. ✅ **BUILT** — this plan is now implemented in
`parametric-lab.html`, and `SPEC-song-ui-manifest.md` is the v2 spec. Kept as
the reasoning record. Every open question in §10 was implemented on the
recommendation given here; each is one flag to flip. v1 is frozen at
`parametric-lab-v1.html` + `SPEC-song-ui-manifest-v1.md`.*

---

## 0. What changed

Your note changes the **input** side of the pipeline, barely touching the style
side. v1 was:

```
(manifest, genome, seed) → faceplate          manifest hand-authored per song
```

v2 is:

```
patch → [gates + weights] → manifest → (genome, seed) → faceplate
```

Three real moves, plus one collision:

1. **A patch layer above the manifest.** The engine decides what's *legal*.
2. **Immediacy becomes the plate's admission rule.** The faceplate is the
   surface where every control moves the sound *now*; everything else is
   behind one menu.
3. **Visibility weights replace hand-authored control lists.** You gave
   frequencies (`**`, `*`, "tune half as often as remix") — that's a sampler
   spec, not nine hand-written arrays.
4. **The pitch array collides with the orb handles** (§4). One decision needed.

## 1. The patch layer

Each song gets a patch authored first (by hand now, parametrically later). The
faceplate reads it as gates:

```js
{ engine: 'classic' | 'granular',        // cello grains = granular
  waves:  ['sine','tri','saw','square'], // or ['square'] — a square-only synth
  voices: 4,
  noise:  true,
  arp:    false }
```

Catalog rows carry a `requires(patch)` predicate:

| control | requires |
|---|---|
| `shape` | `engine==='classic' && waves.length > 1` |
| `width` | `waves` is `['square']` only |
| `fold`, `waveLevel` | `engine==='classic'` |
| `noise` | `patch.noise` |
| `arp*` | `patch.arp` |

Note what falls out for free: **"width only on a square-only synth, and only
when there's no shape knob"** needs no UI rule. A square-only patch has nothing
to morph, so `shape` fails its own gate and `width` takes the slot. The patch
enforces it, not the layout engine. Same for "not on cello grains" — one
`engine` field retires three special cases.

⚠️ A granular patch currently has *nothing* in the tone family (no shape, fold
or wave level). It wants its own family — grain size · density · position ·
spray. Out of scope here; flagging it as the first v2.1 job, because "cello
grains" is otherwise a plate of filter and reverb.

## 2. The catalog, retiered

`immediate` is a hard admission flag; `w` is the sampling weight.

**On the plate — immediate**

| id | tier | w | cost | notes |
|---|---|---|---|---|
| `pitch` | ** | 1.0 | 2 | **new** — the slider array. §4 |
| `remix` | ** | 1.0 | 1 | |
| `shape` | * | 0.6 | 1 | **new** · classic only |
| `saturation` | * | 0.6 | 1 | |
| `lpf`+`lpfPeak` | * | 0.6 | 1 | concentric pair, one body |
| `mutes` | * | 0.6 | 1–2 | **new** · square-of-four or a row |
| `pans` | * | 0.6 | 2 | |
| `reverb` | * | 0.6 | 1 | |
| `tune` | * | 0.5 | 1 | half of remix, as specified |
| `levels` | — | 0.4 | 2 | horizontal or vertical, varied lengths |
| `noise` | — | 0.4 | 1 | |
| `waveLevel` | — | 0.4 | 1 | **new** · classic only · blends against `noise` |
| `fold` | — | 0.4 | 1 | **new** · classic only |
| `detune` | — | 0.3 | 1 | see the split below |
| `width` | — | 0.25 | 1 | square-only patches |
| `detuneBtn` | — | 0.2 | 1 | re-roll the spread — a button, instant |

**Off the plate — not immediate → the second menu**

`autoCycle` (dwell time) · `slide` · `drift` · `auto` · `satViz`

**The detune split.** Your list has detune in both places. Read physically
they're two different things and I'd separate them rather than pick:

- **`detune` (amount)** — spreading the oscillators changes the beating the
  instant you turn it. Immediate. Stays, low weight, tied to remix/tune being
  present as you described.
- **`drift` (wander amount)** — changes how far the *next* move goes. Nothing
  happens when you turn it. Not immediate. Exiled, next to dwell and slide.

That reading also explains why they felt like one item: they're the two knobs
that describe the same gesture, one before and one after the fact.

## 3. Cost, not control count

v1's budget was "6–9 controls," which mis-measures the moment a per-voice array
lands: `pitch` + `pans` + `levels` is three entries and most of the plate.
Replace it with the `cost` column — **budget ≈ 10–12 cost units**, where a knob
is 1, a per-voice array is 2, and the level+pan cluster is 3.

The always + mostly tiers alone come to roughly 9 units, which is the honest
message: **the `*` tier essentially is the plate**, and the situational tier
gets whatever's left, usually one or two knobs.

## 4. The pitch array vs the orb handles — needs your call

v1's proudest consequence was that frequency lives in the spectrum bar's orb
handles as fixed chrome, so *no song has to spend pane space on pitch*. You've
now made a pitch slider array the one `**` continuous control. Both can't be
the reason the other is unnecessary.

**Recommendation: the array is the control, the orbs stay as handles on the
picture.** Same parameter, two sites, and that's fine — the timer ring already
establishes a control being mirrored where it means something. The orb sits on
the spectrum where pitch is *visible*; the array sits on the plate where pitch
is *played*. What changes is that the orbs stop being an excuse: the plate
finally carries a first-class continuous pitch control, which is what "always
an immediate impact" most demands.

Two sub-decisions inside that:

- **Absolute, not bipolar.** v1's `fineTune` was a centre-marked offset. A
  `**` pitch control should be the pitch itself, one full-range lane per voice.
  (The old `fineOrient` / `fineWidth` / `fineSpacing` genes retarget onto it
  unchanged — including `varied`, which puts each lane under its own stem.)
- **`pitchOrient: vertical · horizontal · diagonal`** — your "diagonal too
  maybe?" is worth building rather than deciding. A rising diagonal ladder
  literally draws the thing it controls, and it's the one orientation that
  can't be mistaken for a mixer.

## 5. The second menu

Everything non-immediate goes behind one `⋯` on the plate. Build it as the
card's **back face** — tap to flip — so the surface exists and can be judged,
but never competes for the plate.

⛔ **The genome does not style the back face.** It's chrome: a plain list,
same on every song. Styling both faces doubles the search space for the surface
nobody is looking at, and the whole point of the split is that these controls
don't deserve attention.

This also retires v1's §5 rule 2 (the `view` family pinned last in a quiet
tier) — `satViz` is simply on the other face now, and the quiet-tier special
case comes out of the renderer.

## 6. Two seeds

Split the current single seed:

| | |
|---|---|
| `manifestSeed` | which controls got drawn (with the patch, this *is* the song's identity) |
| `genomeSeed` | how they're laid out and styled |

That gives the batch grid two modes, and the second one is new:

- **style mode** — one manifest, 12 arrangements. What v1 did all day.
- **song mode** — 12 cards, each drawing its own manifest *and* genome. This is
  how you rate the **system** rather than a plate: if one draw in twelve comes
  out incoherent, that's a weights problem, and you can't see it in style mode.

A song may still hand-author `controls: [...]` to override the draw — same
spirit as `pins`, and the way you'd lock a song you've already art-directed.

## 7. What comes out (the "simplify" pass)

Each of these is one line to delete, with the reason it earned it. Veto
individually:

| cut | why |
|---|---|
| `backdrop` gene | its own description says "currently decoration — it groups nothing" |
| `tickOnly` knob style | "nearly invisible at this size" — it's been judged |
| `orbs` as a catalog row | it's chrome on every song; a manifest entry for it is a lie |
| `room` | a second reverb knob no song carries; fold into `reverb` |
| `arpRatio` | built on a guess (open question 6) nobody's answered |
| `fineTune` | superseded by `pitch` |
| `view` family + quiet tier | §5 above |
| `RIGHT_RAIL` + `chromeRightColumn` | parked and `false`; dead code in a file being rewritten |
| `satButton` | open question 3, never resolved, and `saturation` covers the plate |

Kept deliberately: `hero`/`heroPick` (retiered — a hero must be a `**` or `*`
control; you don't promote a situational knob), `flow: columns`, and the whole
knob-style set minus `tickOnly`.

## 8. Tiers have to mean something visually

Or they're just draw weights. Three light rules, leaving composition to the
genome:

1. An `always` control has a **size floor** — never smaller than the plate's
   base knob — and is the only tier eligible for `hero`.
2. `mostly` renders normally.
3. `situational` may render at 0.85× and is the only tier the packer is allowed
   to strand in the last row.

## 9. Visual feedback — the wave screen

A small screen showing the waveform, as in the shape/fold menu. It appears when
the plate carries **shape · fold · width**, and less often for **saturation**.

**It doesn't break the immediacy rule — it's that rule made visible.** The plate
claims every control moves the sound *now*; the screen is the plate proving it.
That makes it the natural companion to §2 rather than an exception to it, and it
is the reason to add a display at all: a knob whose effect you can *see* land is
the same argument as a knob whose effect you can *hear* land.

**Port, don't invent.** `WaveShapePreviewView` (`SoundDesignViews.swift:33`,
itself the web's `WaveShapePreview.jsx`) already is this component: one period,
axis hairline at ink 0.1, trace at ink 0.75 in a 1.5pt round-capped line,
160 samples, peak-normalized, on a rounded-rect panel fill. It already runs
**shape → width (duty warp) → fold table → dry/wet mix**, i.e. three of the four
controls Dan named. ⚠️ **Saturation is the one stage it lacks** — the trace
would need the `saturationCurve` waveshaper appended. That's a small real change
to a shipping component, not a lab-only affair.

⛔ **The lab must compute the true trace**, porting `sampleShapeIdeal`
(`visualShape.js`) + the fold table + the sat curve, so the picture reacts to
the drawn control values. A decorative squiggle would make the one thing being
judged — *does this read at 40pt tall?* — unjudgeable.

### It's a witness, not a control

This is the first element that is neither a control nor chrome, and it needs its
own class. It never appears in a manifest's control list; it is a **consequence**
of what's there:

```js
{ id: 'scope', witnesses: ['shape', 'fold', 'width', 'saturation'] }
```

v1's coupling atom was the pair — two controls, one body. This is many controls
→ one display, so `PAIRS` generalises to groups, or the witness binds to
whichever of its subjects are present.

### Weight tracks how much the control moves the trace

That's the honest rule behind "less for saturation": shape, fold and width
**transform the silhouette**; saturation just rounds the peaks off. So
shape/fold/width → w 0.7, saturation alone → w 0.3.

With a consequence worth stating, because it inverts: **when the screen appears
for saturation alone it should be bigger, not smaller.** A subtle change needs
more pixels to be legible; a dramatic one survives at any size.

I read "(and less other things)" both ways and would compose them rather than
pick: saturation draws the screen *less often*, **and** only when the plate has
≥2 cost units spare. A screen for saturation earns its space only on a sparse
plate — which is exactly what the second reading says.

### Placement is a gene — all three are real designs

| `scopePlace` | |
|---|---|
| `inline` | inside the tone block, bound to its control the way the timer ring is bound to remix — *the screen belongs to shape* |
| `banner` | spanning the plate's width — *the screen belongs to the plate* |
| `hero` | the screen large with the knobs small — *the plate belongs to the screen* |

Cost follows: inline 2, banner 3, hero 4. Plus `scopeFrame` (fill · hairline ·
none — the iOS version has fill *and* stroke, which may be one container too
many on the simple theme's black) and `scopeCycles` (1 or 2 periods: one reads
as a *shape*, two read as a *wave*).

### ⛔ At most one picture

The pane already sits under a field sliver and a spectrum bar. A third picture
on 292pt is how a faceplate turns into a dashboard. So: one witness display per
plate, never alongside a `backdrop` (already on the cut list), and when
`scopePlace: hero` the control-side `hero` gene is forced off — two dominant
elements is no dominant element.

### Worth asking: should the screen *be* the shape control?

Dragging across the trace to morph would collapse a display and a control into
one element. That's the move you already made on the master filter — *"the EQ
graph IS the control, the slider row is gone"* (`SPEC-master-filter.md` §15). If
it was right there it may be right here, and it would buy back the screen's
whole cost. Raised as a question rather than assumed, since it also makes the
screen mandatory wherever shape lives.

## 10. Build order

| | | |
|---|---|---|
| P1 | patch layer + catalog rewrite (immediate · w · cost · requires) | data only, no visual change — v2 should render v1's plates unchanged at this point |
| P2 | manifest sampler, two seeds, song-mode batch | |
| P3 | new primitives: `pitch` (3 orientations) · `mutes` (square/row) · `shape` · `fold` · `waveLevel` | the only real drawing work |
| P4 | the **wave screen** (§9): witness class + true trace + 3 placements | do it after P3 — it has nothing to witness until `shape`/`fold` exist |
| P5 | the cut list + the back face | |
| P6 | tier rules + cost budget + fader orientation/length genes | |

⚠️ **Bump the storage keys in P1** — `wt-parametric-lab-v3` → `-v4`, plus the
locks and generations keys. The trained model's weights are keyed to gene
names; v1's ratings would silently poison a changed gene set, and v1 needs to
keep its own ratings attached to the genes they were collected against.

## 10. Open — needs Dan

1. **§4** — array as the pitch control with the orbs kept as handles? (my
   recommendation), or orbs demoted to display-only, or the array kept as an
   offset rather than absolute pitch.
2. **§2 detune split** — detune immediate, drift exiled?
3. **§6** — manifest drawn from weights, or hand-authored per song with the
   weights used only as a lint?
4. **`mutes`** — do they join the `levels`+`pans` cluster as a third member
   (so a voice's strip travels as one block), or stay a separate square of
   four? The square-of-four is a nice shape and the cluster is a coherence
   argument; they pull opposite ways.
5. Does a granular patch get its own tone family now, or ship as filter +
   reverb until then?
6. **§9** — should the wave screen be draggable (the screen *is* the shape
   control, as the EQ graph is the filter control), or stay a pure display?
7. **§9** — a granular patch has no shape/fold/width, so it never gets a
   screen. Does it want a different witness — a grain-cloud picture — or is
   the plate's silence about grains correct for now?
