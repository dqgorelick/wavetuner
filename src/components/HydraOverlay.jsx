import { forwardRef, useEffect } from 'react';
import { setVisualResolution } from '../visuals/backend';

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
      const dpr = window.devicePixelRatio || 1;
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
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', sizeToParent);
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
