# JI Staff Notation — Research & Scoping

Status: proposed
Author: research compiled 2026-07-03

## 0. Goal

Render a **musical staff alongside the existing JI notation** (the Ratio column in
the tuning rail), so the currently-sounding chord is readable as conventional-ish
staff notation with just-intonation accuracy. This is a **UI-only** feature — no
engine changes required (see §4).

Today, "JI notation" in the app means the tabular readout in `FrequencyManager.jsx`
(`FrequencyRow`): each voice shows `Hz · Ratio · Note · Cents`, where the ratio is
the nearest candidate from `nearestRatio()` (`src/audio/jiRatios.js`) or a locked
`{n,d}`. There is **no staff / clef / notehead rendering anywhere in the project** —
it would be built fresh.

## 1. The landscape — JI notation is unsolved-by-consensus

JI notation has several live systems, and which one you pick changes what data the
synth must track. The systems:

### Helmholtz-Ellis (HEJI) — recommended primary
Marc Sabat & Wolfgang von Schweinitz. The closest thing to a modern standard.

- Note names + ordinary ♯/♭ denote the **untempered chain of pure fifths**
  (3-limit / Pythagorean).
- Each higher prime gets its own accidental family **stacked onto that base**:
  up/down arrows fused to the accidental for **syntonic commas (prime 5)**, a
  Tartini-style "7" flag for the **septimal comma (7)**, quartertone-like symbols
  for **11**, and onward through the **13-limit** and beyond in the 2020 revision.
- **Prime-transparent**: you can read the ratio's factorization off the accidental.
- **Real tooling**: glyphs are in the **SMuFL** standard, included in the **Bravura**
  font, supported in **Dorico** and recent **MuseScore**.

### Johnston notation
Ben Johnston — the other historical heavyweight.

- Base scale is a **5-limit JI C major** (not Pythagorean); +/− for syntonic commas,
  `7` / inverted-`7` symbols, arrows for 11, etc.
- Important repertoire uses it, but has a famous wart: the base scale is **uneven**,
  so the same interval spells differently depending on which nominals you're between
  (D–A isn't a pure fifth in the base scale). Requires more **context-dependent
  logic** → HEJI is the safer engineering choice.

### Sagittal
George Secor & Dave Keenan — a large family of arrow-like accidentals to notate any
tuning (JI to arbitrary precision, plus every EDO).

- **Tiered precision** levels (trade accuracy for symbol simplicity).
- "Pure" form (arrows replace ♯/♭ entirely) or "mixed" (arrows alongside conventional
  accidentals). Extremely systematic, great for software generation, **less familiar
  to classically trained readers**. Also in SMuFL/Bravura.

### Cents-deviation notation — pragmatic fallback
Ordinary staff notation + a signed cents offset printed above each note ("−31",
"+14"). Spectral/microtonal composers use it constantly — any performer can act on it
with a tuner, and it's **trivial to generate** (we already know exact frequencies).
Cost: it's **phenomenological, not structural** — a 7/4 and a nearby 12-TET-ish pitch
look categorically identical; harmonic relationships are invisible.

### Ratio / partial annotation
Writing the ratio (7/4, 11/8) or harmonic number directly above noteheads, Partch
lineage. Usually combined with one of the above: staff position + accidental for the
performer, ratio for the analyst. **Nearly free** to add for a synth-generated score —
recommended regardless of primary system.

### 72-EDO approximation (Sims / Maneri)
Quarter-, sixth-, twelfth-tone accidentals notating the nearest 72-EDO degree. 72-EDO
approximates 11-limit JI within ~2–4¢, so it's a "close enough" system with a fixed,
small symbol set and an established performance tradition.

## 2. The insight that matters most for a synth

**Except for cents notation, all of these systems spell pitches from the ratio's prime
factorization, not from the frequency.** A 5/4 third above C and an 81/64 Pythagorean
third are ~21¢ apart but — more importantly — are **spelled differently** (E↓ vs E in
HEJI), and you *cannot* recover which one you meant from Hz alone.

General guidance: carry each note's ratio as a **monzo** (vector of prime exponents,
e.g. `7/4 = [−2 0 0 1]`) from the moment it's generated. The spelling algorithm falls
out: the **3-exponent** walks the chain of fifths to pick the nominal and ♯/♭, and
each higher prime's exponent emits its comma accidental. Bolting notation on *after*
everything is flattened to cents/Hz means reverse-engineering ratios from floats.

## 3. Rendering options for a web app

- **Verovio** (WASM/JS) and **VexFlow** both run in-browser.
- **SMuFL fonts** (Bravura) provide HEJI and Sagittal glyphs.
- **Ekmelos** font (+ `ekmelily` for LilyPond) covers essentially every microtonal
  symbol in circulation.
- A sensible general architecture: **monzo → MusicXML/MEI with SMuFL accidental
  glyphs → Verovio**.

## 4. How this applies to *our* codebase (the important part)

The general "carry a monzo from generation" warning is aimed at engines that only keep
frequencies. **Ours already keeps the rational form all the way to the render point**,
so the warning largely doesn't bite us:

- **Locked voices** carry intended `{n,d}` in `FrequencyManager._slotRatios` →
  `frequencyManager.getRatio(slot)`.
- **Unlocked voices** get `{n,d}` from `nearestRatio(hz/anchorHz, system)` — the same
  call that already renders the Ratio column.

A reduced `n/d` has exactly one prime factorization, so **the monzo is fully
recoverable, losslessly, at the UI layer** — no float archaeology. HEJI spelling is
deterministic from the monzo.

Consequences:

- **No engine re-architecture; no work from the engine-owning agent.** The whole
  feature lives UI-side as pure functions over data that already crosses the boundary.
- **Unlocked voices notate as their nearest candidate** (E♭ vs D♯, comma-down vs not)
  — exactly what the Ratio column already shows. The staff is a second view of the
  same truth.
- **12-TET-system voices** have `n/d = null` → plain notehead + cents tag only.
- The only optional engine-side consideration (not needed for v1): if a locked voice
  should ever notate with a *deliberate* enharmonic spelling different from its
  canonical factorization, that intent would need somewhere to live. Default =
  canonical-from-monzo, which is honest and correct.

Prime basis actually needed: **5/7/11-limit JI, Pythagorean (3), harmonic series
(adds 13 at n=13)** → HEJI accidental families for **5, 7, 11, 13** plus ordinary
♯/♭. A small, bounded set.

### Why NOT Verovio / VexFlow here
Those are **engraving engines** — great for full-score layout (beaming, spacing,
measures). We render a **live chord of ≤12 notes that updates every glide frame**.
Instantiating an MEI→WASM engraver per frame is the wrong tool: heavyweight, and it
fights the house style, which is **hand-drawn inline SVG** (`EnvelopeGraph`,
`CurveEditor`, `WaveShapePreview` are all exactly this).

## 5. Recommended approach

**HEJI as the primary system, with cents deviations and raw ratios printed as
annotations above the staff.** Serves three audiences at once: performers who read
cents, JI-literate readers who read HEJI, and the developer debugging the synth from
the score.

Rendering: **hand-drawn SVG staff** (5 lines, clef, ledger lines, noteheads) fed by
the per-voice data the rail already builds (updates come free). For accidental glyphs,
two paths:

1. **Subset Bravura (SMuFL)** to just the 5/7/11/13 accidentals — canonical glyphs,
   less drawing work; Bravura is ~600KB so subset it aggressively (the app is
   otherwise self-contained). *Leaning option.*
2. **Hand-draw** the ~6–8 accidentals as SVG paths — zero font dependency, fully
   matches the codebase; more upfront drawing, risk of subtly-off glyph shapes.

Third path for fastest first light: **cents-only v1** (plain noteheads + signed cents
tags, no HEJI glyphs), add HEJI accidentals in a second pass.

## 6. Build breakdown (HEJI + cents + ratio)

- **Data** — `ratioToMonzo(n,d)` + `monzoToHeji(monzo)` → `{ nominal, octave,
  alterations[] }`. Pure, unit-testable, UI-side. Basis `[2,3,5,7,11,13]`. *(~1 day)*
- **Render** — `Staff.jsx`: hand-drawn SVG staff, accidental glyphs (subset Bravura
  or hand-drawn), cents tag + raw ratio annotation per voice, colored by
  `palette.oscColor`. Fed live by the same data `FrequencyRow` reads. *(~1–1.5 days)*
- **Total** — ~2–3 days for a correct, live HEJI + cents + ratio staff. No engine
  changes.

## 7. Open decisions (for when this gets picked up)

- **Glyph source**: subset Bravura vs. hand-drawn SVG vs. cents-only v1 (§5).
- **Layout**: vertical chord staff beside the rail / per-row mini-staff / wide staff
  above the panel.
- **Clef range**: grand staff (treble+bass) vs. treble-only vs. auto-pick per note.

## 8. Reference: `ratioToMonzo` sketch

```js
// UI-side, consumes the n/d already available at the render point.
const PRIMES = [2, 3, 5, 7, 11, 13];
function ratioToMonzo(n, d) {           // 7/4 -> [-2,0,0,1,0,0]
  const v = PRIMES.map(() => 0);
  const strip = (x, s) => {
    for (let i = 0; i < PRIMES.length; i++)
      while (x % PRIMES[i] === 0) { x /= PRIMES[i]; v[i] += s; }
    return x;
  };
  if (strip(n, +1) !== 1 || strip(d, -1) !== 1) return null; // outside basis
  return v;
}
```
