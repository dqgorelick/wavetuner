/**
 * GenerativeConductor — a ONE-SHOT generative transition engine (GENERATIVE.md,
 * transition phase). No scheduler loop: transition() performs a single
 * generative journey into a save state, then stops. The generative sibling of
 * GO (launchAll = instant deterministic recall). Destination: the USER-staged
 * slot when one is staged with distance to travel (plan → shuffle → execute);
 * otherwise the conductor AUTO-SELECTS — a random save other than the one the
 * voices currently sit on (any save if they're on none), drawn ONLY from the
 * slots the capture bar displays (first slot per numeral I–V). Stored slots
 * beyond those — stale saves from old sessions, slots carried in by a loaded
 * patch — are invisible in the UI and must never become targets.
 *
 * The flow is plan → (shuffle…) → execute:
 *   - plan()/shuffle() rolls the dice ONCE and returns a concrete, inspectable
 *     PLAN: per voice a departure time (spread + order heuristic + jitter), a
 *     mode (glide | step, weighted by stepProbability), and a glide duration
 *     (glideMsMin..Max interpolated by pitch distance — far notes travel
 *     longer, via launchVoice's per-voice durMs). The panel renders the plan
 *     as the debug visualizer; shuffle re-rolls to preview other outcomes.
 *   - transition() executes EXACTLY the previewed plan (no re-roll): one
 *     setTimeout per departure, driving launchVoice/stepVoice. Steps use the
 *     tuning menu's own step time (stepOverlapMs) — no knob here.
 *   - halt() cancels not-yet-departed voices; in-flight glides finish.
 *
 * Order heuristics (log2 pitch space): 'same-direction' clusters voices by
 * sign(Δ) — rising notes leave together, falling notes together ("two
 * ascending notes transition together"); 'far-first'/'near-first' order by
 * |Δ|; 'low-high' by target pitch; 'random'. Muted voices are never moved.
 *
 * VOICE LEADING (§6.6): when the save carries a mute mask (and on/off is in
 * the recall scope), the plan matches the SOUNDING notes to the save's
 * sounding notes via matchVoices() — possibly across slot indices. Extra
 * move modes: 'travel' (a note glisses to another slot's pitch, then that
 * slot adopts its oscillator nodes — phase-continuous), 'bloom' (a new note
 * splits out of a neighbour and glides home), 'merge' (a vanishing note
 * glides into a neighbour and releases there), 'fade-in'/'fade-out' (plain
 * note-on/off). ruleGlissProb gates travel-matching per plan, ruleBloomProb
 * gates bloom/merge vs fades; connectClosest picks how far-fetched the
 * matching is; maxGlissOct demotes over-long travels to fades.
 *
 * A staged-slot change invalidates/replans the preview (never mid-execution);
 * knob changes replan too, so the plan always reflects the sliders. Every
 * event lands in a ring-buffer debug log (getLog). The recall curve is forced
 * to ease-in-out for the duration of a transition, then restored.
 *
 * Singleton, mirroring FrequencyManager's export pattern.
 */

import audioEngine from './AudioEngine';
import frequencyManager from './FrequencyManager';
import keyboardVoiceManager from './KeyboardVoiceManager';
import { matchVoices } from './voiceLeading';

const STORAGE_KEY = 'generativeConfig';

// Δ (in octaves) at/below this is treated as "already there" — no move.
const DELTA_EPS = 1e-3;

// Pitch tolerance for matching live held voices to a save's held notes
// (mirrors FrequencyManager's NOTE_MATCH_EPS).
const NOTE_EPS = 5e-3;

// Normalization ceiling for |Δ| → 0..1 (one octave of jump = full "distance").
const MAX_JUMP_OCTAVES = 1.0;

// Display/track length of a step on the plan timeline (the step itself is
// near-instant; envelope timing lives in the engine).
const STEP_DISPLAY_MS = 400;

// Cap on the decision debug log (ring buffer, newest last).
const LOG_LIMIT = 40;

// The capture bar's five fixed slot names — keep in sync with CaptureBar's
// NUMERALS. Only the first stored slot per numeral is visible/clickable there,
// and auto-select confines itself to exactly those (see _visibleSlots).
const CAPTURE_NUMERALS = ['I', 'II', 'III', 'IV', 'V'];

// Base departure orderings. Direction-grouping used to live here as
// 'same-direction'; it's now the first RULE (below) — a per-plan coin that,
// when it fires, overrides whichever base order is selected.
const ORDER_OPTIONS = [
  { id: 'far-first', label: 'far first' },
  { id: 'near-first', label: 'near first' },
  { id: 'low-high', label: 'low→high' },
  { id: 'random', label: 'random' },
];

// Live-tunable knobs; the panel iterates this schema. 'order' renders as a
// radio row, 'range' as a two-thumb min/max slider (near notes get the low
// end, far notes the high end), the rest as plain sliders. Entries with
// section:'rules' are musical heuristics (NL_RULES.md) — each slider is the
// PROBABILITY the rule applies to a given plan, rolled once per plan();
// which rules fired is recorded on the plan for the panel.
const CONFIG_SCHEMA = [
  { key: 'spreadMs', label: 'Spread (ms)', min: 0, max: 10000, step: 50 },
  { key: 'order', label: 'Order', type: 'enum', options: ORDER_OPTIONS },
  { key: 'jitter', label: 'Jitter (±)', min: 0, max: 1, step: 0.01 },
  { key: 'stepProbability', label: 'Step probability', min: 0, max: 1, step: 0.01 },
  { key: 'glideRange', label: 'Glide (ms)', type: 'range', loKey: 'glideMsMin', hiKey: 'glideMsMax', min: 0, max: 10000, step: 50 },
  { key: 'stepRange', label: 'Step time (ms)', type: 'range', loKey: 'stepMsMin', hiKey: 'stepMsMax', min: 0, max: 10000, step: 50 },
  // Voice-leading character (§6.6). connectClosest picks a percentile into
  // the cost-ranked voice matchings: 0 = every note slides to its nearest
  // neighbour (no crossings), 1 = maximal travel (voices leapfrog).
  // maxGlissOct is the leash — a matched pair further apart than this is
  // demoted to a fade-out + fade-in (a 2½-octave portamento reads as a
  // stunt, not voice leading).
  { key: 'connectClosest', label: 'connect closest ↔ furthest', min: 0, max: 1, step: 0.01 },
  { key: 'maxGlissOct', label: 'max gliss (octaves)', min: 0.1, max: 3, step: 0.05 },
  { key: 'ruleDirProb', label: 'group ↑ / ↓ together', min: 0, max: 1, step: 0.01, section: 'rules' },
  // Chance the save's mute-mask delta is performed as VOICE LEADING —
  // sounding notes gliss across slots to become the target chord's notes —
  // instead of plain per-slot fades.
  { key: 'ruleGlissProb', label: 'glissando note changes', min: 0, max: 1, step: 0.01, section: 'rules' },
  // Chance entrances BLOOM (split audibly out of a neighbour and glide
  // home) and exits MERGE (glide into a neighbour and die there) instead of
  // fading in/out in place.
  { key: 'ruleBloomProb', label: 'bloom / merge', min: 0, max: 1, step: 0.01, section: 'rules' },
];

const DEFAULT_CONFIG = {
  spreadMs: 2000,
  order: 'random',
  jitter: 0.35,
  stepProbability: 0.25,
  glideMsMin: 1500,
  glideMsMax: 6000,
  stepMsMin: 0,
  stepMsMax: 1000,
  connectClosest: 0,
  maxGlissOct: 2,
  // Rules — chance each applies per plan. Direction grouping defaults to
  // ALWAYS, matching the old order:'same-direction' default.
  ruleDirProb: 1,
  ruleGlissProb: 1,
  ruleBloomProb: 1,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

class GenerativeConductor {
  constructor() {
    if (GenerativeConductor.instance) return GenerativeConductor.instance;

    this._listeners = new Set();
    this._config = { ...DEFAULT_CONFIG, ...GenerativeConductor._loadConfig() };
    // Migration: 'same-direction' left the order enum when it became the
    // ruleDirProb rule (defaults to 1, so the old behavior is preserved).
    if (this._config.order === 'same-direction') this._config.order = 'random';

    this._plan = null;             // current preview / running / finished plan
    this._moveTimers = [];         // pending departure setTimeouts
    this._doneTimer = null;        // completion check
    this._savedRecallCurve = null; // user's curve, restored after a transition

    // Debug log — one entry per event, newest last. The panel renders it.
    this._debugLog = [];
    this._logSeq = 0;
    this._planSeq = 0;

    // Staging is the user's "pick the next state" gesture: replan the preview
    // whenever the staged slot changes (never disturb a running plan).
    frequencyManager.onChange(() => this._syncToStaged());

    GenerativeConductor.instance = this;
  }

  // ─── Config persistence ──────────────────────────────────────────────
  static _loadConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch { /* ignore */ }
    return {};
  }

  _persistConfig() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this._config)); } catch { /* ignore */ }
  }

  // ─── Public state / config API ───────────────────────────────────────
  get running() { return this._plan?.state === 'running'; }

  getConfigSchema() { return CONFIG_SCHEMA.map((s) => ({ ...s })); }

  getConfig() { return { ...this._config }; }

  setConfigValue(key, value) {
    // Range specs own TWO config keys (loKey/hiKey) — resolve either.
    const spec = CONFIG_SCHEMA.find((s) => s.key === key
      || (s.type === 'range' && (s.loKey === key || s.hiKey === key)));
    if (!spec || (spec.key === key && spec.type === 'range')) return;
    let next;
    if (spec.type === 'enum') {
      if (!spec.options.some((o) => o.id === value)) return;
      next = value;
    } else {
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      next = clamp(n, spec.min, spec.max);
      if (spec.type === 'range') {
        // The two thumbs may never cross.
        if (key === spec.loKey) next = Math.min(next, this._config[spec.hiKey]);
        else next = Math.max(next, this._config[spec.loKey]);
      }
    }
    if (next === this._config[key]) return;
    this._config[key] = next;
    this._persistConfig();
    // The preview should always reflect the sliders — replan (keeps the same
    // dice where possible? no: a replan is a fresh roll; acceptable while
    // tuning, shuffle exists anyway). Never disturb a running plan.
    if (this._plan && this._plan.state === 'preview') this.plan();
    this._fire();
  }

  // ─── Planning ────────────────────────────────────────────────────────
  // Roll the dice once: compute a concrete plan from the voices' CURRENT
  // positions to the STAGED save state. Returns the plan (also kept as the
  // preview) or null when there's nothing to transition to.
  plan() {
    if (!audioEngine.initialized) return null;
    const slotId = frequencyManager.stagedSlotId;
    const slot = slotId != null
      ? frequencyManager.getSlots().find((s) => s.id === slotId)
      : null;
    const targets = frequencyManager.getStagedFrequencies();
    if (!slot || !targets) {
      this._plan = null;
      this._fire();
      return null;
    }

    const cur = audioEngine.getAllFrequencies();
    const count = Math.min(cur.length, targets.length);
    // Mute mask of the target save — null when on/off isn't in the recall
    // scope or the save predates mute capture. With a mask, the plan is
    // VOICE-LED: audible notes are matched to the save's audible notes
    // (possibly across slots); without one, the legacy per-slot plan.
    const targetMutes = frequencyManager.getStagedMutes();

    const rulesFired = [];
    const movers = [];    // same-slot audible movers (glide/step roll)
    const travels = [];   // cross-slot voices: {i: from, to, d, fromHz, toHz}
    const extras = [];    // entrances/exits: mode pre-decided (bloom/merge/fades)
    const heldMoves = []; // keyboard/MIDI pool (HELD_NOTES.md §5), modes n-*
    const silent = [];
    const skipped = [];

    // Rule coins roll ONCE per plan and cover both pools, so drones and
    // held notes phrase the same way within one transition.
    const glissRoll = Math.random() < this._config.ruleGlissProb;
    const bloomRoll = Math.random() < this._config.ruleBloomProb;

    if (targetMutes) {
      const sources = [];
      const targetsAud = [];
      for (let i = 0; i < count; i++) {
        if (!audioEngine.isMuted(i) && cur[i] > 0) sources.push({ i, hz: cur[i] });
        if (targets[i] > 0 && !targetMutes[i]) targetsAud.push({ i, hz: targets[i] });
      }
      const glissOn = sources.length > 0 && targetsAud.length > 0 && glissRoll;
      const bloomOn = bloomRoll;

      let match;
      if (glissOn) {
        match = matchVoices(sources, targetsAud, {
          connect: this._config.connectClosest,
          maxTravelOct: this._config.maxGlissOct,
        });
      } else {
        // Identity matching: only same-slot notes connect; every mute-mask
        // difference becomes a plain fade.
        const sset = new Set(sources.map((s) => s.i));
        const tset = new Set(targetsAud.map((t) => t.i));
        match = {
          pairs: sources.filter((s) => tset.has(s.i)).map((s) => ({
            from: s.i, to: s.i, fromHz: s.hz, toHz: targets[s.i], d: Math.log2(targets[s.i] / s.hz),
          })),
          entrances: targetsAud.filter((t) => !sset.has(t.i)).map((t) => ({
            to: t.i, toHz: t.hz, bloomFrom: null, bloomFromHz: null,
          })),
          exits: sources.filter((s) => !tset.has(s.i)).map((s) => ({
            from: s.i, fromHz: s.hz, mergeInto: null, mergeIntoHz: null,
          })),
        };
      }
      if (glissOn && match.pairs.some((p) => p.from !== p.to)) rulesFired.push('⇝ voices led');
      if (bloomOn && (match.entrances.length > 0 || match.exits.length > 0)) rulesFired.push('✿ bloom/merge');

      for (const p of match.pairs) {
        if (p.from === p.to && Math.abs(p.d) <= DELTA_EPS) { skipped.push({ i: p.from, reason: 'arrived' }); continue; }
        if (p.from === p.to) movers.push({ i: p.from, d: p.d, fromHz: p.fromHz, toHz: p.toHz });
        else travels.push({ i: p.from, to: p.to, d: p.d, fromHz: p.fromHz, toHz: p.toHz });
      }
      for (const e of match.entrances) {
        if (bloomOn && e.bloomFromHz != null) {
          extras.push({ i: e.to, mode: 'bloom', fromHz: e.bloomFromHz, toHz: e.toHz, d: Math.log2(e.toHz / e.bloomFromHz) });
        } else {
          extras.push({ i: e.to, mode: 'fade-in', fromHz: e.toHz, toHz: e.toHz, d: 0 });
        }
      }
      for (const x of match.exits) {
        if (bloomOn && x.mergeIntoHz != null) {
          extras.push({ i: x.from, mode: 'merge', fromHz: x.fromHz, toHz: x.mergeIntoHz, d: Math.log2(x.mergeIntoHz / x.fromHz) });
        } else {
          extras.push({ i: x.from, mode: 'fade-out', fromHz: x.fromHz, toHz: x.fromHz, d: 0 });
        }
      }

      // Everyone else settles silently: muted slots that aren't a travel
      // destination or entrance still retune to the save so a later unmute
      // never surfaces a stray pitch. (Travel destinations get their pitch
      // from the landing; entrances retune inside fadeIn/bloom.)
      const handled = new Set();
      for (const t of travels) handled.add(t.to);
      for (const e of extras) { if (e.mode === 'bloom' || e.mode === 'fade-in') handled.add(e.i); }
      for (let i = 0; i < count; i++) {
        if (handled.has(i) || !audioEngine.isMuted(i)) continue;
        if (!(targets[i] > 0) || !(cur[i] > 0)) { skipped.push({ i, reason: 'no-target' }); continue; }
        const d = Math.log2(targets[i] / cur[i]);
        if (Math.abs(d) <= DELTA_EPS) continue;
        silent.push({
          i, fromHz: cur[i], toHz: targets[i], cents: Math.round(1200 * d),
          mode: 'silent', departMs: 0, durMs: null, stepMs: null,
        });
      }
    } else {
      // Legacy plan (no mute mask): per-slot frequency moves only.
      for (let i = 0; i < count; i++) {
        if (!(targets[i] > 0) || !(cur[i] > 0)) { skipped.push({ i, reason: 'no-target' }); continue; }
        const d = Math.log2(targets[i] / cur[i]);
        if (Math.abs(d) <= DELTA_EPS) { skipped.push({ i, reason: 'arrived' }); continue; }
        // A muted voice retunes SILENTLY (free) — moving it keeps every voice on
        // the save's frequencies, so a later unmute never surfaces a stray pitch.
        if (audioEngine.isMuted(i)) {
          silent.push({
            i, fromHz: cur[i], toHz: targets[i], cents: Math.round(1200 * d),
            mode: 'silent', departMs: 0, durMs: null, stepMs: null,
          });
          continue;
        }
        movers.push({ i, d, fromHz: cur[i], toHz: targets[i] });
      }
    }
    // Voices beyond the save's length have nowhere to go — surface them.
    for (let i = count; i < cur.length; i++) skipped.push({ i, reason: 'no-target' });

    // ── Held keyboard/MIDI pool (HELD_NOTES.md §5) ────────────────────
    // Matched separately from the drones (cross-pool travel = a timbre
    // morph, deferred) but with the same fader/leash/rules, and its moves
    // join the same ordering/spread below so both pools phrase together.
    // Null stagedNotes = 'notes' untracked or an old save → pool untouched.
    const stagedNotes = frequencyManager.getStagedNotes();
    const heldLive = stagedNotes ? keyboardVoiceManager.getHeldNotesLive() : [];
    if (stagedNotes) {
      const nSources = heldLive.map((v) => ({ i: v.id, hz: v.hz }));
      const nTargets = stagedNotes
        .map((n, k) => ({ i: k, hz: n.hz }))
        .filter((t) => t.hz > 0);
      // Gliss off → identity matching by pitch: a tiny leash demotes every
      // real move to a fade pair while exact matches stay put.
      const match = matchVoices(nSources, nTargets, {
        connect: glissRoll ? this._config.connectClosest : 0,
        maxTravelOct: glissRoll ? this._config.maxGlissOct : NOTE_EPS,
      });
      for (const p of match.pairs) {
        if (Math.abs(p.d) <= NOTE_EPS) continue;           // already there
        heldMoves.push({
          kind: 'held', mode: 'n-glide', i: `n${p.from}`, vid: p.from,
          note: stagedNotes[p.to], fromHz: p.fromHz, toHz: p.toHz, d: p.d,
        });
      }
      for (const e of match.entrances) {
        const note = stagedNotes[e.to];
        if (bloomRoll && e.bloomFromHz != null) {
          heldMoves.push({
            kind: 'held', mode: 'n-bloom', i: `nk${e.to}`, note,
            fromHz: e.bloomFromHz, toHz: e.toHz, d: Math.log2(e.toHz / e.bloomFromHz),
          });
        } else {
          heldMoves.push({
            kind: 'held', mode: 'n-fade-in', i: `nk${e.to}`, note,
            fromHz: e.toHz, toHz: e.toHz, d: 0,
          });
        }
      }
      for (const x of match.exits) {
        if (bloomRoll && x.mergeIntoHz != null) {
          heldMoves.push({
            kind: 'held', mode: 'n-merge', i: `n${x.from}`, vid: x.from,
            fromHz: x.fromHz, toHz: x.mergeIntoHz, d: Math.log2(x.mergeIntoHz / x.fromHz),
          });
        } else {
          heldMoves.push({
            kind: 'held', mode: 'n-fade-out', i: `n${x.from}`, vid: x.from,
            fromHz: x.fromHz, toHz: x.fromHz, d: 0,
          });
        }
      }
      if (glissRoll && heldMoves.some((m) => m.mode === 'n-glide')
          && !rulesFired.includes('⇝ voices led')) rulesFired.push('⇝ voices led');
      if (bloomRoll && heldMoves.some((m) => m.mode === 'n-bloom' || m.mode === 'n-merge')
          && !rulesFired.includes('✿ bloom/merge')) rulesFired.push('✿ bloom/merge');
    }

    const { spreadMs, jitter } = this._config;
    // Rules — one coin per rule per plan; fired rules override the base
    // knobs for this plan and are recorded on it (panel shows them).
    let order = this._config.order;
    const audible = [
      ...movers.map((m) => ({ ...m, kind: 'mover' })),
      ...travels.map((m) => ({ ...m, kind: 'travel' })),
      ...extras.map((m) => ({ ...m, kind: 'extra' })),
      ...heldMoves,
    ];
    if (audible.length > 1 && Math.random() < this._config.ruleDirProb) {
      order = 'same-direction';
      rulesFired.push('↑↓ grouped');
    }
    const ordered = this._orderMovers(audible, order);

    // Departure times: even slots across the spread (or two clusters for
    // same-direction), humanized by ± jitter of a slot's width.
    const n = ordered.length;
    const moves = ordered.map((m, k) => {
      let base;
      let slotWidth;
      if (order === 'same-direction') {
        // Cluster k carries a group tag from _orderMovers: group 0 departs at
        // 0, group 1 at the far end of the spread — rising and falling leave
        // as two gestures.
        base = m.group === 0 ? 0 : spreadMs;
        slotWidth = spreadMs / 4;
      } else {
        slotWidth = n > 1 ? spreadMs / (n - 1) : 0;
        base = k * slotWidth;
      }
      const departMs = Math.round(clamp(base + jitter * slotWidth * (Math.random() * 2 - 1), 0, spreadMs));
      // Both time ranges map pitch distance the same way: near notes get the
      // low end, far notes the high end (glide = travel time, step = overlap).
      const norm = clamp(Math.abs(m.d) / MAX_JUMP_OCTAVES, 0, 1);
      const glideDur = () => Math.round(lerp(this._config.glideMsMin, this._config.glideMsMax, norm));
      let mode;
      let durMs = null;
      let stepMs = null;
      if (m.kind === 'travel') {
        // Travels always glide — the cross-slot slide IS the gesture.
        mode = 'travel';
        durMs = glideDur();
      } else if (m.kind === 'extra') {
        mode = m.mode;
        if (mode === 'bloom' || mode === 'merge') durMs = glideDur();
      } else if (m.kind === 'held') {
        mode = m.mode;
        if (mode === 'n-glide' || mode === 'n-bloom' || mode === 'n-merge') durMs = glideDur();
      } else {
        mode = Math.random() < this._config.stepProbability ? 'step' : 'glide';
        if (mode === 'glide') durMs = glideDur();
        else stepMs = Math.round(lerp(this._config.stepMsMin, this._config.stepMsMax, norm));
      }
      return {
        i: m.i,
        to: m.kind === 'travel' ? m.to : undefined,
        held: m.kind === 'held' || undefined,
        vid: m.vid,
        note: m.note,
        fromHz: m.fromHz,
        toHz: m.toHz,
        cents: Math.round(1200 * m.d),
        mode,
        departMs,
        durMs,
        stepMs,
      };
    });

    // Cause before effect when one slot appears in two moves: an entrance
    // into a slot waits for that slot's own voice to leave, and a traveller
    // heading to a slot that itself departs must set off after it does (its
    // landing then can't collide with the resident voice).
    const vacatesAt = new Map();
    for (const mv of moves) {
      if (mv.mode === 'travel' || mv.mode === 'merge' || mv.mode === 'fade-out') vacatesAt.set(mv.i, mv.departMs);
    }
    for (const mv of moves) {
      if ((mv.mode === 'bloom' || mv.mode === 'fade-in') && vacatesAt.has(mv.i)) {
        mv.departMs = Math.max(mv.departMs, vacatesAt.get(mv.i) + 80);
      }
      if (mv.mode === 'travel' && vacatesAt.has(mv.to)) {
        mv.departMs = Math.max(mv.departMs, vacatesAt.get(mv.to) + 40);
      }
    }
    const allMoves = moves.concat(silent).sort((a, b) =>
      a.departMs - b.departMs || String(a.i).localeCompare(String(b.i)));

    this._planSeq += 1;
    this._plan = {
      seq: this._planSeq,
      slotId,
      slotName: slot.name,
      moves: allMoves,
      skipped,
      rules: rulesFired,
      // Mute mask at plan time — a toggle since the roll changes who's
      // audible, which invalidates the matching (see _planIsStale).
      muteSig: audioEngine.getAllMutedStates().slice(0, count),
      // Held-chord signature at plan time (null when the pool isn't in
      // play) — playing/releasing a note invalidates the note matching.
      heldSig: stagedNotes
        ? heldLive.map((v) => `${v.id}:${v.hz.toFixed(2)}`).sort().join(',')
        : null,
      totalMs: allMoves.reduce(
        (m, mv) => Math.max(m, mv.departMs + (mv.durMs ?? Math.max(mv.stepMs ?? 0, STEP_DISPLAY_MS))),
        0
      ),
      state: 'preview',
      startedAt: null,
    };
    this._fire();
    return this._plan;
  }

  // Shuffle = an explicit re-roll of the same inputs, to preview a different
  // outcome. (Alias kept separate for the log/UI.)
  shuffle() {
    const p = this.plan();
    if (p) this._logEvent(`⚂ shuffle #${p.seq} → "${p.slotName}" · ${p.moves.length} move${p.moves.length === 1 ? '' : 's'}`);
    return p;
  }

  _orderMovers(movers, order) {
    const byAbs = (a, b) => Math.abs(b.d) - Math.abs(a.d);
    switch (order) {
      case 'far-first': return [...movers].sort(byAbs);
      case 'near-first': return [...movers].sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
      case 'low-high': return [...movers].sort((a, b) => a.toHz - b.toHz);
      case 'random': {
        const a = [...movers];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      }
      case 'same-direction':
      default: {
        // The ↑↓-grouping rule's ordering (no longer a base order option —
        // plan() passes it when ruleDirProb fires). Two clusters: rising and
        // falling. The more salient one (larger max|Δ|) leads; each mover is
        // tagged with its cluster for departure timing. DIRECTIONLESS moves
        // (fade-in/fade-out note changes, Δ = 0) belong to neither cluster —
        // they ride with the leading gesture rather than being dropped
        // (dropping them emptied every plan when the gliss rule was off and
        // the saves differed by mutes alone).
        const rising = movers.filter((m) => m.d > 0).sort(byAbs);
        const falling = movers.filter((m) => m.d < 0).sort(byAbs);
        const still = movers.filter((m) => !(m.d > 0) && !(m.d < 0));
        const maxAbs = (arr) => arr.reduce((m, e) => Math.max(m, Math.abs(e.d)), 0);
        const [first, second] = maxAbs(rising) >= maxAbs(falling) ? [rising, falling] : [falling, rising];
        return [
          ...first.map((m) => ({ ...m, group: 0 })),
          ...still.map((m) => ({ ...m, group: 0 })),
          ...second.map((m) => ({ ...m, group: 1 })),
        ];
      }
    }
  }

  // ─── Execution ───────────────────────────────────────────────────────
  // Run EXACTLY the previewed plan for the staged slot — the user's choice
  // always wins. If none is valid (nothing staged / stale), plan first. Only
  // when there's genuinely nowhere to go (nothing staged, or the staged state
  // is already reached) AUTO-SELECT the next state: a random visible save the
  // voices aren't already on. One press therefore always transitions — toward
  // the user's pick when they made one, wandering the saves when they didn't.
  transition() {
    if (this.running) return false;
    if (!audioEngine.initialized) return false;
    let p = this._plan;
    if (!p || p.state !== 'preview' || p.slotId !== frequencyManager.stagedSlotId) p = this.plan();
    // Spectrum-bar orb drags mutate the engine directly (no manager onChange),
    // so a preview can be stale: a voice skipped as "arrived" may have been
    // dragged off since, and would be left off-save. Re-roll from live
    // positions so EVERY voice ends on the save state's frequencies.
    if (p && this._planIsStale(p)) {
      this._logEvent('↻ plan stale (orbs moved) — re-rolled');
      p = this.plan();
    }
    if (!p || p.moves.length === 0) p = this._autoSelectAndPlan();
    if (!p) return false;
    if (p.moves.length === 0) {
      this._logEvent(`nothing to move → "${p.slotName}" (all arrived/muted)`);
      this._fire();
      return false;
    }

    // Generative slides read as EASED regardless of the user's manual recall
    // curve; saved here, restored when the transition ends.
    this._savedRecallCurve = frequencyManager.recallCurve;
    frequencyManager.setRecallCurve('ease-in-out');

    // ONE undo point for the whole transition (every move below runs noUndo).
    // Without this, staggered launches/steps push mixed mid-transition chords
    // onto the undo stack — pressing ⟲ later "restores" states on no save.
    frequencyManager.pushUndoPoint();

    p.state = 'running';
    p.startedAt = Date.now();
    const dirUp = p.moves.filter((m) => m.cents > 0).length;
    this._logEvent(
      `▶ transition #${p.seq} → "${p.slotName}" · ${p.moves.length} moves (${dirUp}↑ ${p.moves.length - dirUp}↓) · spread ${(this._config.spreadMs / 1000).toFixed(1)}s${p.rules?.length ? ` · rules: ${p.rules.join(', ')}` : ''}`
    );

    for (const mv of p.moves) {
      const fire = () => {
        if (this._plan !== p || p.state !== 'running') return;
        switch (mv.mode) {
          case 'silent':
            frequencyManager.stepVoice(mv.i, { overlapMs: 0, noUndo: true });
            return;
          case 'travel':
            // Muted since the roll → no voice to carry; keep the target
            // chord anyway: park the source, fade the destination in.
            if (audioEngine.isMuted(mv.i)) {
              frequencyManager.stepVoice(mv.i, { overlapMs: 0, noUndo: true });
              frequencyManager.fadeInVoice(mv.to, { noUndo: true });
              this._logEvent(`v${mv.i} muted mid-plan — travel became fade-in v${mv.to}`);
              return;
            }
            frequencyManager.travelVoice(mv.i, mv.to, { durMs: mv.durMs, noUndo: true });
            return;
          case 'bloom':
            // bloomVoice falls back to a plain launch if the slot was
            // unmuted since the roll; if the spawn itself fails, at least
            // fade the note in so the chord completes.
            if (!frequencyManager.bloomVoice(mv.i, mv.fromHz, { durMs: mv.durMs, noUndo: true })) {
              frequencyManager.fadeInVoice(mv.i, { noUndo: true });
            }
            return;
          case 'fade-in':
            // Unmuted since the roll → make sure it still lands on the save.
            if (!frequencyManager.fadeInVoice(mv.i, { noUndo: true })) {
              frequencyManager.launchVoice(mv.i, { durMs: 400, noUndo: true });
            }
            return;
          case 'merge':
            if (audioEngine.isMuted(mv.i)) {
              frequencyManager.stepVoice(mv.i, { overlapMs: 0, noUndo: true });
              return;
            }
            frequencyManager.mergeVoice(mv.i, mv.toHz, { durMs: mv.durMs, noUndo: true });
            return;
          case 'fade-out':
            // Already muted → just make sure it sits on the save silently.
            if (!frequencyManager.fadeOutVoice(mv.i, { noUndo: true })) {
              frequencyManager.stepVoice(mv.i, { overlapMs: 0, noUndo: true });
            }
            return;
          case 'n-glide':
            // Voice gone mid-plan (released/stolen) → the target note still
            // belongs to the chord: spawn it instead.
            if (!frequencyManager.glideHeldVoice(mv.vid, mv.toHz, { durMs: mv.durMs })) {
              frequencyManager.spawnHeldNote(mv.note);
              this._logEvent(`♪ voice gone mid-plan — spawned ${Math.round(mv.toHz)}Hz`);
            }
            return;
          case 'n-bloom':
            if (!frequencyManager.bloomHeldNote(mv.note, mv.fromHz, { durMs: mv.durMs })) {
              frequencyManager.spawnHeldNote(mv.note);
            }
            return;
          case 'n-fade-in':
            frequencyManager.spawnHeldNote(mv.note);
            return;
          case 'n-merge':
            // Gone already → nothing to converge; the chord doesn't need it.
            frequencyManager.glideHeldVoice(mv.vid, mv.toHz, { durMs: mv.durMs, releaseOnArrive: true });
            return;
          case 'n-fade-out':
            frequencyManager.releaseHeldVoice(mv.vid);
            return;
          default: {
            // glide / step movers. A voice muted since the roll still
            // RETUNES — silently, via a zero-overlap step — so it stays on
            // the save.
            if (audioEngine.isMuted(mv.i)) {
              frequencyManager.stepVoice(mv.i, { overlapMs: 0, noUndo: true });
              this._logEvent(`v${mv.i} muted mid-plan — retuned silently`);
              return;
            }
            if (mv.mode === 'step') frequencyManager.stepVoice(mv.i, { overlapMs: mv.stepMs, noUndo: true });
            else frequencyManager.launchVoice(mv.i, { durMs: mv.durMs, noUndo: true });
          }
        }
      };
      if (mv.departMs <= 0) fire();
      else this._moveTimers.push(setTimeout(fire, mv.departMs));
    }
    this._doneTimer = setTimeout(() => this._finish('done'), p.totalMs + 150);
    this._fire();
    return true;
  }

  // True when the plan no longer matches reality: a planned mover isn't where
  // the plan thought it starts, or a voice it skipped (arrived / muted then)
  // is audible now and off the save's target. Executing such a plan would
  // strand voices at non-save frequencies.
  _planIsStale(p) {
    const targets = frequencyManager.getStagedFrequencies();
    if (!targets) return true;
    // A mute toggled since the roll changes who's audible — the voice
    // matching itself is void, not just a position.
    if (Array.isArray(p.muteSig)) {
      const curMutes = audioEngine.getAllMutedStates();
      for (let i = 0; i < p.muteSig.length; i++) {
        if (!!curMutes[i] !== !!p.muteSig[i]) return true;
      }
    }
    // Held-pool moves have no slot position; a played/released note since
    // the roll shows up as a signature change instead.
    if (p.heldSig != null) {
      const sig = keyboardVoiceManager.getHeldNotesLive()
        .map((v) => `${v.id}:${v.hz.toFixed(2)}`).sort().join(',');
      if (sig !== p.heldSig) return true;
    }
    for (const mv of p.moves) {
      if (mv.held) continue;
      // Blooms and fade-ins start from a planned pitch, not the (muted)
      // slot's live one — no position to go stale.
      if (mv.mode === 'bloom' || mv.mode === 'fade-in') continue;
      const hz = audioEngine.getFrequency(mv.i);
      if (!(hz > 0) || Math.abs(Math.log2(hz / mv.fromHz)) > DELTA_EPS) return true;
    }
    for (const s of p.skipped) {
      if (audioEngine.isMuted(s.i)) continue;
      const t = targets[s.i];
      const hz = audioEngine.getFrequency(s.i);
      if (!(t > 0) || !(hz > 0)) continue;
      if (Math.abs(Math.log2(t / hz)) > DELTA_EPS) return true;
    }
    return false;
  }

  // Re-roll the preview if orb drags made it stale (engine writes don't fire
  // the manager's onChange, so the panel polls this while a preview is shown).
  refreshPreviewIfStale() {
    if (!audioEngine.initialized) return;
    const p = this._plan;
    if (!p || p.state !== 'preview') return;
    if (p.slotId !== frequencyManager.stagedSlotId) return;  // _syncToStaged's job
    if (this._planIsStale(p)) this.plan();
  }

  // The slots the capture bar actually DISPLAYS: the first stored slot named
  // for each Roman numeral, in numeral order (mirrors CaptureBar's byName —
  // keep in sync). getSlots() can hold more: stale saves from old sessions or
  // slots imported with a patch, invisible in the UI. Auto-select must only
  // travel to states the user can see — staging an invisible slot highlights
  // no numeral and lands the voices on a chord the user never chose. Public:
  // the panel and capture bar gate their transition UI on this too.
  getVisibleSlots() {
    const slots = frequencyManager.getSlots();
    const out = [];
    for (const n of CAPTURE_NUMERALS) {
      const s = slots.find((x) => x.name === n);
      if (s) out.push(s);
    }
    return out;
  }

  // The save the voices currently SIT ON — the slot whose frequencies match
  // every live voice within ε — or null when they're on none (dragged off,
  // never recalled, mid-somewhere). Judged from actual positions, not from
  // what's staged: staging is a pointer, this is where the sound is.
  _currentSlotId() {
    if (!audioEngine.initialized) return null;
    const cur = audioEngine.getAllFrequencies();
    for (const s of this.getVisibleSlots()) {
      const f = frequencyManager.getSlotFrequencies(s.id);
      if (!f) continue;
      const n = Math.min(cur.length, f.length);
      let compared = 0;
      let on = true;
      for (let i = 0; i < n; i++) {
        if (!(f[i] > 0) || !(cur[i] > 0)) continue;
        compared += 1;
        if (Math.abs(Math.log2(f[i] / cur[i])) > DELTA_EPS) { on = false; break; }
      }
      // Saves can differ by mute mask alone — same tuning, different chord
      // — so "sitting on" a save also means sounding its chord.
      const mutes = on ? frequencyManager.getSlotMutes(s.id) : null;
      if (mutes) {
        const nm = Math.min(cur.length, mutes.length);
        for (let i = 0; i < nm; i++) {
          if (audioEngine.isMuted(i) !== !!mutes[i]) { on = false; break; }
        }
      }
      // …and, when notes are tracked, sounding its held chord too.
      if (on && frequencyManager.getRecallScope().includes('notes')) {
        const notes = frequencyManager.getSlotHeldNotes(s.id);
        if (notes) {
          const { toSpawn, toRelease } = this._heldDiff(notes);
          if (toSpawn.length > 0 || toRelease.length > 0) on = false;
        }
      }
      // No comparable voice at all → unknowable, not a match.
      if (on && compared > 0) return s.id;
    }
    return null;
  }

  // Pick the next save state: random among the VISIBLE slots, EXCLUDING the
  // one the voices currently sit on (when they're on none, every visible save
  // is fair game). Try the shuffled candidates in order — stage each and plan
  // until a plan with moves appears (a duplicate of the current chord yields
  // no moves and is skipped). Staging is the real user gesture — the numeral
  // highlights in the capture bar just like a click.
  _autoSelectAndPlan() {
    const slots = this.getVisibleSlots();
    if (slots.length === 0) return this._plan;
    const onId = this._currentSlotId();
    const pool = slots.filter((s) => s.id !== onId);
    const order = pool.length ? pool : slots.slice();
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    for (const s of order) {
      if (!frequencyManager.stageSlot(s.id)) continue;
      const p = this.plan();
      if (p && p.moves.length > 0) {
        this._logEvent(`✦ auto-select → "${s.name}"`);
        return p;
      }
    }
    return this._plan;
  }

  // Cancel the not-yet-departed moves; whatever is already flying finishes on
  // its own (a halt should feel like a hand lifted, not a brake slam).
  halt() {
    const p = this._plan;
    if (!p || p.state !== 'running') return;
    const remaining = p.moves.filter((m) => Date.now() - p.startedAt < m.departMs).length;
    this._logEvent(`■ halt #${p.seq} (${remaining} departure${remaining === 1 ? '' : 's'} cancelled)`);
    this._finish('halted');
  }

  _finish(state) {
    // Capture the plan and flip its state FIRST: restoring the recall curve
    // below fires FrequencyManager listeners, which re-enter _syncToStaged —
    // it must not see this plan as still running (infinite halt recursion),
    // and any preview it creates must not be clobbered afterwards.
    const p = this._plan;
    if (p) p.state = state;
    for (const t of this._moveTimers) clearTimeout(t);
    this._moveTimers = [];
    if (this._doneTimer != null) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    if (this._savedRecallCurve != null) {
      const curve = this._savedRecallCurve;
      this._savedRecallCurve = null;
      frequencyManager.setRecallCurve(curve);   // may re-enter _syncToStaged
    }
    if (p && state === 'done') {
      this._settleOntoSave(p);
      this._logEvent(`✓ arrived "${p.slotName}" (${((Date.now() - p.startedAt) / 1000).toFixed(1)}s)`);
    }
    this._fire();
  }

  // Safety net at completion: EVERY voice must sit exactly on the selected
  // save's frequencies. Anything that slipped through (a glide superseded by
  // user input, an unmute mid-flight, a race) gets settled — silently for
  // muted voices, via a short corrective glide otherwise — and logged with ⚠
  // so stray landings are visible in the panel instead of a mystery.
  _settleOntoSave(p) {
    if (!p) return;
    if (p.slotId !== frequencyManager.stagedSlotId) {
      this._logEvent('⚠ settle skipped — staging changed since the run started');
      return;
    }
    if (!audioEngine.initialized) return;
    const targets = frequencyManager.getStagedFrequencies();
    if (!targets) return;
    const cur = audioEngine.getAllFrequencies();
    const n = Math.min(cur.length, targets.length);
    for (let i = 0; i < n; i++) {
      if (!(targets[i] > 0) || !(cur[i] > 0)) continue;
      const off = Math.round(1200 * Math.log2(targets[i] / cur[i]));
      if (Math.abs(Math.log2(targets[i] / cur[i])) <= DELTA_EPS) continue;
      if (audioEngine.isMuted(i)) {
        frequencyManager.stepVoice(i, { overlapMs: 0, noUndo: true });
        this._logEvent(`⚠ settle v${i} → save (silent retune, was ${off > 0 ? '+' : ''}${off}¢ off)`);
      } else {
        frequencyManager.launchVoice(i, { durMs: 300, noUndo: true });
        this._logEvent(`⚠ settle v${i} → save (was ${off > 0 ? '+' : ''}${off}¢ off)`);
      }
    }
    // The chord must match too: any voice whose mute state slipped through
    // (a halted travel, a user toggle mid-run) gets its note-on/off now.
    const wantMutes = frequencyManager.getStagedMutes();
    if (wantMutes) {
      const nm = Math.min(cur.length, wantMutes.length);
      for (let i = 0; i < nm; i++) {
        const want = !!wantMutes[i];
        if (audioEngine.isMuted(i) === want) continue;
        if (want) audioEngine.muteOscillator(i);
        else audioEngine.unmuteOscillator(i);
        this._logEvent(`⚠ settle v${i} ${want ? 'note-off' : 'note-on'} → save`);
      }
    }
    // And the held chord: spawn/release whatever a mid-run release, steal
    // or lagged glide left off the save's played notes.
    const wantNotes = frequencyManager.getStagedNotes();
    if (wantNotes) {
      const { toSpawn, toRelease } = this._heldDiff(wantNotes);
      for (const n of toSpawn) {
        frequencyManager.spawnHeldNote(n);
        this._logEvent(`⚠ settle ♪ note-on ${Math.round(n.hz)}Hz → save`);
      }
      for (const v of toRelease) {
        frequencyManager.releaseHeldVoice(v.id);
        this._logEvent(`⚠ settle ♪ note-off ${Math.round(v.hz)}Hz → save`);
      }
    }
  }

  // Greedy nearest-pitch matching of the live held chord against a save's
  // heldNotes (mirrors FrequencyManager's recall diff): what's missing
  // spawns, what's surplus releases.
  _heldDiff(saved) {
    const live = keyboardVoiceManager.getHeldNotesLive();
    const used = new Set();
    const toSpawn = [];
    for (const n of saved) {
      let best = null;
      let bestD = Infinity;
      for (const v of live) {
        if (used.has(v.id)) continue;
        const d = Math.abs(Math.log2(n.hz / v.hz));
        if (d < bestD) { bestD = d; best = v; }
      }
      if (best && bestD <= NOTE_EPS) used.add(best.id);
      else toSpawn.push(n);
    }
    return { toSpawn, toRelease: live.filter((v) => !used.has(v.id)) };
  }

  // Keep the preview honest: staging a different slot (or clearing it) makes
  // the old plan meaningless — replan against the new selection. If the user
  // re-stages DURING a run, the not-yet-departed moves would fire toward the
  // NEW slot's targets (launchVoice reads staged targets at fire time) and
  // split the chord across two saves — treat it as an implicit halt instead:
  // the user grabbed the wheel.
  _syncToStaged() {
    const stagedId = frequencyManager.stagedSlotId;
    const planId = this._plan ? this._plan.slotId : null;
    if (planId === stagedId) return;   // no staging change (incl. both null)
    if (this._plan && this._plan.state === 'running') {
      this._logEvent('■ staging changed mid-run — halted (pending departures cancelled)');
      this._finish('halted');
      return;
    }
    if (stagedId == null) {
      this._plan = null;
      this._fire();
    } else {
      this.plan();
    }
  }

  // ─── Debug / visualizer feed ─────────────────────────────────────────
  _logEvent(text) {
    this._logSeq += 1;
    this._debugLog.push({ n: this._logSeq, at: Date.now(), text });
    if (this._debugLog.length > LOG_LIMIT) this._debugLog.shift();
  }

  // Event log, newest LAST (panel reverses for display).
  getLog() { return this._debugLog.slice(); }

  getPlan() { return this._plan; }

  // Live per-voice state for the panel: current Hz vs the staged target (signed
  // cents remaining), so mid-flight progress is visible next to the plan.
  getDebugState() {
    const slotId = frequencyManager.stagedSlotId;
    const slot = slotId != null ? frequencyManager.getSlots().find((s) => s.id === slotId) : null;
    let voices = [];
    if (audioEngine.initialized) {
      const cur = audioEngine.getAllFrequencies();
      const targets = slot ? frequencyManager.getStagedFrequencies() : null;
      voices = cur.map((hz, i) => {
        const target = targets && targets[i] > 0 ? targets[i] : null;
        const cents = target != null && hz > 0 ? Math.round(1200 * Math.log2(target / hz)) : null;
        return { i, hz, target, cents, muted: audioEngine.isMuted(i) };
      });
    }
    return { slotName: slot ? slot.name : null, voices };
  }

  // ─── Subscription ────────────────────────────────────────────────────
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _fire() {
    for (const fn of this._listeners) {
      try { fn(); } catch (e) { console.error('GenerativeConductor listener error', e); }
    }
  }
}

const conductor = new GenerativeConductor();
export default conductor;
