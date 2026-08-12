// Maps a patch object onto engine params. Shared by the browser engine and
// the offline Node probe so both drive the wasm through exactly one code
// path — a probe that set params its own way would prove nothing about what
// the app plays.
//
// The slot fields (root/selection/gain) are separate from the shared params:
// roots are applied by the loader (grains_load_slot resolves them), while
// selection windows and trims are plain params applied here.

import { GrainsParam as P } from './grainsParams.generated.js';

/**
 * @param {(id: number, value: number) => void} setParam
 * @param {object} patch  one of the constants in patches.js
 */
export function applyPatchParams(setParam, patch) {
  setParam(P.Mode, patch.mode);
  setParam(P.Scan, patch.scan);
  setParam(P.Shape, patch.shape);
  setParam(P.Jitter, patch.jitter);
  setParam(P.Dual, patch.dual ? 1 : 0);
  setParam(P.KeyFollow, patch.keyFollow);
  setParam(P.Density, patch.density);
  setParam(P.PrimeL, patch.primeL);
  setParam(P.PrimeR, patch.primeR);
  setParam(P.Dur, patch.dur);
  setParam(P.PosNoise, patch.posNoise);
  setParam(P.PitchL, patch.pitchL);
  setParam(P.PitchR, patch.pitchR);
  setParam(P.Attack, patch.attack);
  setParam(P.Decay, patch.decay);
  setParam(P.Sustain, patch.sustain);
  setParam(P.Release, patch.release);
  setParam(P.CrossWidth, patch.crossWidth);
  setParam(P.MorphBlend, patch.morphBlend);
  setParam(P.MorphAmount, patch.morphAmount);
  setParam(P.PressureDepth, patch.pressureDepth);
  setParam(P.TimbreDepth, patch.timbreDepth);
  setParam(P.MasterGain, patch.masterGain);

  const cross = [P.CrossNote1, P.CrossNote2, P.CrossNote3];
  patch.crossNotes.forEach((note, i) => {
    if (i < cross.length) setParam(cross[i], note);
  });

  patch.slots.forEach((slot, i) => {
    setParam(P.SelStartA + i, slot.selStart);
    setParam(P.SelEndA + i, slot.selEnd);
    setParam(P.GainA + i, slot.gain);
  });
}
