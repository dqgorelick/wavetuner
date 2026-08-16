# SPEC — song UI manifest **v1 (frozen)**

*⛔ Frozen 2026-08-14 alongside `parametric-lab-v1.html`. Kept so v2 can be
read against what it replaced. Live spec: `SPEC-song-ui-manifest.md`.*

*Started 2026-08-14. The data model behind `wavetuner/parametric-lab.html`.
Companion: `wavetuner-native/ios/SPEC-songs.md` (what a song is),
`SPEC-song-save-and-morph.md` (what a song captures).*

---

## 1. The split

```
(manifest, genome, seed) → faceplate
```

| | who writes it | what it decides |
|---|---|---|
| **manifest** | **you, per song** | WHICH controls exist |
| **genome** | seeded PRNG | HOW they're laid out and styled |
| **chrome** | the page | the two rails, spectrum, orb handles, bottom rail — never varies |

**The chrome is a 46pt left rail** — play/pause · volume (· auto, under
`autoPlace: column`) — a hairline away from the pane, which takes the rest
(~323pt).

⛔ **A right rail is built but PARKED** (`RIGHT_RAIL = false`). It held
snapshot · prev/next **song** · shuffle, with the song chevrons stacked
vertically — side by side in a 46pt rail each has to shrink to fit, while
stacked both keep a full-size target and up/down is the axis a vertical rail
already implies. It is switched off until the UX for those actions is settled,
and **the pane takes the width back rather than reserving it**: rating designs
against a reserved-but-empty strip would be composing for a layout that does
not exist. The space is either used or given back, never held.

`chromeRightColumn` is kept intact so the glyphs can be reused wherever those
actions land.

The manifest is **input, never a gene**. Two loads of the same song show the
same controls in a different arrangement. The genome cannot add or remove a
control, and cannot restyle the fixed chrome's position.

## 2. Manifest schema

```jsonc
{
  "voices": 4,
  "controls": ["remix", "drift", "slide", "reverb", "autoCycle", "lpf", "lpfPeak"],
  "pins": { "mixerScatter": 0.92 }          // optional — see §2b
}
```

`controls` is an ordered list of **param ids** from the catalog (§3). Order is
a hint only — the generator groups by family and the genome shuffles the groups.

The **frequency handles** in the spectrum bar (`SPEC-listen-orbs`) — half-size,
sitting under the line — are **fixed chrome on every song**, alongside the
play/volume column and the rail. They are not a manifest field: frequency is
always reachable, on every design.

Their consequence is large: no song has to spend pane space on a `fineTune`,
which is why none of the hello-world variants carries one.

Only their colour varies, via the **`orbInk`** gene — the three readings the
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
nothing else; the layout engine, the manifest editor and the taste model all
read from it.

| id | label | family | kind | notes |
|---|---|---|---|---|
| `drift` | drift | motion | knob | how far the patch wanders |
| `slide` | slide | motion | knob | glide time — the viscosity chase |
| `autoCycle` | cycle | motion | knob | timer that re-clicks `remix` |
| `noise` | noise | tone | knob | |
| `saturation` | drive | tone | knob | |
| `satButton` | sat | tone | segment | soft · warm · hot |
| `width` | width | tone | knob | square PWM |
| `lpf` / `lpfPeak` | lpf / peak | filter | knob | |
| `hpf` / `hpfPeak` | hpf / peak | filter | knob | |
| `filter` / `resonance` | filter / res | filter | knob | the generic single filter |
| `reverb` / `room` | reverb / room | space | knob | |
| `detune` | detune | tuning | knob | **amount** |
| `detuneBtn` | detune | tuning | button | **re-roll the spread** — a different control |
| `fineTune` | fine | tuning | voiceBipolar | one centre-marked lane per voice |
| `levels` | level | voices | voiceFaders | |
| `pans` | pan | voices | voicePans | per-voice pan. **A pan is a knob**, so it wears the active `knobStyle` — it just runs bipolar over the same 270°. See `panFill` in §5b |
| `orbs` | — | voices | orbs | |
| `arpOn` | arp | arp | toggle | on/off — lights in the accent, unlike a view toggle |
| `arpBpm` | tempo | arp | slider | |
| `arpOct` | octaves | arp | steps | |
| `arpDir` | dir | arp | segment | up · down · updn · rand |
| `arpRatio` | ratio | arp | segment | 1:1 · 1:2 · 2:3 · 1:4 |
| `remix` | remix | action | button | the dice |
| `tune` | tune | action | button | align / snap |
| `auto` | auto | action | button | auto-advance on/off, a lemniscate. **The only control that can live outside the pane** — see `autoPlace` |
| `satViz` | sat viz | **view** | toggle | *not an instrument control* |

**`kind`** picks the primitive: `knob` (270° arc + radial tick), `slider`
(the VerticalFader's grammar laid flat — capsule track, capsule fill, the
fill's own rounded end IS the handle), `button` (glyph, optional wash),
`segment` (chip row), `toggle` (line + travelling cap), `steps` (rising bars),
`voiceBipolar` / `voiceFaders` (per-voice lanes, one per voice, lit with the
voice colour), `orbs`.

A `toggle` in the **`view`** family stays on the quiet tier — gray, never lit.
Any other toggle lights in the accent when on, because it *is* an instrument
control. That split is the §5.2 rule expressed in one primitive.

`voiceBipolar` has two orientations behind the **`fineOrient` gene** — same
grammar either way (track · faint centre mark · coloured tick perpendicular to
the track), but `vertical` reads as a mixer strip and `horizontal` reads as a
tuning *ladder*, one line per voice. Orientation is style, not content, so it
is a gene rather than a manifest field — the rating loop settles which suits
`hello world sine waves`.

**`family`** drives grouping. Canonical order:
`voices · motion · tone · filter · space · tuning · arp · action · view`
— the genome shuffles it, with two hard exceptions in §5.

## 4. Couplings — the layout atom is the PAIR, not the control

Some controls are meaningless apart. Declared once, honoured everywhere:

| pair | style | renders as |
|---|---|---|
| `levels` + `pans` | `cluster` | one block holding every voice's fader *and* its pan — see below |
| `lpf` + `lpfPeak` | `concentric` | one body, cutoff outer ring, peak inner ring |
| `hpf` + `hpfPeak` | `concentric` | ditto |
| `filter` + `resonance` | `concentric` | ditto |
| `remix` + `autoCycle` | `timerRing` | the button wearing its timer as a progress ring |
| `tune` + `detune`/`detuneBtn` | `adjacent` | glued side by side, tighter gap than a normal block |

A pair fires **only when both members are present**; otherwise each control
renders alone. `pairStyle: flatten` is a *gene* — it lets the taste loop test
whether you actually prefer concentric pairs or two plain knobs.

The `timerRing` is the one that earns its keep: the auto-cycle knob is a timer
that re-clicks remix, so drawing it *as* remix's ring says what it does. A
separate "cycle" knob elsewhere on the plate would not.

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

## 5. Hard rules (constraints, not genes)

1. **Play/pause and volume are page chrome**, fixed in the left column. Never
   in a manifest, never moved by a genome.
2. **The `view` family is pinned last** and drawn in a quieter tier. A
   visualiser toggle is not an instrument control and must never win the eye
   from one.
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

**`knobStyle`** — eight readings of the same 270° travel, swappable
anywhere a knob appears:

| | |
|---|---|
| `ring` | track arc + radial tick — the PanPot grammar |
| `ringValue` | …plus a filled arc showing the value |
| `tickOnly` | the tick alone ⚠️ nearly invisible at this size |
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

**`autoPlace`** — where the auto button sits. It is the one control that can
leave the pane:

| | |
|---|---|
| `column` | in the **fixed left column** under play, reading as transport — "the thing that keeps it going". The volume capsule shortens to make room |
| `beside` | glued to remix, tighter than a normal gap — "keep re-rolling" |
| `below` | stacked under remix as one unit (`stackBlock`) |

It is genuinely both transport and remix, which is why the position is worth
testing rather than deciding. ⚠️ Note the layout consequence: under `beside` /
`below` the remix **block** has to absorb auto, because remix is usually
already a pair (its timer ring) and the packer only knows how to keep whole
units together.

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

**`fineWidth` / `fineSpacing`** — the fine-tune block claims a share of
the ZONE rather than a fixed size, so at 1.0 it spans the full width and
becomes the plate's spine. `fineSpacing: varied` places the lanes with
**the same rule that places the spectrum stems**, so each voice's lane
sits under its own stem — irregular, but for a reason. Random gaps would
be noise wearing the same clothes.

## 6. The four songs

```js
'square waves immediate slide': { voices: 4,
  controls: ['remix','auto','tune','drift','slide','reverb','autoCycle','lpf','lpfPeak'] }

// the same patch with the arp bolted on — 12 controls, deliberately over
// the budget so the two can be compared side by side
'square waves immediate slide + arp': { voices: 4,      // 14 — over budget on purpose
  controls: ['remix','auto','tune','drift','slide','reverb','autoCycle','lpf','lpfPeak',
             'arpOn','arpBpm','arpOct','arpDir','arpRatio'] }

'cello drone': { voices: 3,
  controls: ['remix','detune','tune','reverb','filter','resonance','noise'] }

'square wave exploration': { voices: 4,
  controls: ['width','reverb','lpf','lpfPeak','hpf','hpfPeak',
             'remix','detune'] }
// The soft·warm·hot mode selector AND the satViz toggle both came out
// (Dan) — saturation has no control on this plate, so a view toggle for
// it had nothing to point at. `satViz` stays in the catalog for a song
// that carries `saturation` itself.


// the hello-world trio. All three hand FREQUENCY to the orb handles, so
// none carries a fineTune. 1→2 differ in content; 2→3 only in character.
'hello world 1 · no mixer': { voices: 4,
  controls: ['noise','saturation','filter','tune','remix','detune'] }

'hello world 2 · mixer, ordered': { voices: 4,
  controls: ['levels','pans','noise','saturation','filter','tune','remix','detune'],
  pins: { mixerScatter: 0, align: 'center', jitter: 0, school: 0.1 } }

'hello world 3 · mixer, abstract': { voices: 4,
  controls: ['levels','pans','noise','saturation','filter','tune','remix','detune'],
  pins: { mixerScatter: 0.92, school: 0.8, hero: 'on' } }

// each half alone. Neither fires the `cluster` pair (it needs both
// members), so 4 renders a plain arc row and 5 a plain fader row —
// and `mixerScatter` has nothing to compose in either. That is the
// honest answer: scatter is a property of the PAIRING, not of faders
// or pans by themselves.
'hello world 4 · pan only':   { voices: 4,
  controls: ['pans','noise','saturation','filter','tune','remix','detune'] }

'hello world 5 · mixer only': { voices: 4,
  controls: ['levels','noise','saturation','filter','tune','remix','detune'] }
```

## 7. Open — needs Dan

1. **The fifth song** never arrived (four were listed under "five examples").
2. **Cello drone says "a remix *knob*"** — every other song says button. Built
   as a button. If it really is a knob, what does turning it do — morph
   between remix states rather than jumping?
3. **`satButton`** is built as a 3-way segment (soft · warm · hot). Dan's note
   just says "a saturation button" — could be a plain on/off.
4. **`slide` was marked "(maybe?)"** — in for now, one checkbox to drop.
5. Does `filter` + `resonance` mean the **master filter** macro
   (`SPEC-master-filter.md`) or a per-song filter? Affects whether the knob
   writes the macro offset layer or the anchors.
6. **What is the arp's "timing ratio"?** Built as a segment of note
   ratios (1:1 · 1:2 · 2:3 · 1:4), i.e. the subdivision against tempo.
   Could equally be swing, or a gate length — both would be knobs
   rather than chips.
7. Should a song be able to **retitle** a param (`drive` → `grit`) for flavour,
   or does one vocabulary stay one vocabulary? Recommend the latter — a
   learnable control language beats per-song poetry.
