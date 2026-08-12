// Main-thread facade for the wasm granular engine — the web counterpart of
// iOS's GranularEngine.swift. Owns the worklet node, sample loading and the
// patch application, and exposes the same note API the rest of the audio
// layer already speaks (noteOn/noteOff/setNote*).
//
// The wasm Module is compiled here, on the main thread, and passed to the
// worklet: WebAssembly.Module is structured-cloneable, and worklet scope has
// no `fetch` to load bytes with. Compiling here also keeps the (async, tens of
// ms) compile off the audio thread entirely.

import { applyPatchParams } from './applyPatch.js';
import { GrainsParam } from './grainsParams.generated.js';
import { DEFAULT_GRAINS_PATCH } from './patches.js';

const WORKLET_URL = `${import.meta.env.BASE_URL}grains/grains-worklet.js`;
const WASM_URL = `${import.meta.env.BASE_URL}grains/grains-engine.wasm`;
const SAMPLE_URL = (name) => `${import.meta.env.BASE_URL}grains/samples/${name}.wav`;

/** Generous: covers a cold wasm instantiate on a slow machine, but still fails. */
const READY_TIMEOUT_MS = 8000;

/**
 * Per-slot ceiling. Offline, the pitch-mark analysis of a 3-6 s sample costs
 * roughly 1-2 s; wasm in a worklet should be the same order. 20 s is well
 * past "slow" and firmly into "wedged".
 */
const SLOT_TIMEOUT_MS = 20000;

export class GrainsEngine {
  #ctx;
  #node = null;
  #ready = false;
  #pendingReady = null;
  #stats = { activeVoices: 0, frozenVoices: 0, load: null };
  #patch = null;
  #freezeRingsRequested = false;
  #readyTimer = null;
  #sawConstructed = false;
  #sawRendering = false;
  #slotStarts = new Map();
  #lastStatsAt = 0;

  constructor(audioContext) {
    this.#ctx = audioContext;
  }

  get node() { return this.#node; }
  get ready() { return this.#ready; }
  get stats() { return this.#stats; }
  get patch() { return this.#patch; }

  /**
   * Load the worklet + wasm and bring up a silent, connected-nowhere node.
   * Caller connects `node` into the graph.
   */
  async init({ destination } = {}) {
    await this.#ctx.audioWorklet.addModule(WORKLET_URL);

    // Fetch BYTES, not a compiled Module — the worklet compiles them itself.
    // See the note in grains-worklet.js: a WebAssembly.Module does not
    // reliably structured-clone into an AudioWorkletGlobalScope, and when the
    // clone fails to arrive it is indistinguishable from a hung worklet.
    const response = await fetch(WASM_URL);
    if (!response.ok) throw new Error(`grains: cannot fetch ${WASM_URL} (${response.status})`);
    const bytes = await response.arrayBuffer();

    this.#node = new AudioWorkletNode(this.#ctx, 'grains-engine', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });

    this.#node.port.onmessage = (e) => this.#onMessage(e.data);

    // A processor that throws in its constructor, or throws once inside
    // process(), is silently removed from the graph by the browser — no
    // exception reaches us, the node simply goes dead. This is the only way
    // to hear about it.
    this.#node.onprocessorerror = (e) => {
      const detail = e?.message ? `: ${e.message}` : '';
      const err = new Error(`grains worklet processor error${detail}`);
      clearTimeout(this.#readyTimer);
      this.#pendingReady?.reject(err);
      this.#pendingReady = null;
      console.error(err, e);
    };

    // ⚠️ CONNECT BEFORE HANDSHAKING, and keep the context running.
    //
    // An AudioWorkletProcessor receives port messages only while it is being
    // RENDERED — delivery is tied to the render quantum. A node connected to
    // nothing is never pulled by the graph, and a suspended context never
    // renders at all; in either case 'init' sits in the queue forever and
    // this await never settles. That is a deadlock, not an error, so nothing
    // is thrown and nothing is logged — which is exactly how it presented.
    //
    // Same reason `loadSlot` can't be done under ctx.suspend(): the reply
    // would never come back. The audio-thread stall during loading has to be
    // lived with instead (see README "Known differences").
    this.#node.connect(destination ?? this.#ctx.destination);
    if (this.#ctx.state === 'suspended') await this.#ctx.resume();

    const ready = new Promise((resolve, reject) => {
      this.#pendingReady = { resolve, reject };
      // Belt and braces: if delivery is broken again for some other reason,
      // fail loudly instead of hanging forever with a blank log.
      this.#readyTimer = setTimeout(() => {
        // Report the last stage actually reached — each one implicates a
        // different layer, and without this they all look identical.
        const stage = !this.#sawConstructed
          ? 'the processor never even constructed (worklet module loaded but ' +
            'GrainsProcessor did not start — check the bundle)'
          : !this.#sawRendering
            ? 'the processor constructed but is never RENDERED, so no port ' +
              'message can reach it (the graph is not pulling this node)'
            : 'the processor is constructed AND rendering, but init produced ' +
              'no reply (the wasm instantiate is failing silently)';
        reject(new Error(
          `worklet never replied to init — ${stage}. ` +
          `ctx.state="${this.#ctx.state}"`,
        ));
      }, READY_TIMEOUT_MS);
    });
    this.#node.port.postMessage({ type: 'init', bytes }, [bytes]);
    await ready;
    return this.#node;
  }

  #onMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        clearTimeout(this.#readyTimer);
        this.#ready = true;
        this.#pendingReady?.resolve(msg);
        this.#pendingReady = null;
        break;
      case 'error':
        clearTimeout(this.#readyTimer);
        this.#pendingReady?.reject(new Error(msg.message));
        this.#pendingReady = null;
        console.error('GrainsEngine:', msg.message);
        break;
      case 'constructed':
        this.#sawConstructed = true;
        break;
      case 'rendering':
        this.#sawRendering = true;
        break;
      case 'slotStart':
        this.#slotStarts.set(msg.slot, msg.frames);
        break;
      case 'stats':
        // Timestamped: stats arriving means the processor is still rendering.
        // If they STOP, the audio thread is wedged or the processor is dead —
        // which tells us which side a stalled load is stuck on.
        this.#lastStatsAt = performance.now();
        this.#stats = msg;
        break;
      case 'slotLoaded':
        this.#slotWaiters.get(msg.slot)?.resolve(msg);
        this.#slotWaiters.delete(msg.slot);
        break;
      case 'slotError':
        this.#slotWaiters.get(msg.slot)?.reject(
          new Error(`slot ${msg.slot}: ${msg.message}`),
        );
        this.#slotWaiters.delete(msg.slot);
        break;
      case 'freezeRingsReady':
        this.#freezeRingsRequested = true;
        break;
      default:
        break;
    }
  }

  #slotWaiters = new Map();

  /**
   * Fetch, decode and install one sample slot.
   *
   * ⚠️ The analysis + soundfile rebuild happen on the AUDIO THREAD (a worklet
   * has no other), and cost hundreds of ms per slot. Call this before audio is
   * audible — at startup, or with the context suspended — never mid-performance.
   */
  async loadSlot(slot, sampleName, rootNote = -1) {
    const response = await fetch(SAMPLE_URL(sampleName));
    if (!response.ok) throw new Error(`grains: cannot fetch sample ${sampleName}`);
    const decoded = await this.#ctx.decodeAudioData(await response.arrayBuffer());

    // The engine takes mono; downmix here rather than shipping two channels
    // across the port and throwing one away on the audio thread.
    const frames = decoded.length;
    const mono = new Float32Array(frames);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const data = decoded.getChannelData(c);
      for (let i = 0; i < frames; i++) mono[i] += data[i];
    }
    if (decoded.numberOfChannels > 1) {
      for (let i = 0; i < frames; i++) mono[i] /= decoded.numberOfChannels;
    }

    // Snapshot these BEFORE the transfer: postMessage detaches mono.buffer,
    // and a detached TypedArray reports length 0 — a timeout closure reading
    // mono.length later would report "0.0s of audio" for every sample.
    const frameCount = mono.length;
    const rate = decoded.sampleRate;

    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#slotWaiters.delete(slot);
        const arrived = this.#slotStarts.has(slot);
        const statsAge = this.#lastStatsAt ? performance.now() - this.#lastStatsAt : Infinity;
        const alive = statsAge < 2000;
        const where = !arrived
          ? 'the worklet NEVER RECEIVED the message'
          : alive
            ? 'the worklet received it and is still rendering, so the wasm load call itself never returned'
            : `the worklet received it and then STOPPED RENDERING (no stats for ${
                Number.isFinite(statsAge) ? Math.round(statsAge) + ' ms' : 'ever'
              }) — the audio thread is wedged inside the load`;
        reject(new Error(
          `slot ${slot} (${sampleName}) never replied after ${SLOT_TIMEOUT_MS} ms — ` +
          `${(frameCount / rate).toFixed(2)}s of audio at ${rate} Hz. ${where}.`,
        ));
      }, SLOT_TIMEOUT_MS);
      this.#slotWaiters.set(slot, {
        resolve: (msg) => { clearTimeout(timer); resolve(msg); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });

    this.#node.port.postMessage(
      { type: 'loadSlot', slot, mono, sampleRate: decoded.sampleRate, rootNote },
      [mono.buffer],
    );
    return done;
  }

  /**
   * Load every slot of a patch and apply its shared params.
   *
   * `onProgress(stage, index, slot, result?)` fires around each slot — this
   * work takes seconds and blocks the audio thread, so a caller with no
   * per-slot feedback cannot tell "loading" from "hung". Learned the hard way.
   */
  async loadPatch(patch = DEFAULT_GRAINS_PATCH, onProgress = () => {}) {
    const results = [];
    for (const [i, slot] of patch.slots.entries()) {
      onProgress('start', i, slot);
      const result = await this.loadSlot(i, slot.sample, slot.rootNote);
      onProgress('done', i, slot, result);
      results.push(result);
    }
    applyPatchParams((id, value) => this.setParam(id, value), patch);
    this.#patch = patch;
    return results;
  }

  setParam(id, value) {
    this.#node?.port.postMessage({ type: 'param', id, value });
  }

  noteOn(id, freqHz, gain = 1) {
    this.#node?.port.postMessage({ type: 'noteOn', id, freqHz, gain });
  }

  noteOff(id) { this.#node?.port.postMessage({ type: 'noteOff', id }); }
  setNoteFreq(id, hz) { this.#node?.port.postMessage({ type: 'noteFreq', id, value: hz }); }
  setNoteGain(id, g) { this.#node?.port.postMessage({ type: 'noteGain', id, value: g }); }
  setNotePan(id, pan) { this.#node?.port.postMessage({ type: 'notePan', id, value: pan }); }
  setNoteDetune(id, hz) { this.#node?.port.postMessage({ type: 'noteDetune', id, value: hz }); }
  allNotesOff() { this.#node?.port.postMessage({ type: 'allNotesOff' }); }

  /**
   * Allocate the freeze capture rings — tens of MB, so it happens on first
   * use rather than at startup (same policy as iOS).
   */
  enableFreeze(maxLoopSeconds) {
    if (!this.#freezeRingsRequested) {
      this.#node?.port.postMessage({ type: 'freezeRings' });
      this.#freezeRingsRequested = true;
    }
    if (typeof maxLoopSeconds === 'number') {
      this.setParam(GrainsParam.FreezeMaxLoop, maxLoopSeconds);
    }
    this.setParam(GrainsParam.Freeze, 1);
  }

  disableFreeze() { this.setParam(GrainsParam.Freeze, 0); }

  destroy() {
    this.allNotesOff();
    this.#node?.disconnect();
    this.#node = null;
    this.#ready = false;
  }
}
