// Bridge between a Patch object and AudioEngine state.
//
// applyPatch() loads a patch into the running engine (fades around it so
// big jumps in osc count or routing don't pop). capturePatch() is the
// inverse — snapshot the current engine state into a save-ready Patch.

import audioEngine from '../audio/AudioEngine';
import { PATCH_SCHEMA, genId, nowIso, patchFrequencies } from './schema.js';

// Headroom cap for any drone the patch loader puts into a "playing"
// state. Stacking 4-12 sine drones at full volume clips the master
// summing bus on transient material; 0.65 leaves enough room for the
// keyboard pool and reverb tail to ride on top without the limiter
// dipping. Applies to BOTH snapshot-driven volume sets and the
// tuning-only path's restored-from-mute volumes.
const PATCH_LOAD_VOL_CAP = 0.65;
const clampLoadedVol = (v) => Math.max(0, Math.min(PATCH_LOAD_VOL_CAP, +v || 0));

// Random voicing for tuning-only patches (no embedded snapshot). Picks
// 2-4 of the patch's oscillators to play; root (index 0) always
// included. Routing is deterministic L/R-by-index (even → L, odd → R)
// at the call site, so this picker partitions oscillators into the L
// and R pools UP FRONT and alternates pulls (root=L, then R, then L,
// then R) so any voicing of size ≥ 2 hits both speakers. When one pool
// runs dry it falls back to the other side rather than skipping a pull.
//
// Returns Map<oscIndex, channel 0|1>. The caller currently uses only
// the keys (which oscs play); the recorded side matches the panning
// the routing logic will assign downstream so the map is self-
// consistent for any future inspector / debugger.
function pickRandomVoicing(count) {
  const target = 2 + Math.floor(Math.random() * 3); // 2, 3, or 4
  const N = Math.min(target, count);

  // Partition by which speaker the index actually pans to (i % 2).
  const lPool = []; // even indices > 0
  const rPool = []; // odd indices
  for (let i = 1; i < count; i++) {
    if (i % 2 === 0) lPool.push(i); else rPool.push(i);
  }
  // Independent Fisher-Yates so successive loads don't pick the same
  // even/odd slots first.
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  };
  shuffle(lPool);
  shuffle(rPool);

  const sides = new Map();
  sides.set(0, 0); // root is always L (osc 0 routes to channel 0)

  // Alternate R, L, R, L… after the root so {0, root+R} fills both
  // speakers at N=2; N=4 lands on a 2L/2R split.
  let pulls = N - 1;
  let preferR = true;
  while (pulls > 0 && (lPool.length > 0 || rPool.length > 0)) {
    if (preferR && rPool.length > 0) {
      sides.set(rPool.shift(), 1);
    } else if (!preferR && lPool.length > 0) {
      sides.set(lPool.shift(), 0);
    } else if (lPool.length > 0) {
      sides.set(lPool.shift(), 0);
    } else {
      sides.set(rPool.shift(), 1);
    }
    preferR = !preferR;
    pulls--;
  }
  return sides;
}

export async function applyPatch(patch) {
  const freqs = patchFrequencies(patch);
  if (!freqs || freqs.length < 2) return false;

  const wasPaused = audioEngine.paused;
  if (!wasPaused && audioEngine.isInitialized) {
    try { await audioEngine.fadeOut(); } catch { /* no-op */ }
  }

  audioEngine.setOscillatorCount(freqs.length);
  audioEngine.setAllFrequenciesBatch(freqs);

  const snap = patch.snapshot;
  if (snap && audioEngine.isInitialized) {
    if (Array.isArray(snap.volumes)) {
      // Clamp at PATCH_LOAD_VOL_CAP so a hot snapshot can't drop the
      // user into clipping the moment they pick a patch.
      const safeVols = snap.volumes.slice(0, freqs.length).map(clampLoadedVol);
      audioEngine.setAllVolumesBatch(safeVols);
    }
    if (Array.isArray(snap.muted)) {
      snap.muted.slice(0, freqs.length).forEach((m, i) => {
        if (audioEngine.isMuted(i) !== !!m) audioEngine.toggleMute(i);
      });
    }
    if (snap.routing && typeof snap.routing === 'object') {
      for (const [k, channels] of Object.entries(snap.routing)) {
        const idx = parseInt(k, 10);
        if (!Number.isFinite(idx) || idx >= freqs.length) continue;
        const cur = audioEngine.routingMap[idx] ? [...audioEngine.routingMap[idx]] : [];
        for (const ch of cur) audioEngine.removeRouting(idx, ch);
        const next = Array.isArray(channels) ? channels : [channels];
        for (const ch of next) audioEngine.addRouting(idx, ch);
      }
    }
  } else if (audioEngine.isInitialized) {
    // No snapshot — tuning-only patch. Generate a random small voicing so
    // loading e.g. WTP doesn't blast all 12 oscillators at once. Voicing
    // only decides WHICH oscillators play; routing is strictly
    // alternating L/R by index so every patch load reads as a clean
    // L-R-L-R panorama regardless of which voices are unmuted.
    const voicing = pickRandomVoicing(freqs.length);
    for (let i = 0; i < freqs.length; i++) {
      const shouldBeMuted = !voicing.has(i);
      if (audioEngine.isMuted(i) !== shouldBeMuted) audioEngine.toggleMute(i);

      const cur = audioEngine.routingMap[i] ? [...audioEngine.routingMap[i]] : [];
      for (const ch of cur) audioEngine.removeRouting(i, ch);
      audioEngine.addRouting(i, i % 2);

      // Cap any newly-playing slot at PATCH_LOAD_VOL_CAP. toggleMute
      // restores `preMuteVolumes[i]`, which can be hot from a previous
      // session — clamping here keeps the patch load polite.
      if (!shouldBeMuted) {
        const v = audioEngine.getVolume?.(i);
        if (typeof v === 'number' && v > PATCH_LOAD_VOL_CAP) {
          audioEngine.setVolume(i, PATCH_LOAD_VOL_CAP);
        }
      }
    }
  }

  if (!wasPaused && audioEngine.isInitialized) {
    try { await audioEngine.fadeIn?.(); } catch { /* no-op */ }
  }
  return true;
}

// Smooth glide-back used by the "return to patch" button. Glides freqs
// and (when carried) volumes from current state to the patch's values
// in parallel — no master fade, no silence. Mute and routing are
// intentionally left alone: the user's call about WHICH orbs play and
// where they pan should survive a revert. Only the pitch + level
// trajectory snaps back.
//
// Falls back to applyPatch (with its master fade) when the osc count
// has changed since the patch was loaded — adding/removing slots is a
// shape change that can't be hidden behind a glide.
//
// Returns 'smooth' | 'fallback' | false.
const SMOOTH_GLIDE_MS = 800;

export async function applyPatchSmooth(patch) {
  const freqs = patchFrequencies(patch);
  if (!freqs || freqs.length < 2) return false;
  if (!audioEngine.isInitialized) return applyPatch(patch);
  if (audioEngine.getOscillatorCount() !== freqs.length) {
    await applyPatch(patch);
    return 'fallback';
  }

  const snap = patch.snapshot;
  // Frequencies always glide — this is the headline of the smooth
  // revert. Log-space interp inside the engine, ease-in-out cubic.
  audioEngine.glideToFrequencies(freqs, SMOOTH_GLIDE_MS);
  // Volumes glide alongside when the patch carries them. Same duration
  // and ease curve so freqs + vols land together.
  if (snap && Array.isArray(snap.volumes)) {
    audioEngine.glideVolumes(snap.volumes.slice(0, freqs.length), SMOOTH_GLIDE_MS);
  }
  // Wait for the glide to finish before resolving so callers can chain
  // UI updates after the audio has actually settled.
  await new Promise((resolve) => setTimeout(resolve, SMOOTH_GLIDE_MS));
  return 'smooth';
}

// Snapshot current engine state. Returns a Patch with absolute frequencies
// (no ratios) — captured patches are play-state, not tunings.
export function capturePatch({ id, name, source = 'user', description } = {}) {
  const count = audioEngine.getOscillatorCount();
  const frequencies = audioEngine.getAllFrequencies().slice(0, count);
  // getAllVolumes() is 0-100; setAllVolumesBatch() expects 0-1.
  const volumes = audioEngine.getAllVolumes().slice(0, count).map((v) => v / 100);
  const muted = audioEngine.getAllMutedStates().slice(0, count);
  const routingMap = audioEngine.getRoutingMap();
  const routing = {};
  for (let i = 0; i < count; i++) {
    const arr = routingMap[i];
    if (Array.isArray(arr)) routing[i] = [...arr];
  }

  const ts = nowIso();
  return {
    schema: PATCH_SCHEMA,
    id: id || genId('usr'),
    name: name || 'Untitled patch',
    source,
    createdAt: ts,
    updatedAt: ts,
    description,
    frequencies,
    snapshot: { volumes, muted, routing },
  };
}

// Pre-init variant of applyPatch — used at boot before AudioEngine.initialize()
// has run, when fading and the gainNodes don't exist yet. Mutates the
// engine's pending arrays so initialize() picks the patch up directly.
export function preInitApplyPatch(patch) {
  const freqs = patchFrequencies(patch);
  if (!freqs || freqs.length < 2) return false;

  audioEngine.frequencyValues = freqs.slice();
  audioEngine.oscillatorCount = freqs.length;

  const snap = patch.snapshot;
  if (snap) {
    if (Array.isArray(snap.volumes)) {
      audioEngine.volumeValues = snap.volumes.slice(0, freqs.length).map((v) => Math.max(0, Math.min(1, v)));
    }
    if (Array.isArray(snap.muted)) {
      audioEngine.mutedStates = snap.muted.slice(0, freqs.length).map(Boolean);
      // preMuteVolumes mirrors volumeValues at boot — initialize() relies on it
      // having an entry per oscillator.
      audioEngine.preMuteVolumes = audioEngine.volumeValues.slice();
    }
  }
  // Routing applied post-initialize (needs the audio graph to exist).
  return true;
}

// Routing application that's safe to call AFTER initialize() but separate
// from applyPatch (which assumes already-running state). Used during boot
// after handleStart() has built the graph.
export function applyPatchRoutingPostInit(patch) {
  const snap = patch?.snapshot;
  if (!snap?.routing || typeof snap.routing !== 'object') return;
  for (const [k, channels] of Object.entries(snap.routing)) {
    const idx = parseInt(k, 10);
    if (!Number.isFinite(idx) || idx >= audioEngine.getOscillatorCount()) continue;
    const cur = audioEngine.routingMap[idx] ? [...audioEngine.routingMap[idx]] : [];
    for (const ch of cur) audioEngine.removeRouting(idx, ch);
    const next = Array.isArray(channels) ? channels : [channels];
    for (const ch of next) audioEngine.addRouting(idx, ch);
  }
}
