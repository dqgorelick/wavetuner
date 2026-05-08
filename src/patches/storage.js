// localStorage CRUD for user patches and the rolling autosave slot.
// All reads tolerate corrupted JSON (skip + log). All writes catch
// QuotaExceededError so the UI can surface a friendlier message later
// without crashing the audio engine.

import { STORAGE_KEYS, TOP_LEVEL_SCHEMA, nowIso } from './schema.js';

let storageAvailable = (() => {
  try {
    const k = '__wavetuner_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
})();

export function isStorageAvailable() {
  return storageAvailable;
}

function safeGet(key) {
  if (!storageAvailable) return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn(`[patches] failed to read ${key}:`, e);
    return null;
  }
}

function safeSet(key, value) {
  if (!storageAvailable) return false;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn(`[patches] failed to write ${key}:`, e);
    return false;
  }
}

function safeRemove(key) {
  if (!storageAvailable) return;
  try { localStorage.removeItem(key); } catch { /* no-op */ }
}

function ensureTopLevelSchema() {
  if (!storageAvailable) return;
  if (!localStorage.getItem(STORAGE_KEYS.topLevelSchema)) {
    safeSet(STORAGE_KEYS.topLevelSchema, TOP_LEVEL_SCHEMA);
  }
}

function readIndex() {
  const idx = safeGet(STORAGE_KEYS.index);
  return Array.isArray(idx) ? idx.filter((s) => typeof s === 'string') : [];
}

function writeIndex(ids) {
  safeSet(STORAGE_KEYS.index, ids);
}

function patchKey(id) {
  return `${STORAGE_KEYS.patchPrefix}${id}`;
}

export function listUserPatches() {
  ensureTopLevelSchema();
  const ids = readIndex();
  const out = [];
  for (const id of ids) {
    const p = safeGet(patchKey(id));
    if (p && p.id === id) out.push(p);
  }
  // Most-recently-updated first.
  out.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return out;
}

export function getUserPatch(id) {
  return safeGet(patchKey(id));
}

export function saveUserPatch(patch) {
  if (!patch || !patch.id) return false;
  ensureTopLevelSchema();
  const stamped = { ...patch, source: 'user', updatedAt: nowIso() };
  if (!stamped.createdAt) stamped.createdAt = stamped.updatedAt;
  const ok = safeSet(patchKey(stamped.id), stamped);
  if (!ok) return false;
  const ids = readIndex();
  if (!ids.includes(stamped.id)) {
    ids.unshift(stamped.id);
    writeIndex(ids);
  }
  return true;
}

export function deleteUserPatch(id) {
  if (!id) return;
  safeRemove(patchKey(id));
  const ids = readIndex().filter((x) => x !== id);
  writeIndex(ids);
}

export function renameUserPatch(id, newName) {
  const p = getUserPatch(id);
  if (!p) return false;
  return saveUserPatch({ ...p, name: newName });
}

// Auto-save slot: a single rolling record holding the user's current state.
// On boot, restored when no URL params are present (App.jsx decides).
export function getAutosave() {
  return safeGet(STORAGE_KEYS.autosave);
}

export function setAutosave(patch) {
  if (!patch) return false;
  return safeSet(STORAGE_KEYS.autosave, { ...patch, updatedAt: nowIso() });
}

export function clearAutosave() {
  safeRemove(STORAGE_KEYS.autosave);
}

// Cross-tab sync. Subscribers fire when *any* wavetuner.patches.* key changes
// in another tab. Returns an unsubscribe function.
export function subscribePatches(fn) {
  if (typeof window === 'undefined') return () => {};
  const handler = (e) => {
    if (!e.key) return;
    if (e.key.startsWith(STORAGE_KEYS.patchPrefix) || e.key === STORAGE_KEYS.index) {
      fn();
    }
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
