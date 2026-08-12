// MPE-aware Web MIDI receiver for the grains bench.
//
// Deliberately NOT the app's MidiInput singleton: that one is channel-blind
// (notes only, no pitch bend) and hard-wired to keyboardVoiceManager, which
// would drag the whole app graph into the bench. This one exists to receive
// what the app's MidiOutput actually SENDS — full MPE — so that dragging a
// drone on the main page moves a grain voice continuously here.
//
// The scheme it decodes (see MidiOutput.js / MpeVoiceAllocator.js):
//   - MIDI channel 1 (byte 0) is the master channel.
//   - Channels 2..16 are member channels; each sounding note owns one.
//   - Per-note pitch bend is 14-bit around 8192, scaled to ±bendRange
//     semitones (default 48 — Vital's fixed MPE range).
//   - The sender emits bend BEFORE and AFTER each note-on, so the pitch is
//     already correct when the note starts. We therefore never need to delay
//     a note-on waiting for its bend.
//
// Voice identity: the member CHANNEL is the note id, mirroring how MPE
// assigns one channel per voice — and matching how iOS keys grain voices by
// drone oscillator index. Notes arriving on the master channel (a plain
// non-MPE controller) fall back to keying by note number.
//
// Not handled: channel pressure and CC74 timbre. The engine supports both
// (PressureDepth / TimbreDepth) but the C facade exposes no per-note
// pressure setter, so there is nowhere to route them yet.

const NOTE_OFF = 0x80;
const NOTE_ON = 0x90;
const PITCH_BEND = 0xe0;

const BEND_CENTER = 8192;
const DEFAULT_BEND_RANGE = 48;

/** Non-MPE notes key by note number; offset so they can't collide with channel ids. */
const MASTER_ID_BASE = 1000;

export class GrainsMidiInput {
  #access = null;
  #status = 'idle'; // idle | connecting | connected | unsupported | denied | error
  #devices = [];
  #activeInputId = 'all';
  #handlers;
  #bendRange = DEFAULT_BEND_RANGE;

  /** 14-bit bend per channel index 0..15. */
  #bend = new Uint16Array(16).fill(BEND_CENTER);
  /** channel -> note number currently sounding on it (MPE: at most one). */
  #liveNote = new Map();
  /** voiceId -> note number, for the master-channel fallback path. */
  #masterNotes = new Map();

  /**
   * @param {{ onNoteOn(id,hz,velocity), onNoteOff(id), onPitch(id,hz),
   *           onChange?(), onActivity?() }} handlers
   */
  constructor(handlers) {
    this.#handlers = handlers;
    // Same origin as the main app, so its saved bend range is readable here.
    // Reading it means the two pages agree without the user setting it twice
    // — a mismatch would scale every bend wrong and look like "pitch is stuck".
    try {
      const saved = parseInt(localStorage.getItem('midiOutBendRange'), 10);
      if (Number.isInteger(saved) && saved >= 1 && saved <= 96) this.#bendRange = saved;
    } catch { /* private mode — keep the default */ }
  }

  get status() { return this.#status; }
  get devices() { return this.#devices.slice(); }
  get activeInputId() { return this.#activeInputId; }
  get bendRange() { return this.#bendRange; }

  setBendRange(semitones) {
    this.#bendRange = Math.max(1, Math.min(96, Math.round(semitones)));
  }

  setActiveInput(id) { this.#activeInputId = id || 'all'; }

  async connect() {
    if (this.#status === 'connected' || this.#status === 'connecting') return this.#status;
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      // Safari has no Web MIDI at all.
      this.#status = 'unsupported';
      this.#handlers.onChange?.();
      return this.#status;
    }

    this.#status = 'connecting';
    this.#handlers.onChange?.();
    try {
      this.#access = await navigator.requestMIDIAccess({ sysex: false });
      this.#access.onstatechange = () => { this.#refresh(); this.#wire(); };
      this.#refresh();
      this.#wire();
      this.#status = 'connected';
    } catch (err) {
      this.#status = err?.name === 'SecurityError' ? 'denied' : 'error';
      console.warn('grains MIDI access failed:', err);
    }
    this.#handlers.onChange?.();
    return this.#status;
  }

  #refresh() {
    const devs = [];
    for (const input of this.#access.inputs.values()) {
      devs.push({ id: input.id, name: input.name || 'Unknown', state: input.state });
    }
    this.#devices = devs;
    this.#handlers.onChange?.();
  }

  #wire() {
    for (const input of this.#access.inputs.values()) {
      input.onmidimessage = (e) => this.#handle(e.data, input.id);
    }
  }

  #hz(note, channel) {
    const semis = ((this.#bend[channel] - BEND_CENTER) / BEND_CENTER) * this.#bendRange;
    return 440 * Math.pow(2, (note + semis - 69) / 12);
  }

  #handle(data, inputId) {
    if (!data || data.length < 2) return;
    if (this.#activeInputId !== 'all' && inputId !== this.#activeInputId) return;

    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    const d1 = data[1];
    const d2 = data.length >= 3 ? data[2] : 0;

    const isMaster = channel === 0;
    const idFor = (note) => (isMaster ? MASTER_ID_BASE + note : channel);

    if (status === PITCH_BEND) {
      this.#bend[channel] = (d2 << 7) | d1;
      // Re-pitch whatever this channel is currently sounding. On a member
      // channel that's the one MPE voice; on the master channel a plain
      // controller means "bend everything", so all its notes move.
      if (isMaster) {
        for (const [id, note] of this.#masterNotes) {
          this.#handlers.onPitch(id, this.#hz(note, channel));
        }
      } else {
        const note = this.#liveNote.get(channel);
        if (note != null) this.#handlers.onPitch(channel, this.#hz(note, channel));
      }
      return;
    }

    // Plenty of controllers send note-on with velocity 0 to mean note-off.
    const isNoteOn = status === NOTE_ON && d2 > 0;
    const isNoteOff = status === NOTE_OFF || (status === NOTE_ON && d2 === 0);

    if (isNoteOn) {
      const id = idFor(d1);
      if (isMaster) this.#masterNotes.set(id, d1);
      else this.#liveNote.set(channel, d1);
      this.#handlers.onNoteOn(id, this.#hz(d1, channel), d2 / 127);
      this.#handlers.onActivity?.();
    } else if (isNoteOff) {
      const id = idFor(d1);
      // A member channel gets reused for the next voice; only clear it if
      // this note-off is for the note actually sounding there. Otherwise a
      // stale note-off from a previous voice would silence the new one.
      if (isMaster) this.#masterNotes.delete(id);
      else if (this.#liveNote.get(channel) === d1) this.#liveNote.delete(channel);
      else return;
      this.#handlers.onNoteOff(id);
      this.#handlers.onActivity?.();
    }
  }

  /** Release everything we believe is sounding — for panic / disconnect. */
  releaseAll() {
    for (const channel of this.#liveNote.keys()) this.#handlers.onNoteOff(channel);
    for (const id of this.#masterNotes.keys()) this.#handlers.onNoteOff(id);
    this.#liveNote.clear();
    this.#masterNotes.clear();
    this.#bend.fill(BEND_CENTER);
  }
}
