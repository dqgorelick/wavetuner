/**
 * MidiCCMap - singleton store of MIDI CC → target bindings.
 *
 * Cardinality is asymmetric:
 *   1 CC  → N targets   (allowed; one fader rides multiple drones)
 *   1 target → 1 CC     (replace-on-bind; the reverse index is single-valued)
 *
 * Targets are identified by a kebab key like `drone-volume:3`. The
 * extension point for future v2 targets (partial volume, bus gain) is
 * `target.kind` + a stable `_targetKey({kind, slot, ...})` encoding.
 *
 * Learn mode: callers set an `armed` target; the next CC message that
 * arrives finalizes the binding (consumed inside MidiInput before the
 * normal dispatch fires).
 *
 * Persistence: toJSON / fromJSON round-trip the table. App boot
 * restores from localStorage["midiMappings.v1"]; bindings whose slot
 * is out of range are kept but inactive (no-op dispatch).
 */

import audioEngine from './AudioEngine';

const STORAGE_KEY = 'midiMappings.v1';

function targetKey(target) {
  if (!target || !target.kind) return null;
  if (target.kind === 'drone-volume') return `drone-volume:${target.slot}`;
  return null;
}

function parseTargetKey(key) {
  const idx = key.indexOf(':');
  if (idx < 0) return null;
  const kind = key.slice(0, idx);
  const rest = key.slice(idx + 1);
  if (kind === 'drone-volume') return { kind, slot: Number(rest) };
  return null;
}

function ccKey(channel, cc) {
  return `${channel}:${cc}`;
}

class MidiCCMap {
  constructor() {
    if (MidiCCMap.instance) return MidiCCMap.instance;
    // Forward: ccKey → Set<targetKey>. Multi-valued.
    this._ccToTargets = new Map();
    // Reverse: targetKey → { channel, cc, lastValue }. Single-valued.
    this._targetToCc = new Map();
    // Learn-arm: target waiting for the next CC to bind. Set by the
    // panel via arm(), consumed by MidiInput.
    this._armed = null;
    // Per-(channel,cc) message counter scoped to a single arm session.
    // We commit a binding only after we see the same (channel, cc) at
    // least twice — a phantom single-shot CC from another MIDI source
    // (IAC driver, controller init message, etc.) won't trip the
    // binding, while any real fader stream produces a second message
    // within milliseconds.
    this._armSeen = null;
    this._listeners = new Set();
    MidiCCMap.instance = this;
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _fire() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('MidiCCMap listener error', e); }
    }
  }

  // Snapshot of all mappings for the panel. Returns rows ordered by
  // target slot so D1 sits above D2 in the UI regardless of bind order.
  list() {
    const out = [];
    for (const [tKey, row] of this._targetToCc.entries()) {
      const t = parseTargetKey(tKey);
      if (!t) continue;
      out.push({
        target: t,
        targetKey: tKey,
        channel: row.channel,
        cc: row.cc,
        lastValue: row.lastValue,
      });
    }
    out.sort((a, b) => {
      if (a.target.kind !== b.target.kind) return a.target.kind.localeCompare(b.target.kind);
      return (a.target.slot ?? 0) - (b.target.slot ?? 0);
    });
    return out;
  }

  get armed() { return this._armed; }

  arm(target) {
    this._armed = target;
    this._armSeen = new Map();
    this._fire();
  }

  cancelArm() {
    if (!this._armed) return;
    this._armed = null;
    this._armSeen = null;
    this._fire();
  }

  // Bind a target to (channel, cc). Replaces any existing CC for that
  // target (single-valued reverse). Adds the target to the CC's
  // fan-out set (multi-valued forward). Other targets sharing the
  // (channel, cc) stay bound.
  bind(target, channel, cc) {
    const tKey = targetKey(target);
    if (!tKey) return;
    // Drop old CC reference for this target if any.
    const prev = this._targetToCc.get(tKey);
    if (prev) {
      const prevCcKey = ccKey(prev.channel, prev.cc);
      const set = this._ccToTargets.get(prevCcKey);
      if (set) {
        set.delete(tKey);
        if (set.size === 0) this._ccToTargets.delete(prevCcKey);
      }
    }
    // Install the new binding.
    this._targetToCc.set(tKey, { channel, cc, lastValue: 0 });
    const newCcKey = ccKey(channel, cc);
    let set = this._ccToTargets.get(newCcKey);
    if (!set) {
      set = new Set();
      this._ccToTargets.set(newCcKey, set);
    }
    set.add(tKey);
    this._fire();
  }

  // Drop a single target's binding. The CC entry is also dropped if
  // this was its last target.
  unbind(target) {
    const tKey = targetKey(target);
    if (!tKey) return;
    const row = this._targetToCc.get(tKey);
    if (!row) return;
    this._targetToCc.delete(tKey);
    const cKey = ccKey(row.channel, row.cc);
    const set = this._ccToTargets.get(cKey);
    if (set) {
      set.delete(tKey);
      if (set.size === 0) this._ccToTargets.delete(cKey);
    }
    this._fire();
  }

  clear() {
    if (this._targetToCc.size === 0 && this._ccToTargets.size === 0 && !this._armed) return;
    this._ccToTargets.clear();
    this._targetToCc.clear();
    this._armed = null;
    this._fire();
  }

  // Called by MidiInput on every CC message. Returns true if the
  // message was consumed (arm captured OR mapping fired).
  handleCc(channel, cc, value) {
    // Learn-arm capture:
    //   1. CCs 32–63 are LSB halves of 14-bit CC pairs (CC X+32 = low
    //      byte of CC X). Skip them so we bind to the MSB on
    //      high-resolution controllers.
    //   2. Phantom single-shot CCs from other MIDI sources (IAC driver,
    //      controller init messages on a different channel) used to
    //      capture the binding before the user's actual fader stream
    //      arrived. Require the same (channel, cc) twice before
    //      committing — real fader motion produces a second message in
    //      milliseconds; one-off phantoms never reach count 2.
    if (this._armed) {
      if (cc >= 32 && cc <= 63) return false;
      const key = ccKey(channel, cc);
      const seen = (this._armSeen.get(key) || 0) + 1;
      if (seen < 2) {
        this._armSeen.set(key, seen);
        return false;
      }
      const target = this._armed;
      this._armed = null;
      this._armSeen = null;
      this.bind(target, channel, cc);
      return true;
    }
    const set = this._ccToTargets.get(ccKey(channel, cc));
    if (!set || set.size === 0) return false;
    const normalized = Math.max(0, Math.min(1, value / 127));
    // Opt-in dispatch log — pairs with MidiInput's raw-byte log so the
    // full path is visible. Toggle via `window.__midiDebug = true`.
    if (typeof window !== 'undefined' && window.__midiDebug === true) {
      // eslint-disable-next-line no-console
      console.log(`[CC] ch${channel} cc${cc} raw=${value} → ${normalized.toFixed(3)} → targets=${[...set].join(',')}`);
    }
    for (const tKey of set) {
      const row = this._targetToCc.get(tKey);
      if (row) row.lastValue = value;
      this._applyToTarget(parseTargetKey(tKey), normalized);
    }
    this._fire();
    return true;
  }

  _applyToTarget(target, normalized) {
    if (!target) return;
    if (target.kind === 'drone-volume') {
      // Out-of-range slots silently no-op. Kept in the table so
      // re-growing the count re-activates the binding.
      const count = audioEngine.getOscillatorCount?.() ?? 0;
      if (target.slot < 0 || target.slot >= count) return;
      audioEngine.setVolume(target.slot, normalized);
    }
  }

  toJSON() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      mappings: this.list().map(r => ({
        channel: r.channel,
        cc: r.cc,
        target: r.target,
      })),
    };
  }

  fromJSON(obj) {
    if (!obj || obj.version !== 1 || !Array.isArray(obj.mappings)) return false;
    this.clear();
    for (const m of obj.mappings) {
      if (!m || typeof m.channel !== 'number' || typeof m.cc !== 'number') continue;
      if (!m.target || m.target.kind !== 'drone-volume') continue;
      if (typeof m.target.slot !== 'number') continue;
      this.bind(m.target, m.channel, m.cc);
    }
    return true;
  }

  saveToStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.toJSON()));
      return true;
    } catch (e) {
      console.warn('MidiCCMap.saveToStorage failed', e);
      return false;
    }
  }

  loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const obj = JSON.parse(raw);
      return this.fromJSON(obj);
    } catch (e) {
      console.warn('MidiCCMap.loadFromStorage failed', e);
      return false;
    }
  }

  clearStorage() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch { /* ignore */ }
  }
}

const midiCCMap = new MidiCCMap();
export default midiCCMap;
export { targetKey, parseTargetKey, STORAGE_KEY };
