# Orb Palette & Color-Vision Report

*2026-08-04 · exploration only, no code changed yet*

Interactive companion (live CVD simulation, voice-count stepper, drag demo):
https://claude.ai/code/artifact/dfc7d7e5-ac67-47dc-bfac-b9fdbbcdad2e

## Scope

The oscillator color system lives in two mirrored singletons:

- web: `src/theme/palette.js`
- iOS: `WaveTuner/Models/Palette.swift`

Both expose `oscColor(index, count)` and two themes: **duo** (blue/orange/white)
and **classic** (12-color rainbow cycle). Question examined: what palettes work
for color-blind players, and does the app need a dedicated colorblind mode?

## Method

All numbers below are computed, not eyeballed:

- **Simulation**: Machado–Oliveira–Fernandes (2009) dichromacy transforms at
  severity 1.0 (protanopia, deuteranopia, tritanopia), applied in linear RGB.
- **Distance**: ΔE = Euclidean distance in OKLab × 100 between simulated colors.
- **Thresholds** (from the validator used): worst pair **≥ 8 is safe**; 6–8
  passes only with a secondary cue (our voice numbers under each orb qualify);
  **< 6 means two voices genuinely merge**.
- **Pairing**: all pairs, not just adjacent — any orb can sit next to any other
  on the spectrum bar. Identical-hex slots (duo's whites) are one identity and
  excluded.
- **Surface**: pure black `#000`, the real app background on both platforms.

Incidence context: deuteranopia+deuteranomaly ≈ 5–6% of men, protan ≈ 2%,
tritan ≈ 0.01%. Red–green is the axis that matters.

## Findings: current themes

### duo — already colorblind-safe

Worst pair ΔE **24.4** (deutan, orange↔white). Blue–orange is the one hue pair
every form of dichromacy preserves; duo needs nothing. It effectively *is* the
colorblind mode.

### classic — fails, including for normal vision

| vision | worst pair (N=12) | ΔE |
|---|---|---|
| normal | `#ff4136` ↔ `#e74c3c` (voices 1↔9, the two reds) | **4.4** |
| deutan | 1↔9 | **3.5** |
| protan | `#2ecc40` ↔ `#f8b500` (2↔8, green↔yellow) | **1.2** |
| tritan | 1↔9 | **1.0** |

Two separate problems: red–green pairs collapse under CVD, and the set contains
near-duplicates (`#ff4136`/`#e74c3c`, `#ffdc00`/`#f8b500`) that nobody can tell
apart. The worst confusions are between **arbitrary, distant voices** (1↔9,
2↔8) — color that actively points at the wrong orb.

### the other red/green in the app

Master meter runs green → amber → red (`src/components/Mixer.jsx:303`). Deutan
and protan viewers see green and red zones as near-identical olives. Proposed
fix (meter position already encodes level): one hue for the body, clip as a
*lightness* event — e.g. blue body / amber caution / bright-white clip flash.
One-line change.

## Findings: candidate palettes

### Categorical (stable per-voice identity)

| candidate | hexes | worst pair, min(protan, deutan) | verdict |
|---|---|---|---|
| **classic-cvd** (Okabe-Ito 7-cycle) | `#56b4e9 #e69f00 #009e73 #cc79a7 #f0e442 #0072b2 #d55e00` | **7.6** | warn band — legal with voice-number labels; also fixes classic's normal-vision failures |
| **trio** (duo + pink 3rd accent) | duo + `#ff5da2` at round(2N/3) | **14.2** | passes fully |
| lavender 3rd accent (rejected) | `#b48cff` | **1.4** vs blue | blue↔purple is a protan confusion axis |

Hand-tuning Okabe-Ito (brightening the pink) only relocated the conflict
(pink↔sky-blue 6.6) — the published set is already optimal; use it as-is.

Hard limit: **12 mutually distinguishable hues under red–green CVD do not
exist.** Dichromats retain roughly a blue↔yellow axis plus lightness. Any
12-color scheme must spend lightness as a second axis, or give up pairwise
identity for something else (see rank coloring).

### Twelve-color spectrums (for live use at 8+ voices)

Worst pairs at N=12:

| candidate | construction | normal | deutan | protan | tritan | worst pairs are… |
|---|---|---|---|---|---|---|
| **turbo** | Google turbo polynomial, t ∈ 0.08–0.94 | 5.4 (5↔6) | 2.1 (6↔7) | 2.7 (6↔7) | 4.2 (5↔6) | **adjacent ranks only** |
| **helix** | OKLCH spiral: L 0.56→0.92, C 0.16, hue 250°−300°·t | 4.9 (10↔11) | 3.3 (11↔12) | 0.2 (6↔7) | 2.9 (3↔4) | **adjacent ranks only** |
| pairs (rejected) | 6 hue families × bright/dim | 9.4 | **0.7** (8↔10) | 4.6 | 2.2 | cross-family — dim yellow ↔ dim orange collapse |
| classic (baseline) | shipping rainbow | 4.4 (1↔9) | 3.5 (1↔9) | 1.2 (2↔8) | 1.0 (1↔9) | arbitrary distant voices |
| spectrum | viridis, t = 0.30 + 0.70·i/(N−1) | ~10.5 @ N=6; adjacent merge @ N=12 | | | | adjacent ranks only |

The number that matters is not the ΔE but the *pair pattern*. Ordered ramps
(turbo, helix, viridis) only ever confuse **neighbors**, and neighboring orbs
are separated by screen position anyway. Classic confuses voices 1↔9 — a lie.
Helix additionally has strictly monotone lightness, so voice order survives
even total monochromacy; turbo is the most vivid but peaks mid-scale.

Note turbo/helix beat classic *for normal vision too* (classic's 4.4 worst
pair is non-adjacent; turbo's 5.4 is adjacent).

## Dynamic coloring — rank, not index (Dan's idea, prototyped)

Color follows **frequency rank** (lowest voice = first ramp color, highest =
last) instead of voice index, so color always agrees with position on the
spectrum. Recolor timing = **on release**: while an orb is held, its color is
frozen (stable identity during the gesture, no flicker while crossing
neighbors); on release the whole chord re-sorts and colors tween to new ranks.
Voice numbers under the orbs remain the permanent identity channel.

Why this is the strongest live-use option:

- 12 colors stay *meaningful* under every vision type — when two hues merge,
  order still tells the truth, because color and x-position never disagree.
- It's redundant encoding done with the encoding the app already has (spectral
  position), not a bolted-on "mode."
- Verified in the prototype (headless-Chrome driven): mid-drag the held orb
  keeps its color at any position; on drop it snaps to its new rank color and
  the displaced voices shift by one.

Open design choices: tween duration on re-sort (suggest matching the recall
glide feel), whether muted voices hold a rank or vacate it, and behavior during
GO-glides (freeze until glide end, same deferral as note-offs).

## Recommendation

1. **Keep duo the default.** Already safe (ΔE 24). Nothing to do.
2. **Swap classic's hexes for the Okabe-Ito cycle** ("classic-cvd"). Same
   rainbow feel, better for *everyone* — it also fixes classic's two
   indistinguishable-reds problem. Drop-in change in both palette files.
3. **Add a rank-colored ordered ramp (turbo or helix), recolor-on-release, as
   the live-performance theme.** This is the real answer to "track each of 8+
   voices in a live context."
4. **No "colorblind mode" toggle.** Safe themes signal intent; a mode signals
   an afterthought. The only genuinely red/green-dependent UI left is the
   master meter — fix it for all users (blue body, white clip flash).

## Implementation notes

- Themes 1–2 and static turbo/helix: contained entirely in
  `src/theme/palette.js` + `Palette.swift` (add theme enum case, hex/ramp
  function; both files stay mirrored).
- Rank coloring needs new plumbing: `oscColor(index, count)` doesn't know
  frequency order. Either the palette singleton subscribes to voice-frequency
  state, or callers pass a rank. Also touches the drag/release path (recolor
  trigger) — web first, then iOS port.
- Theme persistence keys already exist (`wavetuner.palette.theme` /
  localStorage); new theme names must survive round-trip in saved patches if
  theme is ever captured there (it isn't today).
- Turbo polynomial (official 5th-order approximation) and the OKLCH helix
  constructor are both in the artifact source
  (scratchpad `wavetuner-palettes.html`) ready to lift.
