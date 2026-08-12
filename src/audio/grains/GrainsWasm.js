// Thin, environment-free wrapper around the grains wasm exports.
//
// Deliberately knows nothing about AudioWorklets, fetch, or Node: it takes an
// already-compiled WebAssembly.Module and gives back a typed facade. That is
// what lets the offline probe and the worklet exercise the SAME binding code —
// the only thing they do differently is how the bytes arrive.
//
// ⚠️ Heap views: the module is built with ALLOW_MEMORY_GROWTH, so any call
// that can allocate (prepare, loadSlot, prepareFreezeRings) may detach every
// existing TypedArray view of the heap. `#refresh()` re-wraps after growth;
// never cache a view across such a call.

import { GRAINS_PARAM_COUNT } from './grainsParams.generated.js';

export class GrainsWasm {
  #exports;
  #engine;
  #heapF32;
  #buffer;

  /**
   * @param {WebAssembly.Module} module compiled grains-engine.wasm
   */
  constructor(module) {
    const instance = new WebAssembly.Instance(module, {
      env: {
        // The only import the standalone build has. We re-wrap views lazily
        // instead, so there is nothing to do here.
        emscripten_notify_memory_growth: () => {},
      },
    });
    this.#exports = instance.exports;

    // Reactor-style module: static constructors run here, not at instantiate.
    this.#exports._initialize?.();

    const count = this.#exports.grains_param_count();
    if (count !== GRAINS_PARAM_COUNT) {
      throw new Error(
        `grains: param table drift — wasm reports ${count}, ` +
          `grainsParams.generated.js has ${GRAINS_PARAM_COUNT}. ` +
          `Re-run native/grains/build.sh.`,
      );
    }

    this.#engine = this.#exports.grains_create();
    this.#refresh();
  }

  get numSlots() { return this.#exports.grains_num_slots(); }
  get numVoices() { return this.#exports.grains_num_voices(); }

  #refresh() {
    const buf = this.#exports.memory.buffer;
    if (buf !== this.#buffer) {
      this.#buffer = buf;
      this.#heapF32 = new Float32Array(buf);
    }
  }

  prepare(sampleRate, maxFrames) {
    this.#exports.grains_prepare(this.#engine, sampleRate, maxFrames);
    this.#refresh();
    // Cache the scratch offsets — the POINTERS are stable across heap growth
    // even though the views are not.
    this.#outL = this.#exports.grains_out_left(this.#engine) >> 2;
    this.#outR = this.#exports.grains_out_right(this.#engine) >> 2;
  }

  #outL = 0;
  #outR = 0;

  /**
   * Copy a mono Float32Array into the wasm heap and hand it to the slot.
   * Returns the effective root note (-1 = unvoiced, previous root kept).
   */
  loadSlot(slot, mono, sampleRate, rootNote = -1) {
    const ptr = this.#exports.grains_alloc(mono.length);
    if (!ptr) throw new Error('grains: out of wasm memory loading a slot');
    try {
      this.#refresh(); // grains_alloc may have grown the heap
      this.#heapF32.set(mono, ptr >> 2);
      const root = this.#exports.grains_load_slot(
        this.#engine, slot, ptr, mono.length, sampleRate, rootNote,
      );
      this.#refresh(); // the soundfile build allocates too
      return root;
    } finally {
      this.#exports.grains_free(ptr);
    }
  }

  setParam(id, value) { this.#exports.grains_set_param(this.#engine, id, value); }
  getParam(id) { return this.#exports.grains_get_param(this.#engine, id); }

  prepareFreezeRings() {
    this.#exports.grains_prepare_freeze_rings(this.#engine);
    this.#refresh(); // tens of MB — this is the call most likely to grow
  }

  noteOn(id, freqHz, gain) { this.#exports.grains_note_on(this.#engine, id, freqHz, gain); }
  noteOff(id) { this.#exports.grains_note_off(this.#engine, id); }
  setNoteFreq(id, hz) { this.#exports.grains_set_note_freq(this.#engine, id, hz); }
  setNoteGain(id, g) { this.#exports.grains_set_note_gain(this.#engine, id, g); }
  setNotePan(id, pan) { this.#exports.grains_set_note_pan(this.#engine, id, pan); }
  setNoteDetune(id, hz) { this.#exports.grains_set_note_detune(this.#engine, id, hz); }
  allNotesOff() { this.#exports.grains_all_notes_off(this.#engine); }

  /**
   * Render `frames` and copy into the caller's channel arrays. No allocation,
   * no growth — safe to call every block.
   */
  render(left, right, frames) {
    this.#exports.grains_render(this.#engine, frames);
    const heap = this.#heapF32;
    const l = this.#outL;
    const r = this.#outR;
    for (let i = 0; i < frames; i++) {
      left[i] = heap[l + i];
      right[i] = heap[r + i];
    }
  }

  get activeVoices() { return this.#exports.grains_active_voices(this.#engine); }
  get frozenVoices() { return this.#exports.grains_frozen_voices(this.#engine); }
  drainAudioSeconds() { return this.#exports.grains_drain_audio_seconds(this.#engine); }

  destroy() {
    this.#exports.grains_destroy(this.#engine);
    this.#engine = 0;
  }
}
