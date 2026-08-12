// AudioWorkletProcessor host for the wasm grains engine.
//
// Bundled to public/grains/grains-worklet.js by native/grains/build.sh
// (esbuild) — addModule() needs one self-contained file, and bundling is what
// lets this share GrainsWasm.js with the offline probe instead of keeping a
// second copy of the binding in sync by hand.
//
// Protocol (all main → worklet unless noted):
//   { type: 'init', module }        compiled WebAssembly.Module; replies 'ready'
//   { type: 'loadSlot', slot, mono, sampleRate, rootNote }   replies 'slotLoaded'
//   { type: 'param', id, value }
//   { type: 'noteOn' | 'noteOff' | 'noteFreq' | 'noteGain' | 'notePan' | 'noteDetune',
//     id, value }
//   { type: 'allNotesOff' }
//   { type: 'freezeRings' }         allocate the capture rings (tens of MB)
//   worklet → main: { type: 'stats', activeVoices, frozenVoices, load }
//
// ⚠️ loadSlot runs the pitch-mark analysis and rebuilds the soundfile ON THE
// AUDIO THREAD — a worklet has no other thread to offer. It costs hundreds of
// ms per slot, which is a hard dropout for the WHOLE graph, not just this
// node. The host must therefore load slots while the context is suspended or
// silent. See README "Known differences" for the fix that avoids this
// (analyse in a Worker, ship the maps in).

import { GrainsWasm } from './GrainsWasm.js';

const RENDER_QUANTUM = 128;
const STATS_INTERVAL_BLOCKS = 64; // ~186 ms at 44.1 kHz

class GrainsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.blocksSinceStats = 0;
    this.renderMs = 0;
    this.announcedRendering = false;

    // Liveness beacons. A worklet that fails to construct, or that is never
    // rendered, is otherwise indistinguishable from one that ignored a
    // message — all three present as "no reply". These two let the host say
    // which it was instead of guessing.
    this.port.postMessage({ type: 'constructed' });
    // `performance` is not in the AudioWorkletGlobalScope spec; Chrome ships
    // it, others may not. Without it we simply report no load figure rather
    // than pretending to measure one.
    this.clock = typeof performance !== 'undefined' && performance.now
      ? () => performance.now()
      : null;

    this.port.onmessage = (event) => this.#handle(event.data);
  }

  #handle(msg) {
    if (!msg) return;

    if (msg.type === 'init') {
      try {
        // Bytes, not a pre-compiled Module: WebAssembly.Module structured
        // cloning into an AudioWorkletGlobalScope is not dependable across
        // engines, and a clone that silently fails to arrive looks exactly
        // like a worklet that hung. An ArrayBuffer always transfers. The
        // synchronous compile costs ~10-30 ms of one render quantum at boot,
        // which is a glitch nobody is around to hear yet.
        const module = msg.module ?? new WebAssembly.Module(msg.bytes);
        this.engine = new GrainsWasm(module);
        this.engine.prepare(sampleRate, RENDER_QUANTUM);
        this.port.postMessage({
          type: 'ready',
          numSlots: this.engine.numSlots,
          numVoices: this.engine.numVoices,
          sampleRate,
        });
      } catch (err) {
        this.port.postMessage({ type: 'error', message: String(err && err.message || err) });
      }
      return;
    }

    const e = this.engine;
    if (!e) return;

    switch (msg.type) {
      case 'loadSlot': {
        // Must not throw past here: an exception inside a port handler does
        // not reach onprocessorerror, so an unreported failure would leave the
        // host awaiting a reply that can never arrive.
        // Beacon on ARRIVAL, before any work. Separates "the message never
        // got here" from "the wasm call never came back" — from the host side
        // those are the same silence.
        this.port.postMessage({
          type: 'slotStart', slot: msg.slot, frames: msg.mono?.length ?? 0,
        });
        const t0 = this.clock ? this.clock() : 0;
        try {
          const root = e.loadSlot(msg.slot, msg.mono, msg.sampleRate, msg.rootNote ?? -1);
          this.port.postMessage({
            type: 'slotLoaded',
            slot: msg.slot,
            root,
            frames: msg.mono?.length ?? 0,
            ms: this.clock ? this.clock() - t0 : null,
          });
        } catch (err) {
          this.port.postMessage({
            type: 'slotError',
            slot: msg.slot,
            message: String(err?.message ?? err),
          });
        }
        break;
      }
      case 'param':       e.setParam(msg.id, msg.value); break;
      case 'noteOn':      e.noteOn(msg.id, msg.freqHz, msg.gain); break;
      case 'noteOff':     e.noteOff(msg.id); break;
      case 'noteFreq':    e.setNoteFreq(msg.id, msg.value); break;
      case 'noteGain':    e.setNoteGain(msg.id, msg.value); break;
      case 'notePan':     e.setNotePan(msg.id, msg.value); break;
      case 'noteDetune':  e.setNoteDetune(msg.id, msg.value); break;
      case 'allNotesOff': e.allNotesOff(); break;
      case 'freezeRings': {
        e.prepareFreezeRings();
        this.port.postMessage({ type: 'freezeRingsReady' });
        break;
      }
      default: break;
    }
  }

  process(_inputs, outputs) {
    if (!this.announcedRendering) {
      this.announcedRendering = true;
      this.port.postMessage({ type: 'rendering' });
    }

    const out = outputs[0];
    if (!out || out.length === 0) return true;

    const left = out[0];
    const right = out.length > 1 ? out[1] : out[0];

    if (!this.engine) {
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }

    const t0 = this.clock ? this.clock() : 0;
    this.engine.render(left, right, left.length);
    if (this.clock) this.renderMs += this.clock() - t0;

    if (++this.blocksSinceStats >= STATS_INTERVAL_BLOCKS) {
      const audioMs = (this.blocksSinceStats * left.length * 1000) / sampleRate;
      this.port.postMessage({
        type: 'stats',
        activeVoices: this.engine.activeVoices,
        frozenVoices: this.engine.frozenVoices,
        // Fraction of the available audio time this node consumed.
        load: this.clock ? this.renderMs / audioMs : null,
      });
      this.blocksSinceStats = 0;
      this.renderMs = 0;
    }

    return true; // keep the node alive; silence is the engine's business
  }
}

registerProcessor('grains-engine', GrainsProcessor);
