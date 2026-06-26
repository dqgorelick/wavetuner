/**
 * MpeVoiceAllocator — single source of truth for outgoing MPE voices.
 *
 * The core problem: on the MIDI wire a voice is identified by the pair
 * (channel, note number), and a Note Off must carry the same note number
 * as its Note On. The MPE spec says two notes with the SAME note number on
 * DIFFERENT member channels are two independent voices — but real receivers
 * (Ableton → Vital, most synth voice pools) de-dupe by resolved note number
 * even across channels, so two requests for the same pitch collapse into a
 * single sounding voice. That's the "play the same note twice, hear one
 * note" bug.
 *
 * We sidestep it completely: every ACTIVE OUTPUT voice is guaranteed a
 * unique channel AND a unique note number, then pitch-bent onto its true
 * target frequency. Because the member bend range is ±48 semitones, we can
 * anchor a voice on any note within a few semitones of the target and bend
 * the rest of the way — so N voices at the *same* frequency just get N
 * distinct anchor notes spread around it, each bent back onto the one Hz.
 * They sound identical; the receiver sees N distinct identities and never
 * merges them.
 *
 * Input collisions are fine and expected: a drone, a held key, and an
 * incoming MIDI note can all ask for the same Hz. Those are three separate
 * requests with distinct ids; the allocator is what turns them into three
 * distinct (channel, note) pairs. None of that reconciliation touches the
 * wire — it's all in-app state, resolved before a byte is sent.
 *
 * This class owns the member channels and reconciles a flat list of voice
 * requests each frame:
 *   1. release voices whose request vanished (gone / muted / released),
 *   2. update held voices' pitch bend + pressure (re-anchor if a sweep runs
 *      past the bend window),
 *   3. allocate new voices — unique channel (round-robin) + unique note
 *      near the target — highest priority first,
 *   4. steal a strictly-lower-priority voice when every channel is busy
 *      (so e.g. a played key can borrow a drone's channel, but two voices
 *      of equal priority never fight over a channel frame-to-frame, which
 *      would click).
 *
 * It knows nothing about drones vs. keyboard vs. MIDI-in — callers describe
 * each desired voice as { id, freq, level, velocity, priority } and the
 * allocator does the rest. Senders are injected so this stays testable and
 * decoupled from the Web MIDI port.
 */

const BEND_CENTER = 8192;       // 14-bit pitch-bend center
const A4 = 440;

function freqToMidi(f) {
  return 69 + 12 * Math.log2(Math.max(1e-6, f) / A4);
}

function clampNote(n) {
  return Math.max(0, Math.min(127, Math.round(n)));
}

// 14-bit bend placing `freq` at `anchorNote` semitones offset over a
// ±bendRange window, clamped to the legal 0..16383 range.
function bendValue(freq, anchorNote, bendRange) {
  const semis = freqToMidi(freq) - anchorNote;
  const v = BEND_CENTER + Math.round((semis / bendRange) * BEND_CENTER);
  return Math.max(0, Math.min(16383, v));
}

function levelToPressure(level) {
  return Math.max(0, Math.min(127, Math.round((level || 0) * 127)));
}

export default class MpeVoiceAllocator {
  /**
   * @param {object}   opts
   * @param {number[]} opts.memberChannels - usable member channel indices
   *        (e.g. [1..15] for the MPE lower zone; index 0 is the master ch).
   * @param {number}   opts.bendRange - per-note bend range in ± semitones.
   * @param {object}   opts.send - raw senders:
   *        { noteOn(ch,note,vel), noteOff(ch,note), pitchBend(ch,v14), pressure(ch,val) }
   * @param {function} [opts.log] - optional debug logger (msg) => void.
   */
  constructor({ memberChannels, bendRange, send, log }) {
    this._channels = memberChannels.slice();
    this._bendRange = bendRange;
    this._send = send;
    this._log = log || (() => {});

    // id → { id, ch, note, lastBend, lastPressure, priority, seq }
    this._voices = new Map();
    this._usedChannels = new Set();   // channels currently sounding a voice
    this._usedNotes = new Set();      // note numbers currently in use (global)
    this._seq = 0;                    // monotonic allocation counter (age order)
    this._cursor = 0;                 // round-robin channel cursor
  }

  get size() { return this._voices.size; }
  has(id) { return this._voices.has(id); }
  setBendRange(n) { this._bendRange = n; }

  /** Note-off every tracked voice and drop all bookkeeping. */
  releaseAll() {
    for (const v of this._voices.values()) this._send.noteOff(v.ch, v.note);
    this._voices.clear();
    this._usedChannels.clear();
    this._usedNotes.clear();
  }

  /**
   * Reconcile the live set of desired voices against what's currently
   * sounding. Each request: { id, freq, level (0..1), velocity (1..127),
   * priority }. Emits only the messages needed to bring the wire in line.
   */
  reconcile(requests) {
    const byId = new Map();
    for (const r of requests) byId.set(r.id, r);

    // 1. Release voices whose request vanished (gone / muted / released).
    for (const [id, v] of this._voices) {
      if (!byId.has(id)) this._release(id, v);
    }

    // 2. Update held voices; collect genuinely new ones.
    const fresh = [];
    for (const r of requests) {
      const v = this._voices.get(r.id);
      if (v) this._update(r, v);
      else fresh.push(r);
    }

    // 3. Allocate new voices, highest priority first so they win the last
    //    free channels (and can steal) when the pool is tight.
    fresh.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const r of fresh) this._allocate(r);
  }

  _release(id, v) {
    this._send.noteOff(v.ch, v.note);
    this._usedChannels.delete(v.ch);
    this._usedNotes.delete(v.note);
    this._voices.delete(id);
  }

  _allocate(r) {
    let ch = this._takeChannel();
    if (ch == null) {
      // Pool full — steal a strictly-lower-priority voice, if any. Equal
      // priority is never stolen, so a sustained overload parks the excess
      // voice silently instead of clicking it on and off every frame.
      const victim = this._findVictim(r.priority || 0);
      if (!victim) return;
      this._release(victim.id, victim);
      ch = this._takeChannel();
      if (ch == null) return;
    }
    const note = this._takeNote(r.freq);
    const bend = bendValue(r.freq, note, this._bendRange);
    const vel = Math.max(1, Math.min(127, Math.round(r.velocity || 100)));
    const pressure = levelToPressure(r.level);
    // Bend before Note On, then again after — some synths (Vital) ignore a
    // bend that arrives before the note exists, leaving the voice glued to
    // the bare anchor note. The second send pins the true pitch.
    this._send.pitchBend(ch, bend);
    this._send.noteOn(ch, note, vel);
    this._send.pitchBend(ch, bend);
    this._send.pressure(ch, pressure);
    this._usedChannels.add(ch);
    this._usedNotes.add(note);
    this._voices.set(r.id, {
      id: r.id, ch, note, lastBend: bend, lastPressure: pressure,
      priority: r.priority || 0, seq: this._seq++,
    });
    this._log(`noteOn ch${ch + 1} note${note} bend${bend} (${r.id} ${r.freq.toFixed(2)}Hz)`);
  }

  _update(r, v) {
    const semis = freqToMidi(r.freq) - v.note;
    if (Math.abs(semis) > this._bendRange) {
      // Swept past the ±bendRange window — re-anchor on a fresh unique note
      // (brief retrigger). Free the old note first so the picker may reuse
      // a nearby value if appropriate.
      this._send.noteOff(v.ch, v.note);
      this._usedNotes.delete(v.note);
      const note = this._takeNote(r.freq);
      const bend = bendValue(r.freq, note, this._bendRange);
      const pressure = levelToPressure(r.level);
      this._send.pitchBend(v.ch, bend);
      this._send.noteOn(v.ch, note, Math.max(1, Math.min(127, Math.round(r.velocity || 100))));
      this._send.pitchBend(v.ch, bend);
      this._send.pressure(v.ch, pressure);
      this._usedNotes.add(note);
      v.note = note; v.lastBend = bend; v.lastPressure = pressure;
      this._log(`re-anchor ch${v.ch + 1} note${note} bend${bend} (${r.id} ${r.freq.toFixed(2)}Hz)`);
      return;
    }
    const bend = bendValue(r.freq, v.note, this._bendRange);
    if (bend !== v.lastBend) { this._send.pitchBend(v.ch, bend); v.lastBend = bend; }
    const pressure = levelToPressure(r.level);
    if (pressure !== v.lastPressure) { this._send.pressure(v.ch, pressure); v.lastPressure = pressure; }
  }

  /** Round-robin: next free member channel, or null if all occupied. */
  _takeChannel() {
    const n = this._channels.length;
    for (let i = 0; i < n; i++) {
      const ch = this._channels[(this._cursor + i) % n];
      if (!this._usedChannels.has(ch)) {
        this._cursor = (this._cursor + i + 1) % n;
        return ch;
      }
    }
    return null;
  }

  /**
   * Unique note number nearest `freq`, spiralling outward (0, +1, -1, +2,
   * -2, …) so same-frequency voices fan out symmetrically around the
   * target. Skips notes already in use and any candidate the bend can't
   * reach. With ≤15 voices the inner fallback is effectively never hit.
   */
  _takeNote(freq) {
    const exact = freqToMidi(freq);
    const nearest = clampNote(exact);
    for (let offset = 0; offset <= 127; offset++) {
      const cands = offset === 0 ? [nearest] : [nearest + offset, nearest - offset];
      for (const cand of cands) {
        if (cand < 0 || cand > 127) continue;
        if (this._usedNotes.has(cand)) continue;
        if (Math.abs(exact - cand) > this._bendRange) continue;
        return cand;
      }
    }
    for (let n = 0; n <= 127; n++) if (!this._usedNotes.has(n)) return n;
    return nearest;
  }

  /**
   * Steal target: the lowest-priority, then oldest, voice STRICTLY below
   * `priority`. Equal/higher-priority voices are never stolen — so a played
   * key (higher priority) can borrow a drone's channel, but drones never
   * evict each other frame-to-frame at overload. Returns null if nothing is
   * stealable, in which case the new voice is simply dropped this frame.
   */
  _findVictim(priority) {
    let victim = null;
    for (const v of this._voices.values()) {
      if (v.priority >= priority) continue;
      if (!victim ||
          v.priority < victim.priority ||
          (v.priority === victim.priority && v.seq < victim.seq)) {
        victim = v;
      }
    }
    return victim;
  }
}
