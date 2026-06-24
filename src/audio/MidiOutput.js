/**
 * MidiOutput — Web MIDI API sender that mirrors the drone oscillators
 * out as **MPE** (MIDI Polyphonic Expression) so an external synth
 * (target: Vital) can be the actual sound source while this app stays
 * the frequency controller.
 *
 * Why MPE: MIDI never sends a frequency — it sends a note number that
 * the synth maps to a pitch, plus a 14-bit pitch bend offset. In plain
 * MIDI, pitch bend is per-channel and bends every note on that channel.
 * MPE puts **one note per channel**, giving each voice its own private
 * bend. So `note + bend` together express any frequency, and each drone
 * can sweep continuously without retriggering (no envelope click).
 *
 * Zone: MPE lower zone — channel 1 (index 0) is the global/master
 * channel; channels 2–16 (indices 1–15) are member channels, one voice
 * each. We have at most 12 drones, so drone slot `i` maps to member
 * channel index `i + 1` (MIDI channels 2–13).
 *
 * Anchor strategy (dynamic nearest-note): when a voice starts, its note
 * number is the integer MIDI note closest to the drone's current Hz, so
 * the bend begins near center. Vital's bend range is fixed at ±48
 * semitones in MPE mode, giving ~8 octaves of click-free sweep around
 * wherever the voice started. If a held sweep ever exceeds ±48 st we
 * re-anchor with a brief note-off/note-on (rare for drones).
 *
 * Drones have no "velocity" the way a key press does — they're sustained
 * oscillators. So Note On uses a constant velocity and the drone's
 * volume slider drives continuous per-voice expression via **channel
 * pressure** (the MPE Z dimension). Muting a drone sends Note Off;
 * unmuting re-sends Note On at the current pitch.
 *
 * Transport: MPE is ordinary MIDI sent with one-note-per-channel
 * discipline — no special mode. The browser targets a virtual MIDI port
 * (IAC Driver on macOS / loopMIDI on Windows); the synth listens on the
 * other end. See research/midi-mpe-output.md for setup.
 *
 * This singleton reads the drone state straight from AudioEngine and
 * runs its own rAF poll loop (only while enabled) — fully decoupled,
 * no engine changes. The loop diffs frequency / volume / mute / count
 * each frame and emits the minimal set of messages, so glides come
 * across smoothly while a static drone is silent on the wire.
 *
 * Constraints (Web MIDI): HTTPS or localhost required; works in
 * Chrome/Edge/Opera/Firefox; NOT in Safari or any iOS browser.
 */

import audioEngine from './AudioEngine';
import keyboardVoiceManager from './KeyboardVoiceManager';

// ─── MPE / math constants ──────────────────────────────────────────────
const MASTER_CH = 0;            // MIDI channel 1 — global/master
const MEMBER_COUNT = 15;        // full lower zone: channels 2–16
// Default bend range in semitones (±). Matches Vital's fixed MPE range.
// Configurable at runtime via setBendRange() so the app can match a
// synth whose per-note bend range differs (e.g. ±2 in non-MPE mode).
// IMPORTANT: this MUST match the synth's actual pitch-bend range or
// frequency moves will be scaled wrong — pitch will appear "stuck"
// (tiny moves) if the synth is on ±2 while we send ±48-scaled bends.
const DEFAULT_BEND_RANGE = 48;
const BEND_CENTER = 8192;       // 14-bit center
const NOTE_VELOCITY = 100;      // constant; drones have no velocity source
const A4 = 440;

// Status-byte high nibbles.
const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const CC = 0xb0;
const CHANNEL_PRESSURE = 0xd0;
const PITCH_BEND = 0xe0;

// RPN / data-entry CC numbers used to configure the zone + bend range.
const CC_RPN_MSB = 101;
const CC_RPN_LSB = 100;
const CC_DATA_MSB = 6;
const CC_DATA_LSB = 38;

const STORAGE_KEY_PORT = 'midiOutPort';
const STORAGE_KEY_ENABLED = 'midiOutEnabled';
const STORAGE_KEY_BEND_RANGE = 'midiOutBendRange';
const STORAGE_KEY_ZONE_CONFIG = 'midiOutZoneConfig';

function freqToMidi(f) {
  return 69 + 12 * Math.log2(Math.max(1e-6, f) / A4);
}

function clampNote(n) {
  return Math.max(0, Math.min(127, Math.round(n)));
}

// 14-bit bend value placing `freq` at `anchorNote` semitones offset,
// over a ±bendRange window. Clamped to the legal 0..16383 range.
function bendValue(freq, anchorNote, bendRange) {
  const semis = freqToMidi(freq) - anchorNote;
  const v = BEND_CENTER + Math.round((semis / bendRange) * BEND_CENTER);
  return Math.max(0, Math.min(16383, v));
}

function volToPressure(vol) {
  return Math.max(0, Math.min(127, Math.round((vol || 0) * 127)));
}

class MidiOutput {
  constructor() {
    if (MidiOutput.instance) return MidiOutput.instance;

    this._access = null;
    this._port = null;            // the live MIDIOutput, or null
    this._activeOutputId = MidiOutput._loadPort();
    this._devices = [];
    // 'idle' | 'connecting' | 'connected' | 'unsupported' | 'denied' | 'error'
    this._status = 'idle';
    this._error = null;
    // Master enable. Off by default — we never blast MIDI at a synth
    // until the user opts in from the settings panel. Restored from
    // localStorage so a reload keeps the prior choice.
    this._enabled = MidiOutput._loadEnabled();
    this._bendRange = MidiOutput._loadBendRange();
    // Whether to emit the MPE Configuration Message + pitch-bend-range
    // RPN on enable. OFF by default: our target (Vital) is fixed at ±48
    // and KNOWN to break — it stops applying pitch bend entirely — when
    // it receives these RPN messages (forum.vital.audio/t/.../5225). Most
    // MPE synths likewise default member channels to ±48, so no config is
    // needed. Turn on only for a synth that requires explicit RPN setup.
    this._sendZoneConfig = MidiOutput._loadZoneConfig();
    this._listeners = new Set();

    // Per-slot voice state. Index = drone slot. Each entry:
    //   { active, note, lastBend, lastPressure }
    // `note` is the anchor MIDI note while the voice is held.
    this._voices = [];
    // Played-voice channel allocator (computer keyboard + MIDI in). Maps
    // a KeyboardVoiceManager voice id → { ch, note, lastBend, lastPressure }.
    // Drones hold member channels 1..count; played voices take the rest
    // (count+1..15) and steal the oldest played voice when exhausted.
    this._kbdChan = new Map();
    // Independent transport mutes. The drone's own play/pause sets
    // _droneMuted; the master pause (spacebar) sets both. Each silences
    // its half of the output on the synth without disturbing the other;
    // un-muting re-triggers that half from live state on the next sync.
    this._droneMuted = false;
    this._kbdMuted = false;
    this._rafId = null;

    // Kill all notes on the synth when the tab closes / reloads / navigates
    // away. `pagehide` is the reliable one (covers close, reload, and the
    // back/forward cache); `beforeunload` is a fallback. Deliberately NOT
    // `visibilitychange` — that fires on tab switches too, and a music app
    // should keep droning when the user just peeks at another tab.
    if (typeof window !== 'undefined') {
      const onExit = () => this.panic();
      window.addEventListener('pagehide', onExit);
      window.addEventListener('beforeunload', onExit);
    }

    MidiOutput.instance = this;
  }

  // ─── persistence ──────────────────────────────────────────────────
  static _loadPort() {
    try { return localStorage.getItem(STORAGE_KEY_PORT) || null; } catch { return null; }
  }
  _persistPort() {
    try {
      if (this._activeOutputId) localStorage.setItem(STORAGE_KEY_PORT, this._activeOutputId);
      else localStorage.removeItem(STORAGE_KEY_PORT);
    } catch { /* ignore */ }
  }
  static _loadEnabled() {
    try { return localStorage.getItem(STORAGE_KEY_ENABLED) === '1'; } catch { return false; }
  }
  _persistEnabled() {
    try { localStorage.setItem(STORAGE_KEY_ENABLED, this._enabled ? '1' : '0'); } catch { /* ignore */ }
  }
  static _loadBendRange() {
    try {
      const v = parseInt(localStorage.getItem(STORAGE_KEY_BEND_RANGE), 10);
      if (Number.isInteger(v) && v >= 1 && v <= 96) return v;
    } catch { /* ignore */ }
    return DEFAULT_BEND_RANGE;
  }
  _persistBendRange() {
    try { localStorage.setItem(STORAGE_KEY_BEND_RANGE, String(this._bendRange)); } catch { /* ignore */ }
  }
  static _loadZoneConfig() {
    // Defaults to false (do NOT send RPN/MCM) — see _sendZoneConfig.
    try { return localStorage.getItem(STORAGE_KEY_ZONE_CONFIG) === '1'; } catch { return false; }
  }
  _persistZoneConfig() {
    try { localStorage.setItem(STORAGE_KEY_ZONE_CONFIG, this._sendZoneConfig ? '1' : '0'); } catch { /* ignore */ }
  }

  // Opt-in console trace. Set `window.__midiOutDebug = true` in DevTools
  // to watch the message stream — confirms the browser is emitting
  // continuous pitch bends as you move a drone (the web side), separate
  // from whether the synth applies them.
  _dbg(msg) {
    if (typeof window !== 'undefined' && window.__midiOutDebug === true) {
      console.log('[midiOut] ' + msg);
    }
  }

  // ─── getters ──────────────────────────────────────────────────────
  get status() { return this._status; }
  get devices() { return this._devices.slice(); }
  get activeOutputId() { return this._activeOutputId; }
  get error() { return this._error; }
  get enabled() { return this._enabled; }
  get bendRange() { return this._bendRange; }
  get sendZoneConfig() { return this._sendZoneConfig; }
  get droneMuted() { return this._droneMuted; }
  get kbdMuted() { return this._kbdMuted; }
  /**
   * Name of the live output port (e.g. "IAC Driver Bus 1"), or null.
   * Used by MidiInput to drop messages that arrive on the same bus we're
   * sending to — IAC/loopMIDI buses are both an input and an output with
   * the same name (different port ids), so name matching catches the loop.
   */
  get activeOutputName() { return (this._port && this._port.name) || null; }
  /** True once a real port is selected and we're connected. */
  get ready() { return this._status === 'connected' && !!this._port; }

  /**
   * Mute only the drones on the synth, leaving played notes sounding.
   * Drives the drone's own play/pause. Muting sends note-offs for the
   * held drone voices and clears their bookkeeping; un-muting lets the
   * sync loop re-anchor them from current AudioEngine state.
   */
  setDroneMuted(on) {
    const next = !!on;
    if (next === this._droneMuted) return;
    this._droneMuted = next;
    if (next && this._enabled && this._port) {
      for (let slot = 0; slot < this._voices.length; slot++) {
        const v = this._voices[slot];
        if (v && v.active) this._noteOff(this._channelFor(slot), v.note);
      }
      this._voices = [];
    }
    this._fire();
  }

  /**
   * Mute only the played voices (computer keyboard + MIDI in) on the
   * synth, leaving the drones sounding. Un-muting lets the sync loop
   * re-trigger whatever is still held.
   */
  setKbdMuted(on) {
    const next = !!on;
    if (next === this._kbdMuted) return;
    this._kbdMuted = next;
    if (next && this._enabled && this._port) {
      for (const st of this._kbdChan.values()) this._noteOff(st.ch, st.note);
      this._kbdChan.clear();
    }
    this._fire();
  }

  /**
   * MIDI panic — silence the synth no matter what's held. Sends explicit
   * Note Offs for the voices we're tracking, then All Sound Off (CC 120)
   * and All Notes Off (CC 123) on every channel as a belt-and-suspenders
   * for any note we may have lost track of, and recenters pitch bend.
   * Wired to page unload so closing/reloading the tab never leaves a hung
   * note droning on the external synth. Safe to call anytime; no-ops with
   * no port. Does NOT clear the enabled/mute flags — a live session keeps
   * running and the sync loop re-triggers from current state next frame.
   */
  panic() {
    if (!this._port) return;
    this._allNotesOff();
    for (let ch = 0; ch <= MEMBER_COUNT; ch++) {
      this._cc(ch, 120, 0);            // All Sound Off
      this._cc(ch, 123, 0);            // All Notes Off
      this._pitchBend(ch, BEND_CENTER); // recenter bend
    }
    this._voices = [];
    this._kbdChan.clear();
  }

  /**
   * Toggle whether the MPE Configuration Message + pitch-bend-range RPN
   * are emitted on enable. Leave OFF for Vital (it's fixed ±48 and these
   * messages break its pitch bend). Turn on only for a synth that needs
   * explicit RPN configuration. Restarts output so the change applies.
   */
  setSendZoneConfig(on) {
    const next = !!on;
    if (next === this._sendZoneConfig) return;
    this._sendZoneConfig = next;
    this._persistZoneConfig();
    if (this._enabled && this._port) {
      this._stopOutput();
      this._startOutput();
    }
    this._fire();
  }

  /**
   * Set the per-note pitch-bend range in semitones (±). Must match the
   * synth's actual bend range. 48 = Vital MPE (default). Re-emits the
   * zone/bend-range RPN and re-triggers held voices so the new scaling
   * takes effect immediately.
   */
  setBendRange(semitones) {
    const n = Math.max(1, Math.min(96, Math.round(semitones)));
    if (n === this._bendRange) return;
    this._bendRange = n;
    this._persistBendRange();
    if (this._enabled && this._port) {
      // Restart so the synth gets the new RPN and voices re-anchor under
      // the new scaling.
      this._stopOutput();
      this._startOutput();
    }
    this._fire();
  }

  /**
   * Diagnostic: play one steady note and sweep its pitch bend, on a
   * channel away from the drones — isolates "does the synth apply
   * per-note pitch bend at all" from the drone-sync logic. Call from
   * the console: `midiOut.testBend()`.
   *
   * If you HEAR a smooth pitch slide → the synth honors member-channel
   * bend, so the problem is in how the drones drive it (check that
   * `bend` lines stream with `window.__midiOutDebug = true`).
   *
   * If the pitch stays glued to one note → the synth is ignoring
   * per-note bend. In Vital: MPE must be ON, and after loading a patch
   * it often must be toggled OFF then ON before bend registers.
   *
   * Requires a connected port; works even while output is disabled (it
   * sends directly and doesn't touch the drone voices).
   */
  testBend(semitones = 7, durationMs = 4000) {
    if (!this._port) { console.warn('[midiOut] testBend: no MIDI port — connect first'); return; }
    const ch = MEMBER_COUNT;          // MIDI channel 16, clear of drone channels
    const note = 60;                  // C4
    if (this._sendZoneConfig) this._configureZone();
    this._pitchBend(ch, BEND_CENTER);
    this._noteOn(ch, note, NOTE_VELOCITY);
    console.log(
      `[midiOut] testBend: note ${note} on ch${ch + 1}, sweeping ±${semitones}st ` +
      `over ${durationMs}ms (configured range ±${this._bendRange}st). ` +
      'You should hear a continuous pitch slide.'
    );
    const startMs = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - startMs) / durationMs);
      const semis = (t * 2 - 1) * semitones;   // −semitones … +semitones
      const v = Math.max(0, Math.min(16383, BEND_CENTER + Math.round((semis / this._bendRange) * BEND_CENTER)));
      this._pitchBend(ch, v);
      if (t < 1) {
        requestAnimationFrame(step);
      } else {
        this._noteOff(ch, note);
        console.log('[midiOut] testBend: done');
      }
    };
    requestAnimationFrame(step);
  }

  /**
   * Probe a synth's ACTUAL per-note bend range, independent of any
   * assumption. Holds a note and jumps the raw 14-bit bend to full-up,
   * back to center, then full-down — so the pitch jumps by exactly the
   * synth's real ± range. Measure the high and low pitch with a tuner:
   * the interval from center tells you the range (≈2 st → ±2; an octave
   * → ±12; 4 octaves → ±48). Call `midiOut.probeRange()`.
   */
  probeRange(stepMs = 2500) {
    if (!this._port) { console.warn('[midiOut] probeRange: no MIDI port'); return; }
    const ch = MEMBER_COUNT;
    const note = 60;
    this._pitchBend(ch, BEND_CENTER);
    this._noteOn(ch, note, NOTE_VELOCITY);
    const seq = [
      [BEND_CENTER, 'center (note 60 exact)'],
      [16383, 'FULL UP — measure how many semitones above 60'],
      [BEND_CENTER, 'center'],
      [0, 'FULL DOWN — measure how many semitones below 60'],
      [BEND_CENTER, 'center'],
    ];
    console.log('[midiOut] probeRange: raw 14-bit bend jumps — watch a tuner at each step.');
    let i = 0;
    const next = () => {
      if (i >= seq.length) { this._noteOff(ch, note); console.log('[midiOut] probeRange: done'); return; }
      const [v, label] = seq[i++];
      this._pitchBend(ch, v);
      console.log(`[midiOut] probeRange: ${label}`);
      const start = performance.now();
      const wait = () => { (performance.now() - start >= stepMs) ? next() : requestAnimationFrame(wait); };
      requestAnimationFrame(wait);
    };
    next();
  }

  /**
   * Send ONLY the MPE Configuration Message (lower zone, `members`
   * member channels). Per the MPE spec this makes a receiver set its
   * member channels to ±48. Isolated so you can test whether Vital needs
   * it to reach ±48 — and whether it's the message that corrupts Vital.
   * If bends die after this, fully reload the Vital instance.
   */
  sendMcm(members = MEMBER_COUNT) {
    if (!this._port) { console.warn('[midiOut] sendMcm: no MIDI port'); return; }
    this._cc(MASTER_CH, CC_RPN_MSB, 0);
    this._cc(MASTER_CH, CC_RPN_LSB, 6);
    this._cc(MASTER_CH, CC_DATA_MSB, members);
    console.log(`[midiOut] sent MCM: lower zone, ${members} member channels`);
  }

  /**
   * Send ONLY the pitch-bend-range RPN 0 (master ±2, members ±bendRange).
   * The other half of the investigation: tests whether plain RPN 0 sets
   * Vital to ±48 cleanly (no MCM), or whether RPN 0 itself corrupts it.
   */
  sendBendRpn() {
    if (!this._port) { console.warn('[midiOut] sendBendRpn: no MIDI port'); return; }
    this._configureZone();
  }

  // ─── subscription ─────────────────────────────────────────────────
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _fire() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('MidiOutput listener error', e); }
    }
  }

  // ─── connection ───────────────────────────────────────────────────
  /**
   * Request Web MIDI access and wire the output list. Idempotent —
   * safe to call from a "Try again" button. Resolves regardless of
   * success; check `status` afterward.
   */
  async connect() {
    if (this._status === 'connected' || this._status === 'connecting') return;
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      this._status = 'unsupported';
      this._fire();
      return;
    }
    this._status = 'connecting';
    this._fire();
    try {
      this._access = await navigator.requestMIDIAccess({ sysex: false });
      this._access.onstatechange = () => {
        this._refreshDevices();
        this._resolvePort();
      };
      this._refreshDevices();
      this._resolvePort();
      this._status = 'connected';
      this._error = null;
      this._fire();
      // If output was enabled from a prior session and a port resolved,
      // bring the zone up now.
      if (this._enabled && this._port) this._startOutput();
    } catch (err) {
      this._error = err;
      this._status = err && err.name === 'SecurityError' ? 'denied' : 'error';
      this._fire();
      console.warn('MIDI output access failed:', err);
    }
  }

  _refreshDevices() {
    if (!this._access) return;
    const devs = [];
    for (const output of this._access.outputs.values()) {
      devs.push({
        id: output.id,
        name: output.name || 'Unknown',
        manufacturer: output.manufacturer || '',
        state: output.state, // 'connected' | 'disconnected'
      });
    }
    this._devices = devs;
    this._fire();
  }

  /**
   * Resolve `_activeOutputId` to a live MIDIOutput. Defaults to the
   * first available port when nothing is selected yet. If the chosen
   * port vanished (unplugged), drops back to null.
   */
  _resolvePort() {
    if (!this._access) { this._port = null; return; }
    const outputs = [...this._access.outputs.values()];
    if (outputs.length === 0) { this._port = null; return; }

    let port = null;
    if (this._activeOutputId) {
      port = outputs.find((o) => o.id === this._activeOutputId) || null;
    }
    if (!port) {
      port = outputs[0];
      this._activeOutputId = port.id;
      this._persistPort();
    }
    this._port = port;
  }

  setActiveOutput(id) {
    if (id === this._activeOutputId) return;
    // Stop the old port cleanly before switching so it isn't left with
    // hung notes.
    const wasRunning = this._enabled && this._port;
    if (wasRunning) this._stopOutput();
    this._activeOutputId = id || null;
    this._persistPort();
    this._resolvePort();
    if (this._enabled && this._port) this._startOutput();
    this._fire();
  }

  // ─── enable / lifecycle ───────────────────────────────────────────
  setEnabled(on) {
    const next = !!on;
    if (next === this._enabled) return;
    this._enabled = next;
    this._persistEnabled();
    if (next) {
      if (this._port) this._startOutput();
    } else {
      this._stopOutput();
    }
    this._fire();
  }

  /** Start output: optionally configure the MPE zone, then run the loop. */
  _startOutput() {
    if (!this._port) return;
    // Off by default — RPN/MCM breaks Vital's pitch bend. Opt in via
    // setSendZoneConfig(true) only for synths that need it.
    if (this._sendZoneConfig) this._configureZone();
    // Reset voice bookkeeping so the loop re-triggers everything fresh.
    this._voices = [];
    this._kbdChan.clear();
    this._startLoop();
  }

  /** Release every held voice and stop the poll loop. */
  _stopOutput() {
    this._stopLoop();
    this._allNotesOff();
    this._voices = [];
    this._kbdChan.clear();
  }

  /**
   * Set per-channel pitch-bend sensitivity via the spec-standard RPN 0:
   * master channel to ±2, every member channel to ±this._bendRange.
   *
   * Deliberately does NOT send the MPE Configuration Message (MCM, RPN
   * 0x6000) — that is the message that corrupts Vital's pitch-bend
   * handling (it then needs a full plugin reload to recover). Plain
   * RPN 0 is the ordinary MIDI way to set bend range and is what a
   * non-Vital synth needs if it doesn't already default member channels
   * to ±48.
   *
   * Per the MPE spec, a receiver that has entered an MPE zone defaults
   * the master to ±2 and members to ±48; a healthy MPE-enabled Vital
   * already does this, so this whole step is off by default.
   */
  _configureZone() {
    const setRange = (ch, semis) => {
      this._cc(ch, CC_RPN_MSB, 0);
      this._cc(ch, CC_RPN_LSB, 0);
      this._cc(ch, CC_DATA_MSB, semis);  // semitones
      this._cc(ch, CC_DATA_LSB, 0);      // cents
      // Park the RPN (null RPN) so stray data-entry CCs can't retune it.
      this._cc(ch, CC_RPN_MSB, 127);
      this._cc(ch, CC_RPN_LSB, 127);
    };
    setRange(MASTER_CH, 2);              // master/global channel → ±2
    for (let ch = 1; ch <= MEMBER_COUNT; ch++) setRange(ch, this._bendRange);
    this._dbg(`RPN bend range: master ±2st, members ±${this._bendRange}st (no MCM)`);
  }

  // ─── raw senders ──────────────────────────────────────────────────
  _send(bytes) {
    if (!this._port) return;
    try { this._port.send(bytes); } catch (e) { console.warn('MIDI send failed', e); }
  }
  _noteOn(ch, note, vel) { this._send([NOTE_ON | ch, note, vel]); }
  _noteOff(ch, note) { this._send([NOTE_OFF | ch, note, 0]); }
  _cc(ch, num, val) { this._send([CC | ch, num & 0x7f, val & 0x7f]); }
  _pressure(ch, val) { this._send([CHANNEL_PRESSURE | ch, val & 0x7f]); }
  _pitchBend(ch, v14) { this._send([PITCH_BEND | ch, v14 & 0x7f, (v14 >> 7) & 0x7f]); }

  /** Member channel index for drone slot `i`. */
  _channelFor(slot) { return slot + 1; }

  _allNotesOff() {
    if (!this._port) return;
    for (let slot = 0; slot < this._voices.length; slot++) {
      const v = this._voices[slot];
      if (v && v.active) this._noteOff(this._channelFor(slot), v.note);
    }
    for (const st of this._kbdChan.values()) {
      this._noteOff(st.ch, st.note);
    }
  }

  // ─── poll loop ────────────────────────────────────────────────────
  _startLoop() {
    if (this._rafId != null) return;
    const tick = () => {
      this._rafId = requestAnimationFrame(tick);
      this._sync();
    };
    this._rafId = requestAnimationFrame(tick);
  }
  _stopLoop() {
    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }

  /**
   * One reconciliation pass: compare each drone slot's current
   * frequency / volume / mute against the held voice and emit only the
   * messages needed to bring the synth in line.
   */
  _sync() {
    if (!this._enabled || !this._port || !audioEngine.initialized) return;

    const count = audioEngine.getOscillatorCount();

    // Drone reconcile — skipped entirely while the drones are paused on
    // the synth (setDroneMuted already sent their note-offs).
    if (!this._droneMuted) {
    // Release voices for slots that no longer exist (count shrank).
    for (let slot = count; slot < this._voices.length; slot++) {
      const v = this._voices[slot];
      if (v && v.active) {
        this._noteOff(this._channelFor(slot), v.note);
        v.active = false;
      }
    }

    for (let slot = 0; slot < count; slot++) {
      const ch = this._channelFor(slot);
      const muted = audioEngine.isMuted(slot);
      let v = this._voices[slot];
      if (!v) { v = this._voices[slot] = { active: false, note: 60, lastBend: -1, lastPressure: -1 }; }

      if (muted) {
        if (v.active) { this._noteOff(ch, v.note); v.active = false; }
        continue;
      }

      const freq = audioEngine.getFrequency(slot);
      const vol = audioEngine.getVolume(slot);

      if (!v.active) {
        // New voice: anchor at the nearest note, bend first, then Note On
        // (so the synth never glides from the nominal note), then set the
        // expression level.
        v.note = clampNote(freqToMidi(freq));
        const bend = bendValue(freq, v.note, this._bendRange);
        const pressure = volToPressure(vol);
        this._pitchBend(ch, bend);
        this._noteOn(ch, v.note, NOTE_VELOCITY);
        // Re-send the bend AFTER Note On. Some synths (Vital) ignore pitch
        // bend that arrives before the note exists, so a static voice would
        // stay glued to the bare anchor note. This pins the true pitch.
        this._pitchBend(ch, bend);
        this._pressure(ch, pressure);
        v.active = true;
        v.lastBend = bend;
        v.lastPressure = pressure;
        this._dbg(`noteOn  ch${ch + 1} note${v.note} bend${bend} (slot${slot} ${freq.toFixed(2)}Hz)`);
        continue;
      }

      // Held voice — update bend + pressure as needed.
      const semis = freqToMidi(freq) - v.note;
      if (Math.abs(semis) > this._bendRange) {
        // Sweep ran past the ±bendRange window — re-anchor (this retriggers).
        this._noteOff(ch, v.note);
        v.note = clampNote(freqToMidi(freq));
        const bend = bendValue(freq, v.note, this._bendRange);
        const pressure = volToPressure(vol);
        this._pitchBend(ch, bend);
        this._noteOn(ch, v.note, NOTE_VELOCITY);
        // Re-send after Note On — see the note in the fresh-voice branch.
        this._pitchBend(ch, bend);
        this._pressure(ch, pressure);
        v.lastBend = bend;
        v.lastPressure = pressure;
        this._dbg(`re-anchor ch${ch + 1} note${v.note} bend${bend} (slot${slot} ${freq.toFixed(2)}Hz)`);
        continue;
      }

      const bend = bendValue(freq, v.note, this._bendRange);
      if (bend !== v.lastBend) {
        this._pitchBend(ch, bend);
        v.lastBend = bend;
        this._dbg(`bend    ch${ch + 1} → ${bend} (slot${slot} ${freq.toFixed(2)}Hz, anchor ${v.note}, ±${this._bendRange}st)`);
      }
      const pressure = volToPressure(vol);
      if (pressure !== v.lastPressure) {
        this._pressure(ch, pressure);
        v.lastPressure = pressure;
        this._dbg(`press   ch${ch + 1} → ${pressure} (slot${slot})`);
      }
    }
    } // end drone reconcile (this._droneMuted)

    // Played voices (computer keyboard + incoming MIDI) ride the member
    // channels the drones don't occupy.
    this._syncKbdVoices(count);
  }

  /**
   * Mirror the live KeyboardVoiceManager voices out as MPE. Each voice
   * anchors at the MIDI note that was actually played and bends by the
   * microtonal offset of its retuned frequency — so the synth plays the
   * JI / meantone pitch, not equal temperament. Both `kbd` and `midi`
   * source voices flow through here, which is what makes the computer
   * keyboard AND an incoming controller drive the external synth.
   *
   * Channel sharing: drones hold member channels 1..droneCount; played
   * voices allocate from droneCount+1..MEMBER_COUNT and steal the oldest
   * played voice when the pool is exhausted.
   */
  _syncKbdVoices(droneCount) {
    if (this._kbdMuted) return; // played notes paused; drones unaffected
    const voices = keyboardVoiceManager.getActiveVoices();

    // Live = sounding and not yet in its release tail. A voice that has
    // released (or vanished) gets a Note Off and frees its channel.
    const liveIds = new Set();
    for (const v of voices) {
      if (!v.released) liveIds.add(v.id);
    }

    const minCh = droneCount + 1;
    const maxCh = MEMBER_COUNT;
    for (const [id, st] of this._kbdChan) {
      // Released / gone, or the channel fell into the drone range because
      // the drone count grew — release it either way.
      if (!liveIds.has(id) || st.ch < minCh || st.ch > maxCh) {
        this._noteOff(st.ch, st.note);
        this._kbdChan.delete(id);
      }
    }

    if (minCh > maxCh) return; // drones fill every member channel

    const occupied = new Set();
    for (const st of this._kbdChan.values()) occupied.add(st.ch);

    for (const v of voices) {
      if (v.released) continue;
      let st = this._kbdChan.get(v.id);

      if (!st) {
        let ch = -1;
        for (let c = minCh; c <= maxCh; c++) {
          if (!occupied.has(c)) { ch = c; break; }
        }
        if (ch < 0) {
          // Pool full — steal the oldest held played voice.
          const steal = this._oldestKbdVoice(voices);
          if (!steal) continue;
          const stolen = this._kbdChan.get(steal.id);
          this._noteOff(stolen.ch, stolen.note);
          ch = stolen.ch;
          this._kbdChan.delete(steal.id);
        }
        occupied.add(ch);
        const note = clampNote(v.midiNote);
        const bend = bendValue(v.freq, note, this._bendRange);
        const vel = Math.max(1, Math.min(127, Math.round((v.peak || 1) * 127)));
        const pressure = volToPressure(v.amp);
        this._pitchBend(ch, bend);
        this._noteOn(ch, note, vel);
        // Re-send bend after Note On — same synth workaround as the drone path.
        this._pitchBend(ch, bend);
        this._pressure(ch, pressure);
        this._kbdChan.set(v.id, { ch, note, lastBend: bend, lastPressure: pressure });
        this._dbg(`kbd noteOn ch${ch + 1} note${note} bend${bend} (voice${v.id} ${v.freq.toFixed(2)}Hz ${v.source})`);
        continue;
      }

      // Held — update bend + pressure as the voice retunes / swells.
      const bend = bendValue(v.freq, st.note, this._bendRange);
      if (bend !== st.lastBend) {
        this._pitchBend(st.ch, bend);
        st.lastBend = bend;
      }
      const pressure = volToPressure(v.amp);
      if (pressure !== st.lastPressure) {
        this._pressure(st.ch, pressure);
        st.lastPressure = pressure;
      }
    }
  }

  /** Oldest currently-channelled played voice (lowest startTime), or null. */
  _oldestKbdVoice(voices) {
    let oldest = null;
    for (const v of voices) {
      if (!this._kbdChan.has(v.id)) continue;
      if (oldest === null || v.startTime < oldest.startTime) oldest = v;
    }
    return oldest;
  }
}

const midiOutput = new MidiOutput();
export default midiOutput;
