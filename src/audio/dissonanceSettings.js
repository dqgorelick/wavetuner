/**
 * dissonanceSettings — user-facing tunables for the spectrum-bar dissonance
 * HUD that need a persistent home (localStorage) and a settings-panel UI,
 * as opposed to the dev-only window.__diss* console knobs.
 *
 * movingImpact: how much the voice(s) being dragged/grabbed contribute to the
 * displayed consonance field, 0..1.
 *   0   → excluded (the old "landing guide": curve shows only the other voices)
 *   1   → full (the mover counts like any other voice)
 *   0.x → proportional (its partials and self-hot-spot scale down smoothly)
 * Read every frame by FrequencySpectrumBar's draw loop, so changes apply live.
 */

const MOVING_IMPACT_KEY = 'dissMovingImpact';
export const MOVING_IMPACT_MIN = 0;
export const MOVING_IMPACT_MAX = 1;
const MOVING_IMPACT_DEFAULT = 0.3; // mover contributes 30% by default

let _movingImpact = MOVING_IMPACT_DEFAULT;
const _listeners = new Set();

if (typeof window !== 'undefined') {
  try {
    const saved = parseFloat(localStorage.getItem(MOVING_IMPACT_KEY));
    if (Number.isFinite(saved)) {
      _movingImpact = Math.max(MOVING_IMPACT_MIN, Math.min(MOVING_IMPACT_MAX, saved));
    }
  } catch { /* ignore */ }
}

export function getMovingImpact() { return _movingImpact; }

export function setMovingImpact(v) {
  if (!Number.isFinite(v)) return;
  const clamped = Math.max(MOVING_IMPACT_MIN, Math.min(MOVING_IMPACT_MAX, v));
  if (clamped === _movingImpact) return;
  _movingImpact = clamped;
  try { localStorage.setItem(MOVING_IMPACT_KEY, String(clamped)); } catch { /* ignore */ }
  for (const fn of _listeners) {
    try { fn(clamped); } catch { /* ignore */ }
  }
}

export function onMovingImpactChange(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
