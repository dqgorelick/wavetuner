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
    this._listeners = new Set();

    MidiInput.instance = this;
  }

  get status() { return this._status; }
  get devices() { return this._devices.slice(); }
  get activeInputId() { return this._activeInputId; }
  get error() { return this._error; }

  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _fire() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('MidiInput listener error', e); }
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
    if (this._activeInputId !== 'all' && inputId !== this._activeInputId) return;

    const data = event.data;
    if (!data || data.length < 2) return;

    const command  = data[0] & 0xf0;
    const note     = data[1];
    const value    = data.length >= 3 ? data[2] : 0;

    if (command === NOTE_ON && value > 0) {
      keyboardVoiceManager.noteOn(note, value / 127);
    } else if (command === NOTE_OFF || (command === NOTE_ON && value === 0)) {
      // Some controllers send NOTE_ON with velocity 0 instead of NOTE_OFF.
      keyboardVoiceManager.noteOff(note);
    } else if (command === CC && note === CC_SUSTAIN) {
      keyboardVoiceManager.setSustainPedal(value >= 64);
    }
  }
}

const midiInput = new MidiInput();
export default midiInput;
