/**
 * freqRange — the one ceiling every voice clamp answers to.
 *
 * Raised from 20 kHz to 25 kHz (Dan, 2026-08-05) to give TRANSPOSE headroom:
 * the freq panels edit in the SOUNDING domain (nominal × transpose ratio), so
 * a transposed-up patch used to run its top voices into the ceiling and squash
 * the interval it was supposed to be preserving. 25 kHz is deliberately past
 * the audible band — it is headroom for the arithmetic, not a pitch anyone is
 * meant to hear.
 *
 * ⚠️ ABOVE NYQUIST THE OSCILLATOR CLAMPS, THE READOUT DOES NOT. Web Audio pins
 * an OscillatorNode's frequency AudioParam to ±sampleRate/2, so on a 48 kHz
 * context anything over 24 kHz (44.1 kHz: over 22.05 kHz) sounds at Nyquist
 * while the UI still reads the nominal Hz. Inaudible either way, but that
 * band is the one place the number on screen isn't what the oscillator does.
 *
 * The FLOOR is deliberately NOT here: the engine clamps at 0.001 Hz, the
 * spectrum bar at 0.1, the patch thumbnails at 20. Those are three different
 * decisions (sub-audio LFO rates, ruler ends, an audible-band drawing scale)
 * that only look alike.
 *
 * Display/analysis ceilings are also NOT this constant and did not move:
 * DISS_MAX_FREQ (highest partial the dissonance field evaluates — a HEARING
 * limit), TL_AUTO_HI_CEIL (timeline auto-range) and PatchesPanel's thumbnail
 * scale all still stop at 20 kHz on purpose.
 */
export const FREQ_CEIL = 25000;
