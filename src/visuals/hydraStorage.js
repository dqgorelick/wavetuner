/**
 * localStorage persistence for user-authored Hydra sketches. Mirrors
 * the patches/storage.js pattern: a single index key listing ordered
 * IDs, and one key per sketch.
 *
 * Schema is single-version (no migration plumbing) — the format is
 * trivial enough that we'll just deal with breaking changes by
 * re-seeding if it ever shifts.
 */

const KEYS = {
  index: 'wavetuner.hydra.index',
  prefix: 'wavetuner.hydra.',
};

function safeParse(raw) {
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function readIndex() {
  const idx = safeParse(localStorage.getItem(KEYS.index));
  return Array.isArray(idx) ? idx.filter(s => typeof s === 'string') : [];
}
function writeIndex(ids) {
  try { localStorage.setItem(KEYS.index, JSON.stringify(ids)); } catch { /* quota */ }
}

function sketchKey(id) { return `${KEYS.prefix}${id}`; }

export function listUserSketches() {
  const out = [];
  for (const id of readIndex()) {
    const s = safeParse(localStorage.getItem(sketchKey(id)));
    if (s && s.id === id) out.push(s);
  }
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

export function saveSketch({ name, code }) {
  const id = `usr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const ts = new Date().toISOString();
  const sketch = { id, name: name || 'Untitled sketch', code: code || '', createdAt: ts, updatedAt: ts };
  try {
    localStorage.setItem(sketchKey(id), JSON.stringify(sketch));
  } catch { return null; }
  const idx = readIndex();
  idx.unshift(id);
  writeIndex(idx);
  return sketch;
}

export function updateSketch(id, patch) {
  const cur = safeParse(localStorage.getItem(sketchKey(id)));
  if (!cur || cur.id !== id) return null;
  const next = { ...cur, ...patch, id, updatedAt: new Date().toISOString() };
  try { localStorage.setItem(sketchKey(id), JSON.stringify(next)); } catch { return null; }
  return next;
}

export function deleteSketch(id) {
  try { localStorage.removeItem(sketchKey(id)); } catch { /* ignore */ }
  const idx = readIndex().filter(x => x !== id);
  writeIndex(idx);
}
