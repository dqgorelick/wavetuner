/**
 * MidiInput - Web MIDI API connector that forwards note-on / note-off /
 * sustain-pedal messages into KeyboardVoiceManager.
 *
 * Singleton. Call `connect()` once (typically right after audio init —
 * the Start gesture is a fine moment). The browser may show a permission
 * prompt; on Chrome/Edge with sysex=false it usually doesn't. Safari
 * lacks Web MIDI entirely → status becomes 'unsupported' and the
 * settings panel surfaces that.
 *
 * Hot-plug: the access object's `onstatechange` re-walks the device
 * list and rewires `onmidimessage` for any new inputs.
 *
 * Active input filter: `setActiveInput('all' | deviceId)`. Defaults to
 * 'all' so any connected controller works out of the box; the settings
 * dropdown can narrow it.
 *
 * v1 message handling: NOTE_ON (0x90), NOTE_OFF (0x80), CC 64 (sustain).
 * Pitch-bend, velocity-curve, and other CCs deferred.
 */

import keyboardVoiceManager from './KeyboardVoiceManager';
import midiCCMap from './MidiCCMap';
import midiOutput from './MidiOutput';

const NOTE_OFF   = 0x80;
const NOTE_ON    = 0x90;
const CC         = 0xb0;
const CC_SUSTAIN = 64;

class MidiInput {
  constructor() {
    if (MidiInput.instance) return MidiInput.instance;

    this._access = null;
    this._activeInputId = 'all';
    this._devices = [];
    // 'idle' | 'connecting' | 'connected' | 'unsupported' | 'denied' | 'error'
    this._status = 'idle';
    this._error = null;
    // MIDI input gate. When false, incoming NOTE_ON / NOTE_OFF / CC are
    // dropped at the source so MIDI input goes silent — but the keyboard
    // bus stays live, so computer-keyboard and on-screen input keep
    // working. Defaults true; toggled from the Settings panel.
    this._enabled = true;
    // Input device ids that share a name with the active MIDI output port.
    // Messages from these are dropped to break the feedback loop — IAC /
    // loopMIDI buses appear as both an input and an output with the SAME
    // name but DIFFERENT ids, so we match on name. Recomputed whenever the
    // device list or the active output changes.
    this._blockedInputIds = new Set();
    this._listeners = new Set();
    // Activity callbacks for the corner button's two dots. Fired on
    // every accepted note / CC message regardless of whether it maps
    // to anything — the dots are just "wire is alive" indicators.
    // Callbacks throttle themselves; this layer just dispatches.
    this._activityListeners = new Set();

    // Recompute the loopback block-list when the output port changes.
    midiOutput.onChange(() => this._recomputeBlocked());

    MidiInput.instance = this;
  }

  // Rebuild the set of input ids whose device name matches the active
  // output port — those are the loopback culprits. Cheap; runs on device
  // hot-plug and on any output-port change.
  _recomputeBlocked() {
    const outName = midiOutput.activeOutputName;
    const blocked = new Set();
    if (outName) {
      for (const d of this._devices) {
        if (d.name === outName) blocked.add(d.id);
      }
    }
    this._blockedInputIds = blocked;
  }

  get status() { return this._status; }
  get devices() { return this._devices.slice(); }
  get activeInputId() { return this._activeInputId; }
  get error() { return this._error; }
  get enabled() { return this._enabled; }

  setEnabled(on) {
    const next = !!on;
    if (next === this._enabled) return;
    this._enabled = next;
    this._fire();
  }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _fire() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('MidiInput listener error', e); }
    }
  }

  // 'note' | 'cc' activity pings. Listener gets `(kind)`.
  onActivity(fn) {
    this._activityListeners.add(fn);
    return () => this._activityListeners.delete(fn);
  }

  _fireActivity(kind) {
    for (const fn of this._activityListeners) {
      try { fn(kind); } catch (e) { console.error('MidiInput activity listener error', e); }
    }
  }

  /**
   * Request Web MIDI access and wire the inputs. Idempotent — safe to
   * call from a "Try again" button after a denial. Resolves whether
   * access succeeds or not; check `status` afterward.
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
        this._wireInputs();
      };
      this._refreshDevices();
      this._wireInputs();
      this._status = 'connected';
      this._error = null;
      this._fire();
    } catch (err) {
      this._error = err;
      this._status = err && err.name === 'SecurityError' ? 'denied' : 'error';
      this._fire();
      console.warn('MIDI access failed:', err);
    }
  }

  _refreshDevices() {
    if (!this._access) return;
    const devs = [];
    for (const input of this._access.inputs.values()) {
      devs.push({
        id: input.id,
        name: input.name || 'Unknown',
        manufacturer: input.manufacturer || '',
        state: input.state, // 'connected' | 'disconnected'
      });
    }
    this._devices = devs;
    this._recomputeBlocked();
    this._fire();
  }

  _wireInputs() {
    if (!this._access) return;
    for (const input of this._access.inputs.values()) {
      // Re-assigning is safe; Web MIDI just overwrites the prior handler.
      input.onmidimessage = (e) => this._handleMessage(e, input.id);
    }
  }

  setActiveInput(id) {
    this._activeInputId = id || 'all';
    this._fire();
  }

  _handleMessage(event, inputId) {
    if (!this._enabled) return;
    // Feedback guard: while MIDI output is live, ignore anything arriving
    // on the bus we're sending to (matched by name). Without this, our own
    // emitted notes re-enter as input and loop — especially with input set
    // to "All inputs" and output on an IAC / loopMIDI bus.
    if (midiOutput.enabled && this._blockedInputIds.has(inputId)) return;
    if (this._activeInputId !== 'all' && inputId !== this._activeInputId) return;

    const data = event.data;
    if (!data || data.length < 2) return;

    const command  = data[0] & 0xf0;
    const note     = data[1];
    const value    = data.length >= 3 ? data[2] : 0;

    if (command === NOTE_ON && value > 0) {
      this._fireActivity('note');
      keyboardVoiceManager.noteOn(note, value / 127, { source: 'midi' });
    } else if (command === NOTE_OFF || (command === NOTE_ON && value === 0)) {
      // Some controllers send NOTE_ON with velocity 0 instead of NOTE_OFF.
      this._fireActivity('note');
      keyboardVoiceManager.noteOff(note, { source: 'midi' });
    } else if (command === CC) {
      // Channel extracted as 1-indexed at this boundary — the rest of
      // the app stores channels the way the UI displays them.
      const channel = (data[0] & 0x0f) + 1;
      this._fireActivity('cc');
      // Opt-in raw-byte log for diagnosing controller weirdness.
      // Toggle with `window.__midiDebug = true` in the DevTools console.
      if (typeof window !== 'undefined' && window.__midiDebug === true) {
        const bytes = Array.from(data).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' ');
        // eslint-disable-next-line no-console
        console.log(`[CC raw] bytes=[${bytes}] len=${data.length} → ch${channel} cc${note} val${value}`);
      }
      if (note === CC_SUSTAIN) {
        keyboardVoiceManager.setSustainPedal(value >= 64);
        return;
      }
      // handleCc consumes learn-arm first, then dispatches to any
      // bound targets. Returns true on either path; we don't need
      // the return value here — the upstream voice manager has no
      // generic CC behavior.
      midiCCMap.handleCc(channel, note, value);
    }
  }
}

const midiInput = new MidiInput();
export default midiInput;
