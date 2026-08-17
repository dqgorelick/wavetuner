# EXPLORE — faceplate divergence: styles · UI residents · packers · mood board

*2026-08-17. A divergence round, not a plan: nothing here is committed
work. The parametric system as built (lab v4, iOS spec through §3j) is
deliberately ONE style family — monochrome technical minimalism with a
single composure dial (`school`, Braun ⇄ Bauhaus). This doc explores
what sits OUTSIDE that family, on four fronts Dan asked for: (1)
radically different styles, (2) integration of transport-ish UI
elements (auto start, arp buttons, auto-playhead progress), (3)
different ways to pack elements, (4) mood-board resources. Companion:
`research/faceplate-divergence.html` — the same directions drawn as
SVG sketches.*

*Read against: `parametric-lab.html` (GENES `:1404`, packer `:2880`+),
`wavetuner-native/ios/SPEC-parametric-faceplates.md`,
`SPEC-song-ui-manifest-v2.md` §5 (the chrome rules),
`PLAN-parametric-lab-v4.md`.*

---

## 0. The cost frame (read before falling in love with anything)

Divergence is cheap or expensive depending on WHERE it lands:

| layer | examples | cost |
|---|---|---|
| **render-only** | new stroke treatments, a decorative under-layer keyed off existing genes, theme variants | cheap — no GENES change, no fixtures re-export, but still a Swift re-port of the drawing |
| **new enum values on existing genes** | a 10th `knobStyle`, a 4th `scopeFrame` | medium — GENES vocabulary change ⇒ featurize shifts ⇒ **taste-model re-fit + fixtures re-export + Swift re-port**. Batch these. |
| **new genes** | `ornament`, `labelMode`, `colorLogic` | same as above plus store key-bumps; batch into ONE "vocabulary v2" round |
| **new packer** | radial, bento, signal-path | packer is CONSTANTS + algorithm, not genes — but exposing it to draws means a `flow` value ⇒ vocabulary change. Trial first behind a session param. |
| **chrome-rule breaks** | auto/transport ON the plate | spec §5 hard-rule change — needs Dan's decision round, not a lab experiment alone |

⚠️ Suggested mechanism for ALL of it: a **`?style=` / `?packer=`
session param** exactly like `?voices` (v4 W5) — banner chip while
active, ⛔ never leaks into recipes/fixtures exports or the app sim.
The lab gets to be divergent without the pipeline paying for a single
sketch. Only what survives rating sessions graduates into a batched
vocabulary bump.

⚠️ Second mechanism: most directions below decompose into **five
orthogonal axes** rather than one `idiom` mega-gene — ground ·
ornament · label mode · color logic · material. Sampling axes keeps
outputs divergent-but-coherent, avoids trade-dress mimicry (TE
especially is litigious about panel layouts), and lets the taste model
learn each axis separately instead of one 12-way categorical.

---

## 1. Radically different styles — twelve directions

Each entry: the reference anchors → what it looks like on a 393×292
pane → what it costs genetically. Sketches in the companion HTML.

### 1.1 Silkscreen Schematic — *ARP 2600 / Serge*
The panel graphics DRAW the signal flow: printed lines connect shape →
fold → filter → reverb, function groups get thin silkscreen boxes with
the family name in the border break (classic schematic label style).
The plate becomes a block diagram of the actual patch — and unlike the
hardware it imitates, ours can be TRUE per-song (derive the lines from
the manifest's families + the engine chain in
`SPEC-patch-to-faceplate.md` §2). Genetics: one new gene
`ornament: flowlines`, render-side derivation; strongest synergy with
the signal-path packer (§3.1). Risk: line clutter at 6 voices — gate
on sparse plates or draw voice-family lines as one bus.

### 1.2 Color-Block Paper — *Serge paper faces / Mondrian*
Family sections become FILLED tinted rectangles on a paper ground —
the section wash does the grouping work hairline dividers do today.
Directly violates the house "no filled marks except state" rule, which
is exactly why it reads as a different instrument. Genetics:
`sectionGround: none|wash|block` + needs the light theme to matter
(paper palette question from 08-16 reopens). Cheap render-wise; big
perceptual distance for one gene.

### 1.3 Naked Circuit — *Pocket Operators / Landscape Stereo Field*
Render the plate as its own PCB: a trace-and-pad under-layer at
`INK(0.10)`, controls sitting on gold-ish pads, silkscreen refs
(`R12`, `C4`) as decorative micro-labels. Traces can follow the same
real routing as 1.1 — schematic and PCB are two skins over one derived
graph. Genetics: `ornament: traces` + optional `labelMode: refdes`.
The cheap-charm pole; pairs badly with hero (a giant knob on a PCB
reads wrong), so gate `hero: off`.

### 1.4 Test Bench — *HP / Tektronix / cassette futurism*
The scope gets a GRATICULE (10×8 faint grid + center crosshairs),
knobs get engraved skirts (`scale` style is already 80% there),
readouts go amber tabular, chips become annunciator cells (rounded
rect, lit = filled amber). WaveTuner is literally an oscilloscope app
— this is the style with the strongest *claim* on the subject.
Genetics: `scopeFrame: graticule` (new value), `readoutInk:
amber|ink`, annunciator as a `chipStyle` value. Mostly medium-cost
enum additions. ⚠️ Graticule vs the one-picture rule: it makes the
scope heavier, so probably `scopePlace: banner|hero` only.

### 1.5 Dot-Matrix Discipline — *Elektron / LED grids*
Everything quantizes to a strict module grid: knobs drawn only in
`segments`/`band`, readouts in seven-segment numerals, chips as
backlit matrix cells, jitter forced 0, dividers everywhere. This is
less a new style than a CORNER of the existing space plus two new
treatments (7-seg numerals, cell chips) — a good first trial because a
recipe's locks can almost reach it today.

### 1.6 Mandala — *Soma Lyra-8 / Patterning*
Radial symmetric layout (see packer §3.2): scope or retune at center,
voices on an inner ring, tone/filter/space on outer rings, faint
occult linework connecting mirrored controls. The most radical break
— it abandons the shelf/column grammar entirely. Genetics: packer
first (`?packer=radial`), then `ornament: mandala` for the linework.
Risk: ERGO pass and 50pt cull need re-deriving in polar terms; labels
want tangential placement or none.

### 1.7 Wordless Glyphs — *Ciat-Lonbarde / TE pictograms*
`labels` gains `glyph`: every control's name replaced by a generated
pictogram (shape = actual waveform glyph, filter = rolloff curve,
reverb = decaying pips, drift = wandering line). Readouts become tiny
bars, not numerals. Tests how far plates can drop text — and glyphs
localize for free. Genetics: `labelMode: text|glyph|hidden`
(supersedes `labels`), one glyph set drawn once per family. ⚠️
Accessibility: keep a11y ids/names verbatim; the glyph is visual only.

### 1.8 Poster Plate — *Make Noise / Bauhaus past the current dial*
The current `school: 1` is still polite. This direction adds a large
generative ART LAYER behind the controls — one big geometric form or
curve field (derived from the patch: fold curve, dissonance curve from
`research/dissonance-curves.md`, the wave itself blown up to
ghost-scale) — hero at 2.2–2.5×, diagonal composition. Genetics:
`ornament: artfield` + extending `heroScale`'s ceiling; the art layer
must sit under `INK(0.08)`-ish so the one-picture rule survives in
spirit (it's a GROUND, not a picture).

### 1.9 Functional Candy — *TR-808 / Casio VL-1*
Color logic flips from "accent decorates" to "hue MEANS family":
voices keep the spectrum, tone = orange, filter = yellow, space =
blue, action = red — 808-style. Candy knob caps (filled, dark tick).
Loudest direction; also the most learnable (color teaches the plate).
Genetics: `colorLogic: mono|family|candy` — a genuinely new axis that
subsumes today's `accent` eventually. ⚠️ Run the CVD check
(`PALETTE-CVD-REPORT.md` exists for a reason) — family hues must
survive deuteranopia or carry a value ramp too.

### 1.10 One-Bit — *Playdate / Return of the Obra Dinn*
Pure two-tone: no grays, state via dither fills (ordered 2×2), hard
1px everything. Extreme-constraint style that makes every existing
gene read differently for free. Genetics: a THEME, not genes — third
entry in `THEMES` — plus a dither fill helper. Cheapest radical
direction on the board. Risk: the ink-alpha grammar (0.85/0.3/0.12
tiers) has no direct translation — needs a mapping table, and the
visibility floor work all over again.

### 1.11 Ambient Field — *Bloom / Borderlands Granular*
The panel dissolves: no dividers, no labels, controls as floating soft
orbs loosely gravity-clustered by family (packer §3.6), the scope as a
full-bleed ghost behind everything. The "no faceplate" pole — probably
wrong for the play page, but it is the direction that finally gives
**granular** patches a home (the grain-witness gap: "grains want a
cloud, not a wave"). Genetics: packer + theme + the grain witness;
consider it granular-recipe-only.

### 1.12 Material Plate — *Braun hardware / Arturia-lite*
Subtle skeuomorphism: knobs get a two-stop radial gradient + 1px
highlight rim, the pane gets a barely-there brushed or paper grain,
faders get track insets. NOT photorealism — Rams, not Arturia. This is
the only direction that changes RENDERING treatment without changing
one layout decision. Genetics: `material: flat|soft|engraved` — pure
render axis, no layout interaction, safe to sweep independently. ⚠️
Metal-renderer cost on iOS: gradients per knob are fine in SwiftUI
Canvas, but check the golden-diff tolerance.

### The axis map (how twelve collapse to five)

| axis | values across the twelve |
|---|---|
| **ground** | glass (now) · paper · pcb · graticule · field · 1-bit |
| **ornament layer** | none (now) · flowlines · traces · mandala · artfield |
| **label mode** | text (now) · glyph · refdes · hidden |
| **color logic** | mono-accent (now) · family-coded · candy · two-tone |
| **material** | flat (now) · soft · engraved |

Twelve named styles are points; the generator should get the AXES.
`5×5×4×4×3` is a big space — locks/bounds and the taste model exist
precisely to walk it.

---

## 2. UI-element integration — auto start · arp · auto-playhead

Current law (`SPEC-song-ui-manifest-v2.md` §5): play/pause + volume
are page chrome, never in a manifest; the admission rule for the
plate is IMMEDIACY; auto lives in the merged `chord sequencer &
arpeggiator` pane since §3j; the dwell ring moved to the bottom-bar
transport; `cycleReadout` (ring/bar/both) survives on-plate as
display-only; the arp family is cataloged (`arpOn/arpBpm/arpOct/
arpDir`) but 🔴 blocked on `ArpPatch` and weighted by no shipped
recipe.

### 2.1 The flywheel (auto joins retune, not the rail)
The retune button is already the plate's soul (w 1.0, cycle ring
drawn on "the thing auto re-clicks"). Fuse: **tap = retune now ·
long-press = auto on/off · ring = live dwell progress**, with the
auto state shown as the ring's track brightening (auto armed) vs
absent (manual). No new element, no space cost, and the §3j pane
keeps the detailed dwell/glide controls. This is the smallest
possible break of "auto is transport, not plate" — arguably not a
break at all, since the CONTROL is still retune (immediate); auto is
a mode OF it. Trial: lab checkbox next to the transport-trial chip;
rating surfaces must pin it (same decoupling rule as `simTransChk`).

### 2.2 A progress grammar, not a progress bar
`cycleReadout` has ring · bar. Divergent candidates, all
display-only (the countdown stays "a display, not a control"):

| form | what it is | style synergy |
|---|---|---|
| **scope playhead** | a 1px vertical sweep crossing the wave screen over the dwell | Test Bench (graticule + sweep = literally an oscilloscope) |
| **perimeter fuse** | a hairline running the pane's border, consumed clockwise | Poster / One-Bit |
| **divider runner** | a dot traveling the top divider — the bar, dissolved into existing chrome | Braun end |
| **stem countdown** | spectrum-bar stems dim one per subdivision; the root dims last | Candy / spectral packer |
| **hero drain** | when hero is on, a wedge drains inside the hero's own ring | Bauhaus end |
| **pip trail** | chord-position pips for finite songs (already owed: TODO-songs P1) with the active pip filling as its dwell runs | chords songs only |

⚠️ Ring and bar agree via one `CYCLE_PROGRESS`; any new form must
read from the same clock — and the F5 lesson stands: a frozen
indicator is a lie, so every form pauses by vanishing, not freezing.

### 2.3 Arp as a plate resident (when `ArpPatch` lands)
The catalog rows are toggle/slider/steps/segment — the least
interesting possible drawing of an arpeggiator. Divergent drawings
for the SAME four params:

- **step strip**: `arpOct × direction` rendered as a short segment
  strip that lights in play order — `segments` knob grammar,
  unrolled; doubles as an arp-on indicator (dim when off).
- **direction dial**: a 4-position knob whose face shows the actual
  contour (↑ ↓ ↕ ⤨ as drawn stairstep glyphs, not arrows) — pairs
  with Wordless Glyphs.
- **radial steps**: on the Mandala packer, arp steps as pips orbiting
  the retune center — the arp visibly ORBITS the clock that retunes.
- **immediacy split**: `arpOn` + `arpDir` are immediate → plate;
  `arpBpm` is `Transport.shared.tempo` — shared state, so it stays in
  the pane (a plate control writing global tempo would surprise).
  `arpOct` borderline; suggest plate at w 0.5 as cataloged.

### 2.4 Auto-start affordance
`autoShape` (circle/pill/rect) exists but is rail-bound and the rail
auto button is GONE (§3j). If auto ever returns as a visible
affordance, the divergent options in rank order: (a) the flywheel
(2.1 — recommended, zero new chrome); (b) a first-run-only ghost
chip on the plate ("auto" wash chip that fades permanently once
toggled — teaches the pane exists); (c) resurrect the rail button
per F5 — already built and gated off (`autoWorkReady = false`), the
conservative fallback. ⛔ Not a manifest row: auto still fails the
immediacy rule as a standalone control; only the fusion (2.1) passes.

---

## 3. Packing — eight ways beyond shelves and columns

Everything must keep the contracts: seeded determinism (fixed
iteration counts, no wall-clock, no unseeded RNG), re-lay-never-
re-roll on cap violations, MIN_KNOB 50pt + the knob cull, the ERGO
pass (or a polar equivalent), one picture per plate, shrink-to-fit
last. Trial via `?packer=` (session-only, banner chip, export-inert).

1. **Signal-path flow** — blocks ordered along the real audio chain
   (osc → fold → drive → filter → reverb → out), left→right, voices
   as a parallel bus row. The layout MEANS something; with
   `ornament: flowlines` the plate becomes an honest patch diagram.
   Cheapest radical packer: it is `columns` with a fixed,
   engine-derived section order — `orderSeed` gated off.
2. **Radial rings** — polar packer: center = scope or retune, ring 1
   = voices, ring 2 = tone/filter, ring 3 = space/action. Caps become
   RING_CAP (2–3) and per-ring arc budgets; marriage = mirrored
   placement of level/pan across the ring. Needs polar ERGO (no
   control within 44px of pane edge still applies) and tangential or
   absent labels.
3. **Bento / Mondrian treemap** — recursive guillotine split of the
   zone, one cell per family, cell area ∝ family weight-sum, each
   cell packs internally with the EXISTING row logic. With
   `sectionGround: block` (1.2) this is the Serge plate. Determinism
   trivial; degenerate cells (skinny slivers) are the failure mode —
   enforce min cell aspect, re-split on violation.
4. **Perimeter / bezel** — controls around the pane's edge, scope
   huge in the center (scopePlace: hero taken to its conclusion).
   Reads as "instrument with a screen" (Vital pole). ERGO inverts:
   the BOTTOM edge is prime thumb territory — put action there
   deliberately.
5. **Spectral registration** — generalize `mixerScatter`: EVERY
   per-voice control x-registers to its voice's stem under the
   spectrum bar, plate-wide — level, pan, mute stack vertically per
   voice at the pitch position. The plate becomes a continuation of
   the spectrum. Non-voice families pack in the remaining band.
   Collisions at close pitches resolve by the existing marriage-snap
   (nearest-column assignment), never by moving the stems.
6. **Orbit clusters** — seeded force-relax (FIXED 120 iterations,
   mulberry32 stream, then round to 0.5pt — deterministic): families
   as gravity wells, controls as bodies, glued pairs as stiff
   springs. The organic end; pairs with Ambient Field. The cull +
   ERGO run AFTER relax as deterministic repairs, same as today.
7. **Diagonal cascade** — rows with a monotonic x-offset ramp
   (staircase), hero at the visual origin. Bauhaus poster as a
   PACKER rather than jitter — composed asymmetry instead of noise.
   Cheap: it is the rows packer + a deterministic offset schedule
   (⚠️ rows flow is excluded for draws but the CODE survives — this
   is a reason to keep it alive).
8. **Nested containment** — family boxes drawn as panels-in-panel
   (silkscreen boxes from 1.1, or washes from 1.2), controls inside;
   boxes themselves packed by the column packer. Grouping stops
   being implicit (gaps) and becomes explicit (borders) — frees
   `gapScale` to go TIGHT without losing legibility, which is
   exactly what dense 6-voice plates need.

⚠️ The 1,600-rating lesson (2 rows 68% · 4+ rows ≤10%) says density
kills. Every new packer needs its own cap constant discovered the
same way — rate it, then freeze the cap as a constant, never a gene.

---

## 4. Mood board — resources & references

Full annotated table (30 refs) in `research/faceplate-divergence.html`
§mood-board; headline resources:

**Collectors' sources**
- **ModularGrid** — every eurorack module as a uniform front-panel
  PNG; the single best raw dataset for panel study. modulargrid.net
- **Vintage Synth Explorer** (vintagesynth.com) · **Matrixsynth**
  (matrixsynth.com) · **Perfect Circuit "Signal"** blog (interviews
  with panel designers) · **Reverb listings** (hi-res multi-angle) ·
  **120years.net** (historical instruments)
- **Are.na** — search "synthesizer" / "control panel" channels; has a
  Figma mood-board plugin. **Pinterest**: "synth panel design",
  "eurorack faceplate", "cassette futurism".
- **Fonts In Use** — synth typography IDs (Minimoog = Futura caps;
  808/303 = modified ITC Serif Gothic; SH-series = Data70). The
  MOD WIGGLER synth-fonts megathread has the rest.
- **HUDS+GUIS** (hudsandguis.com) + scifiinterfaces.com — FUI
  archive. **gameuidatabase.com** for game UI (Playdate, Sable,
  Mini Metro, Obra Dinn).
- **Books (Bjooks)**: *Push Turn Move* — THE text on interface design
  in electronic music; *Patch & Tweak* (modular), *Synth Gems 1*,
  *Inspire the Music* (TE).
- **Synth Panels Designer** (synthpanels.design) — free Inkscape
  extension; its component libraries are a ready-made taxonomy of
  faceplate primitives worth mining for the parametric vocabulary.

**Hardware anchors by pole**: Minimoog (warm heritage) · TR-808/303
(functional color / era type) · ARP 2600 & Serge (panel-as-diagram)
· Buchla/Verbos (color = signal type) · EMS Synthi (matrix grid) ·
Make Noise (panel art) · Mutable Instruments (the modern clean pole;
Papernoise case studies are public) · Elektron (grid discipline) ·
Erica (industrial) · TE OP-1/PO/EP-133 (pictograms; naked PCB;
segment type) · Soma Lyra-8 (ritual symmetry) · Ciat-Lonbarde /
Lorre-Mill / Folktek / Bastl (folk-art, etched, plywood) · Critter &
Guitari (candy anodize) · Landscape (bare PCB).

**Software anchors by pole**: Ableton devices (flat info-design) ·
Arturia (photoreal) · u-he (SKINS — the direct precedent for many
faceplates over one synth) · Vital/Serum (viz-first dark dashboard)
· Korg Gadget (a FAMILY of invented mini-hardware identities — the
best model for what a generator should feel like) · Borderlands /
TC-11 / Fluss (no-panel abstraction) · Patterning (radial) ·
Bloom/Scape (ambient-generative) · Moog Model 15 vs Animoog (same
company, opposite poles) · Playdate apps (1-bit).

**Trade-dress note**: sample the AXES, not the brands — TE
especially protects panel layouts aggressively. The five-axis map in
§1 exists partly for this.

---

## 5. If only three things get tried first

1. **`?style=` + `?packer=` session params** (§0) — the enabling
   mechanism; everything else is a sketch until the lab can draw it
   without touching exports.
2. **Test Bench + scope playhead** (1.4 + 2.2) — strongest claim on
   the subject (it's an oscilloscope app), mostly enum-value cost,
   and it answers the auto-playhead ask with the most WaveTuner
   answer possible: the progress IS a sweep on a scope.
3. **Signal-path packer + flowlines** (3.1 + 1.1) — layout that
   means something, implementable as a gated variant of the existing
   column packer, and it sets up 1.3's PCB skin for free.
