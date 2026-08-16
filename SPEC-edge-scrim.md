# Edge scrim — gradient fade-out for off-spectrum orbs (web)

> ## ✅ STATUS: IMPLEMENTED + VERIFIED 2026-08-08 — UNCOMMITTED
>
> Built as specced in `src/components/FrequencySpectrumBar.jsx` + `src/App.css`.
> Headless-verified in both layouts: 18/18 structural checks, and a 90-sample
> sweep of the fade hand-off across the whole band (max |actual − expected| =
> 0.0000). **§7 at the bottom is the pick-up-here section** — what shipped,
> what the numbers were, and the two judgment calls waiting on Dan's eye.
>
> §1–5 are the design as built (still accurate). §6 lists the open calls; the
> defaults specced there are what got implemented.

Line anchors below were verified 2026-08-08 against the *pre-change* working
tree; both files carry unrelated uncommitted work, so locate code by the
quoted text, not blindly by line number.

## 1. Intent (Dan, 2026-08-08)

Voices pushed past the spectrum's left/right boundary currently do a "staggered
fade out (waiting until it is at the edge)". Replace the *perceived* mechanism
with **a black gradient at each edge that comes into effect and swallows the
outgoing voice chrome**. Z-order requirement, verbatim: the gradient sits
**behind the held orbs, but in front of the ones that will be going out of
frame**.

## 2. What exists today

All in `src/components/FrequencySpectrumBar.jsx` + `src/App.css`.

- **One fade value per voice**: `edgeFades` (FrequencySpectrumBar.jsx:3076) —
  `out = max(BAR_H_PADDING - x, x - (BAR_H_PADDING + barWidth), 0)` against the
  voice's TRUE x (`freqXs`), alpha `= max(0, 1 - out / EDGE_FADE_PX)`,
  `EDGE_FADE_PX = 28` (line 374). Zone starts at the BAR edge (last ruler
  tick), not the row edge — that was Round 13 (2026-08-05).
- Applied as inline `filter: opacity(fade)` on every piece of voice chrome:
  orb (~4445), selection ring (~4472), kbd dot (~4498), number label (~4531),
  pan dot + status flash (~4660, ~4708), position line (`_updatePositionLines`
  line 1600, via rAF), Hz float + stem (`--edge-fade`, from `hzFloats[].fade`
  line 3190).
- **Exemptions** (keep all of these): any voice with a live `dragPos`
  (dragged/grabbed — fade forced to 1, e.g. line 4433), the raised
  `hz-raised-${i}` float, staged/generative triangles (own `stageFade`).
- **Behavioral side effects of `edgeFades`** (keep all): `offRow` (fade === 0,
  line 3085) drops the voice from the readout collision pass (line 3179) and
  unmounts the selection ring (line 4467); `pointerEvents: 'none'` on the orb
  at fade 0 (line 4446).
- Why it reads as "staggered": every element shares the same alpha, but a 35px
  glowing disc stays legible at an alpha where 13px text is already gone — so
  the orb *appears* to fade later, and nothing dims at all until the voice is
  past the last tick.

### Stacking context (everything below is inside `.fsb-row`, App.css:4904)

`.freq-spectrum-bar` is `position: relative` with **z-auto — it does NOT
create a stacking context**, so its positioned children's z-indexes compete
directly with the `.fsb-side-*` siblings inside `.fsb-row`'s context. Current
map:

| layer | z | file:line |
|---|---|---|
| curve, track, ticks, `.fsb-lines` SVG, resting `.fsb-dot`, `.fsb-dot-label` | auto (DOM order) | App.css 5045/5065/5131/5175/5426 |
| `.fsb-status` (flash readout) | 6 | App.css:5561 |
| `.fsb-dot:hover`, `.boosted` | 20 | App.css:5192/5230 |
| `.fsb-dot.kbd-active` | 25 | App.css:5318 |
| `.fsb-kbd-dot` | 26 | App.css:5343 |
| `.fsb-dot.dragging`, `.grabbed` | 30 | App.css:5206 |
| `.fsb-sel-ring` | 31 | App.css:5260 |
| `.fsb-status.pinned` (pan dot) | 31 | App.css:5584 |
| `.fsb-hz-float` | 40 | App.css:5477 |
| `.fsb-edge-zone-line` (dashed pan-zone hints) | 200 | App.css:5163 |
| `.fsb-side-left/right` (ALL orb, transpose readout, ± count, help) | auto | App.css:4946 |

One SVG (`.fsb-lines`, JSX line 4041) holds position lines, Hz stems, staged
triangles/tethers, AND the edge-pan rate arrows for dragged/grabbed orbs
(`renderEdgeArrow`, calls at 4374/4386).

Note `.fsb-dot` uses `mix-blend-mode: plus-lighter` (App.css:5181) — an
overlay ABOVE the orb occludes it normally, so the scrim works; just don't try
to do this with a background-colored element BEHIND the orbs (plus-lighter
would add right through it).

## 3. Design

### 3.1 The scrim

Two absolutely-positioned divs (`.fsb-edge-scrim.left` / `.right`) mounted
inside `.freq-spectrum-bar`, spanning the row's full height (`top: 0;
bottom: 0`), `pointer-events: none`. Horizontal linear gradient, transparent
on the bar side → **opaque black** on the outside:

- Inner (transparent) edge: the bar end — `left: BAR_H_PADDING + barWidth` for
  the right scrim (mirror for left). Same origin as the `edgeFades` zone.
- Ramp: transparent → `rgba(0,0,0,1)` over `EDGE_FADE_PX` (28px), i.e. fully
  opaque exactly where `edgeFades` hits 0.
- Then a solid-black tail of at least `DOT_SIZE + EDGE_FADE_PX` (~64px) so an
  orb disc is fully covered before it is removed from view (§3.3), and so the
  scrim visually "holds" the boundary.
- Positions/widths are inline styles derived from `geo` + `barWidth` (they
  change with layout, nothing per-frame). Works identically in flipped and
  classic layouts — the zone is purely horizontal.

**Interaction requirement (Dan, 2026-08-08): orbs behind the scrim stay
grabbable.** The scrim is `pointer-events: none` and hit-testing ignores it
(z-order affects painting only), so a half-swallowed orb still takes the
pointer down. The inactive boundary is unchanged — `pointerEvents: 'none'`
only at fade 0, which is exactly where the gradient is opaque and the
end-ramp (§3.3) has made the orb invisible: *if you can see any of it, you
can grab it.* And grabbing flips the orb to held (z 30, fade exempt), so it
pops in front of the scrim and brightens as you pull it back. Verify this
path (§5): pointer-down on an orb at ~half-band must start a drag.

Color: pure black. The row already sits over `.orb-backdrop`'s 50% black
(App.css:4876) + the oscilloscope canvas, and black is safe in all three
themes (mono included — it's below the ink floor, not chrome).

### 3.2 "Comes into effect" — visibility

The scrim is NOT permanently visible (it would read as a dead black band at
rest). Fade the whole scrim in/out via a `.showing` class +
`opacity` transition (~0.2s ease, matching `.fsb-hz-float`'s pattern,
App.css:5463):

**Show when there is something for it to do**:
`scrimShown = edgeFades.some((f, i) => f < 1 && !heldByPointer(i)) ||
zoomDragLive`, where `zoomDragLive` means a zoom-mode drag/grab is in
progress (frame refits are what push other voices out). Recommended over
gating on gesture-live alone because auto-zoom refits (settle, mute-refit)
can push voices out with no gesture live. Elements stay mounted; only opacity
transitions — same pattern as the Hz strip.

### 3.3 What happens to `edgeFades`

Keep the **math and every behavioral consumer** unchanged (`offRow`,
collision-pass exclusion, `pointerEvents` cutoff, sel-ring unmount). Change
only the **visual application** for elements that now sit UNDER the scrim
(orb, kbd dot, number label, resting pan dot/status, position lines):

- Mid-band, the gradient does the fading — drop the `filter: opacity(fade)`
  for these elements **while the scrim is shown**.
- BUT do not let them pop at fade 0: they must not simply unmount/hide from
  under a gradient that's only *locally* opaque (the orb is 35px wide — its
  inner rim would still be over the semi-transparent part of the ramp).
  Remap instead of removing: element alpha
  `= clamp(fade / 0.3, 0, 1)` — full strength until the voice is 70% through
  the band, then a short ramp to 0 that the opaque end of the gradient hides.
  This also covers the far side: past fade 0 the element is invisible, so the
  solid tail doesn't need to chase arbitrarily far-off-screen `freqXs`
  (deep zoom can put a voice thousands of px out).
- When the scrim is NOT shown (edge case: it's mid fade-out while a voice is
  still partially out), fall back to today's plain `filter: opacity(fade)` so
  nothing hard-pops. Simplest: `alpha = scrimShown ? clamp(fade/0.3,0,1) : fade`.
- Elements ABOVE the scrim keep today's alpha fade untouched: `.fsb-hz-float`
  + stems (z 40, `--edge-fade`) — they're the 13px text whose rate Dan
  already approved in Round 13, and they keep fading identically.

### 3.4 Z-order changes (the actual point of the exercise)

Scrim gets **z-index: 28** — above all resting-voice chrome, below held. The
audit above forces four companion fixes:

1. **`.fsb-side-left/right` → z-index: 29.** The scrim overflows the
   component edge (~30px past it, over the 4px gap into the side areas). The
   ALL orb, transpose readout, ± count and help buttons must not be swallowed;
   29 keeps them under held orbs (30), which can be carried across them today.
2. **Resting selection ring must drop below the scrim.** `.fsb-sel-ring` is 31
   full-time, but it also mounts on a non-held selected voice. Base → 27;
   keep 31 only while its voice is held (the JSX already knows `dragPos` at
   the mount site, ~4466 — set a class or inline zIndex).
3. **Resting pinned pan dot likewise.** `.fsb-status.pinned` is 31 full-time
   (only needed above its own orb, App.css:5580). Base pinned → its current
   ride-along works at 27; restore 31 only with the existing `.dragging`
   class on the status (`.fsb-status.pinned.dragging { z-index: 31 }`).
4. **Held-orb chrome that today relies on z-auto must be lifted:**
   - Classic-mode label riding a dragged orb (`.fsb-dot-label.active-freq`) —
     give it z-index 32 so the live Hz readout isn't swallowed when the orb
     is dragged into the edge zone.
   - **Edge-pan rate arrows** (`renderEdgeArrow`) live in the z-auto
     `.fsb-lines` SVG but appear *precisely* when a held orb sits in the edge
     zone — exactly where the scrim is dark. Move the two arrow blocks
     (JSX ~4370–4393) into a second small SVG layer with z-index 32
     (`.fsb-arrows`, same geometry as `.fsb-lines`).

Accepted (deliberate, do NOT "fix"):
- Position lines/stems of ALL voices — including a held one — stay in the
  z-auto SVG and dip under the scrim near the edges. The line marks the
  frequency, which genuinely is leaving the frame; the held ORB itself stays
  bright above. Splitting per-voice lines across two SVGs is not worth it.
- A released orb settling home (`.settling`, no z) passes under the scrim if
  it was released in the zone — it's headed inward, reads correctly.
- `.fsb-edge-zone-line` (z 200) stays above the scrim — the dashed pan-zone
  hint should remain visible over it.

## 4. Implementation order

1. CSS: `.fsb-edge-scrim` (+ `.showing`), z-slot changes §3.4 items 1–3.
2. JSX: mount the two scrims with `geo`-derived inline geometry; compute
   `scrimShown`; add the `.fsb-arrows` SVG (§3.4 item 4); label z fix.
3. Rework the visual fade application per §3.3 (orb, kbd dot, label, status,
   pan dot, and `_updatePositionLines` line 1600 — pass it the remapped value
   or the raw fade + scrimShown flag via the existing refs, it already reads
   `edgeFadesRef` each rAF).
4. Verify (below), then screenshots for Dan.

## 5. Verification

Use the `wavetuner:verify` skill (headless build/launch/drive recipe).

- To push a NON-dragged voice off the bar you must **deep-zoom a drag on
  another voice** (zoom mode: span follows the drag). Refitting by changing
  frequencies never pushes a voice off; the dragged voice itself is exempt.
- Assert: scrim `.showing` flips on when a voice enters the band; resting orb
  at ~half-band is visually darkened (crop pixels — the orb element itself no
  longer carries a mid-band `filter`, so read PIXELS, not styles); held orb
  dragged into the zone stays bright (z 30 > 28) and its edge arrow is
  visible; ALL orb / count buttons not darkened; at fade 0 the orb's
  `pointerEvents` is `none` and the readout collision pass drops it
  (unchanged behavior).
- ⚠️ A backgrounded tab (`visibilityState === 'hidden'`) freezes CSS
  transitions mid-flight — advance with
  `el.getAnimations().forEach(a => a.finish())` before asserting opacity.
- ⚠️ This file has a history of a mid-session revert-on-disk race — re-grep
  state before assuming edits landed, and don't run two sessions on it.

## 6. Open calls for Dan

1. Scrim show trigger (§3.2): "whenever anything is in the band" (specced) vs
   only during live gestures. Specced version also covers auto-refit pushes.
2. Gradient length/curve: 28px linear matches today's zone; if the fade
   should start *before* the last tick (orbs dimming as they approach), widen
   the inner edge into the bar (e.g. start 12px inside) — one constant.
3. Whether the Hz strip floats (z 40) should ALSO duck under the scrim
   (currently: keep alpha fade, stay above).

---

## 7. What shipped (2026-08-08)

### Code

`FrequencySpectrumBar.jsx`
- New constants beside `EDGE_FADE_PX`: `SCRIM_HOLD_PX` 16, `SCRIM_TAPER_PX`
  40, `SCRIM_W` 84, `SCRIM_HANDOFF` 0.3.
- `scrimShown` memo — `edgeFades.some((f, i) => f < 1 && !orbPosByIndex.has(i))`.
  The `zoomDragLive` half of §3.2 was **dropped**: whenever a voice is actually
  in the band the `some()` already fires, and the extra term only added a black
  band during zoom drags with nothing to swallow. The feared fade-in jump can't
  happen — the flag flips on at the *start* of the band, where the raw and
  remapped curves both equal 1.
- `chromeFades` memo — `scrimShown ? edgeFades.map(f => min(1, f / 0.3)) : edgeFades`.
  Every under-scrim element reads this; `edgeFades` still drives `offRow`, the
  readout collision pass and the orb's `pointerEvents`. The orb site now holds
  both (`fade` for the filter, `live` for pointer events).
- `edgeFadesRef` → `chromeFadesRef` (the rAF only ever wanted the visual value);
  `_updatePositionLines`' last param renamed to match.
- Two `.fsb-edge-scrim` divs with `geo`-derived inline `left`/`width`.
- `.fsb-arrows` — second SVG layer holding the two `renderEdgeArrow` blocks,
  which moved out of `.fsb-lines` (the IIFE now returns a fragment).
- `held` class on the number label and the selection ring, from the NARROW
  predicate `draggingDots.has(i) || grabbedOscs.has(i)` — deliberately not
  `orbPosByIndex`, so a released orb settling home passes under the scrim
  *with* its chrome instead of leaving bits floating over it.

`App.css` — `.fsb-edge-scrim` (+`.left`/`.right`/`.showing`), `.fsb-arrows`
z 32, `.fsb-side` z 29, `.fsb-sel-ring` 31→27 (+`.held` 31), `.fsb-status.pinned`
31→27 (+`.dragging` 31), `.fsb-dot-label.held` 32.

### Measured

- Fade hand-off, 90 samples swept through the band during a live zoom drag:
  max |actual − expected| **0.0000**. Shallow band (raw ≥ 0.35) sits at a flat
  1.00 — the gradient alone does that stretch — then the deep band ramps
  0.97 → 0.04.
- Every sampled orb kept `pointerEvents: auto`, and `elementFromPoint` at the
  center of a half-swallowed orb returns `.fsb-dot`, not the scrim.
- Both layouts: scrim spans the row exactly (154px flipped / 74px classic),
  raises on entry, retracts on release, no page errors. Classic confirms the
  live Hz readout (`.active-freq`, the label that only exists in that layout)
  rides at z 32 over the black.
- All eight changed z-slots re-read off the live cascade and correct.

### Still open

- **Not seen by Dan on real visuals.** In headless the canvas behind the row
  is near-black, so the scrim reads mostly through what it takes away rather
  than as a vignette. Against a live oscilloscope it will read much stronger —
  that is the intent, but the opacity/length may want tuning by eye.
- The two judgment calls in §6 (gradient length, whether the Hz floats duck
  under) are unchanged and still want an opinion.
- iOS has no equivalent; the fade there is still the plain alpha ramp.
