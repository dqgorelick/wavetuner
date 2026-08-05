import { forwardRef, useEffect } from 'react';
import { setVisualResolution } from '../visuals/backend';
import { dprCap, onRenderTierChange } from '../visuals/renderTier';

/**
 * The canvas hydra-synth renders into. Mounted as a sibling of the
 * oscilloscope canvas; CSS positions it in the same viewport area.
 *
 * Sized to the parent's bounding rect on mount and resize, with DPR
 * applied so 1px lissajous strokes don't blur when fed through Hydra's
 * texture pipeline. Whenever the backing-store size actually changes,
 * notifies the Hydra wrapper so its internal render targets (s0..s3,
 * o0..o3) get rebuilt at the new dimensions — otherwise feedback
 * effects via o0 keep the old size and read from a stale texture.
 */
const HydraOverlay = forwardRef(function HydraOverlay({ visible }, ref) {
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const sizeToParent = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const rect = parent.getBoundingClientRect();
      // DPR ceiling from the active render tier (2 on 'pretty', 1.5 on
      // 'performance' — see renderTier.js). The visuals are soft feedback/
      // chromatic effects, so the extra pixels of a phone's native DPR 3
      // are invisible, but they cost proportionally in fragment work AND
      // in the per-frame s0 texture upload.
      const dpr = dprCap();
      // Backing-store size at DPR, CSS-displayed at the rect size.
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      const changed = canvas.width !== w || canvas.height !== h;
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      // Rebuild Hydra's render targets to match. Cheap when size is
      // unchanged anyway, but gating on `changed` avoids the cost
      // (regl framebuffer reallocation) on every observer tick.
      if (changed) setVisualResolution(w, h);
    };
    sizeToParent();

    const ro = new ResizeObserver(sizeToParent);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    window.addEventListener('resize', sizeToParent);
    // A tier change moves the DPR ceiling with no layout change behind it,
    // so re-size (and rebuild the render targets) on that too.
    const offTier = onRenderTierChange(sizeToParent);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sizeToParent);
      offTier();
    };
  }, [ref]);

  return (
    <canvas
      ref={ref}
      className="hydra-canvas"
      style={{ display: visible ? 'block' : 'none' }}
      aria-hidden
    />
  );
});

export default HydraOverlay;
