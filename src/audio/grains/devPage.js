// Driver for grains-test.html — a bench for the wasm granular engine on its
// own, before it is wired into AudioEngine.js. Deliberately isolated: the
// app's engine is ~4800 lines of graph, and a fault in there would be
// indistinguishable from a fault in the port.
//
// Not part of the app bundle (only grains-test.html references it).

import { GrainsEngine } from './GrainsEngine.js';
import { GrainsMidiInput } from './GrainsMidiInput.js';
import { GrainsParam } from './grainsParams.generated.js';
import { CELLO_GRAINS, DADUK_HORN, CELLO_HARMONIUM } from './patches.js';

const PATCHES = { cello: CELLO_GRAINS, daduk: DADUK_HORN, harmonium: CELLO_HARMONIUM };

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(msg, cls = '') {
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = msg;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

// Surface OUR failures in the page's own log, not just the console. Browser
// extensions (MetaMask and friends) can push thousands of lines of unrelated
// noise into the console and bury a real error — so anything originating in
// this app gets shown here, where nothing else is competing for the space.
// Extension frames are filtered out by source: they have no URL under /src/
// or /grains/.
const isOurs = (url) => !url || /\/src\/|\/grains\//.test(url);

window.addEventListener('error', (e) => {
  if (!isOurs(e.filename)) return;
  log(`ERROR: ${e.message}  (${e.filename?.split('/').pop()}:${e.lineno})`, 'err');
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const stack = reason?.stack ?? '';
  // A rejection has no filename; fall back to the stack, and show anything we
  // can't attribute rather than risk swallowing our own bug.
  if (stack && /chrome-extension:|moz-extension:/.test(stack)) return;
  log(`UNHANDLED: ${reason?.message ?? reason}`, 'err');
});

let ctx = null;
let grains = null;
let masterGain = null;
const held = new Map(); // noteId -> button

const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

async function boot() {
  $('boot').disabled = true;
  const patch = PATCHES[$('patch').value];

  // Every bundled sample is 48 kHz. decodeAudioData resamples to the CONTEXT
  // rate, so a 44.1 kHz context silently rewrites all the audio before the
  // engine sees it — and the offline harness, which feeds files at their
  // native rate, cannot reproduce whatever that produces. Picking the rate
  // here makes that variable explicit instead of inherited from the device.
  const requested = Number($('rate').value);
  ctx = requested ? new AudioContext({ sampleRate: requested }) : new AudioContext();
  const resampling = ctx.sampleRate !== 48000;
  log(`AudioContext @ ${ctx.sampleRate} Hz, state "${ctx.state}"` +
      (resampling ? ' — samples are 48 kHz, so they WILL be resampled' : ' — no resampling'),
      resampling ? 'warn' : '');

  masterGain = ctx.createGain();
  masterGain.gain.value = 1;
  masterGain.connect(ctx.destination);

  grains = new GrainsEngine(ctx);

  let t = performance.now();
  // init() connects the node itself and keeps the context running — the
  // worklet only receives port messages while it is being rendered, so
  // neither the handshake nor slot loading can happen on a silent graph.
  await grains.init({ destination: masterGain });
  log(`engine ready in ${(performance.now() - t).toFixed(0)} ms`);

  // Slot loading runs the pitch analysis on the audio thread (a worklet has
  // no other), so this stalls the whole graph for a moment. Nothing else is
  // playing yet on this bench, so the cost is just measured, not heard.
  log('loading patch — the audio thread stalls during analysis…');
  t = performance.now();

  // Log each slot as it STARTS as well as when it lands. Loading takes
  // seconds and freezes the audio thread; without the "start" line a slow
  // slot and a wedged one look exactly the same from here.
  const total = await (async () => {
    const t0 = performance.now();
    await grains.loadPatch(patch, (stage, i, slot, result) => {
      if (stage === 'start') {
        log(`  slot ${i} ${slot.sample}: decoding + analysing…`);
      } else {
        const secs = result.frames ? ` (${(result.frames / ctx.sampleRate).toFixed(2)}s)` : '';
        log(`  slot ${i} ${slot.sample}: root ${result.root.toFixed(2)}${secs}` +
            (result.ms != null ? `, ${result.ms.toFixed(0)} ms on the audio thread` : ''));
      }
    });
    return performance.now() - t0;
  })();

  log(`patch "${patch.name}" loaded in ${total.toFixed(0)} ms`,
      total > 500 ? 'warn' : '');

  buildKeys(patch);
  $('allOff').disabled = false;
  $('freeze').disabled = false;
  $('gain').disabled = false;
  $('midiConnect').disabled = false;
  $('patch').disabled = true;
  $('rate').disabled = true;
}

// ---- MIDI in ---------------------------------------------------------------

// Note ids from MIDI live in their own space (member channel, or 1000+note)
// and can't collide with the on-screen keys' MIDI-number ids, so both input
// paths can drive the engine at once without stealing each other's voices.
let midi = null;
let midiDotTimer = null;

function pingDot() {
  const dot = $('midiDot');
  dot.style.background = '#5b8fb4';
  clearTimeout(midiDotTimer);
  midiDotTimer = setTimeout(() => { dot.style.background = '#333'; }, 120);
}

async function connectMidi() {
  midi = new GrainsMidiInput({
    onNoteOn: (id, hz, velocity) => grains.noteOn(id, hz, Math.max(0.1, velocity)),
    onNoteOff: (id) => grains.noteOff(id),
    // The engine glides ~20 ms to a new frequency, so a drone drag on the
    // main page arrives here as a continuous slide rather than a step.
    onPitch: (id, hz) => grains.setNoteFreq(id, hz),
    onActivity: pingDot,
    onChange: renderMidiDevices,
  });

  const status = await midi.connect();
  $('midiBend').textContent = midi.bendRange;

  if (status !== 'connected') {
    const why = {
      unsupported: 'this browser has no Web MIDI (Safari) — use Chrome',
      denied: 'MIDI permission denied',
      error: 'MIDI access failed — see console',
    }[status] ?? status;
    $('midiStatus').textContent = `MIDI unavailable: ${why}`;
    $('midiStatus').className = 'err';
    return;
  }

  $('midiConnect').classList.add('on');
  $('midiConnect').textContent = 'MIDI in on';
  $('midiDevice').disabled = false;
  renderMidiDevices();
}

function renderMidiDevices() {
  if (!midi) return;
  const sel = $('midiDevice');
  const devices = midi.devices;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = `all inputs (${devices.length})`;
  sel.appendChild(all);
  for (const d of devices) {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = d.name;
    sel.appendChild(opt);
  }
  sel.value = midi.activeInputId;

  const names = devices.map((d) => d.name).join(', ') || 'none';
  const hasBus = devices.some((d) => /IAC|loopMIDI|virtual/i.test(d.name));
  $('midiStatus').textContent = `inputs: ${names}`;
  $('midiStatus').className = hasBus || devices.length ? '' : 'warn';
  if (!devices.length) {
    $('midiStatus').textContent =
      'no MIDI inputs. For app → bench, enable a virtual bus ' +
      '(macOS: Audio MIDI Setup → MIDI Studio → IAC Driver → "Device is online").';
  }
}

function buildKeys(patch) {
  const keys = $('keys');
  keys.innerHTML = '';
  // Two octaves around the patch's own root span, so morph crossovers get
  // crossed rather than sitting inside one slot.
  const roots = patch.slots.map((s) => s.rootNote).sort((a, b) => a - b);
  const lo = Math.round(roots[0]);
  const hi = Math.round(roots[roots.length - 1]) + 12;

  for (let midi = lo; midi <= hi; midi += 1) {
    const btn = document.createElement('button');
    btn.textContent = midi;
    btn.title = `${hz(midi).toFixed(1)} Hz`;
    btn.onclick = () => toggle(midi, btn);
    keys.appendChild(btn);
  }
}

function toggle(midi, btn) {
  if (held.has(midi)) {
    grains.noteOff(midi);
    held.delete(midi);
    btn.classList.remove('on');
    return;
  }
  grains.noteOn(midi, hz(midi), 0.8);
  // Spread held notes across the field so the pan path is exercised.
  grains.setNotePan(midi, held.size === 0 ? 0 : (held.size % 2 ? -0.6 : 0.6));
  held.set(midi, btn);
  btn.classList.add('on');
}

$('boot').onclick = () => boot().catch(async (err) => {
  log(`FAILED: ${err.message}`, 'err');
  console.error(err);
  // Let the user change the rate and try again without a reload — a wedged
  // audio thread cannot be revived, so tear the whole context down first.
  try { await ctx?.close(); } catch { /* already dead */ }
  ctx = null;
  grains = null;
  $('boot').disabled = false;
  $('patch').disabled = false;
  $('rate').disabled = false;
  log('context closed — pick a different rate and boot again', 'warn');
});

$('allOff').onclick = () => {
  grains.allNotesOff();
  held.forEach((btn) => btn.classList.remove('on'));
  held.clear();
  // Drop our record of MIDI-held notes too, or a later note-off for one of
  // them would be swallowed as "already released".
  midi?.releaseAll();
};

$('midiConnect').onclick = () => connectMidi().catch((err) => {
  log(`MIDI failed: ${err.message}`, 'err');
  console.error(err);
});

$('midiDevice').onchange = (e) => midi?.setActiveInput(e.target.value);

$('freeze').onclick = (e) => {
  const on = !e.target.classList.contains('on');
  e.target.classList.toggle('on', on);
  if (on) {
    log('allocating freeze rings (tens of MB, on the audio thread)…', 'warn');
    grains.enableFreeze(6);
  } else {
    grains.disableFreeze();
  }
};

$('gain').oninput = (e) => {
  grains?.setParam(GrainsParam.MasterGain, Number(e.target.value));
};

setInterval(() => {
  if (!grains?.ready) return;
  const s = grains.stats;
  $('sVoices').textContent = s.activeVoices ?? 0;
  $('sFrozen').textContent = s.frozenVoices ?? 0;
  $('sState').textContent = ctx?.state ?? '—';
  if (s.load != null) {
    $('sLoad').textContent = `${(s.load * 100).toFixed(1)}%`;
    $('loadBar').style.width = `${Math.min(100, s.load * 100)}%`;
  }
}, 200);
