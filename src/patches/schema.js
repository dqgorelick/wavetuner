// Patch schema constants and small helpers shared across the patches module.
// See research/user-storage-architecture.md for the design rationale.

export const PATCH_SCHEMA = 'wavetuner.patch.v1';

export const STORAGE_KEYS = {
  index: 'wavetuner.patches.index',         // ordered ids of user patches
  patchPrefix: 'wavetuner.patches.',        // wavetuner.patches.<id>
  autosave: 'wavetuner.patches.autosave',   // single rolling slot
  topLevelSchema: 'wavetuner.schema',
};

export const TOP_LEVEL_SCHEMA = '1';

// Lex-sortable client id. Not a true ULID but close enough — timestamp prefix
// keeps natural ordering by creation time.
export function genId(prefix = 'usr') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${rand}`;
}

export function nowIso() {
  return new Date().toISOString();
}

// Compute Hz list from whichever pitch representation the patch carries.
// Returns null if neither ratios+anchor nor a frequencies array is present.
export function patchFrequencies(patch) {
  if (!patch) return null;
  if (Array.isArray(patch.ratios) && patch.ratios.length > 0) {
    const anchor = Number.isFinite(patch.anchorHz) ? patch.anchorHz : 440;
    return patch.ratios.map((r) => r.value * anchor);
  }
  if (Array.isArray(patch.frequencies) && patch.frequencies.length > 0) {
    return patch.frequencies.slice();
  }
  return null;
}
