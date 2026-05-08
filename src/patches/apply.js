// Bridge between a Patch object and AudioEngine state.
//
// applyPatch() loads a patch into the running engine (fades around it so
// big jumps in osc count or routing don't pop). capturePatch() is the
// inverse — snapshot the current engine state into a save-ready Patch.

import audioEngine from '../audio/AudioEngine';
import { PATCH_SCHEMA, genId, nowIso, patchFrequencies } from './schema.js';

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
      audioEngine.setAllVolumesBatch(snap.volumes.slice(0, freqs.length));
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
  }

  if (!wasPaused && audioEngine.isInitialized) {
    try { await audioEngine.fadeIn?.(); } catch { /* no-op */ }
  }
  return true;
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
