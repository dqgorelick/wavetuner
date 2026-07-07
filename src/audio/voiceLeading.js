/**
 * voiceLeading — pure voice-matching for save-state transitions whose mute
 * masks differ (GENERATIVE.md §6.6). Oscillator slots are scale degrees; the
 * *sounding* notes are the voices. Transitioning chord A → chord B means
 * deciding, for every audible source note, which audible target note it
 * becomes — across slot indices — plus which target notes are new
 * (entrances) and which source notes go away (exits).
 *
 * matchVoices() is deliberately a pure function of plain data so the
 * conductor's plan(), a future animation layer, and tests can all share it.
 *
 * The assignment: enumerate every injective matching of the smaller side
 * into the larger, cost = Σ|log2(target/source)| (total pitch travel in
 * octaves), rank all of them, and let `connect` pick a percentile into that
 * ranking — 0 = minimal total movement (which in one pitch dimension never
 * crosses voices: classic smooth voice leading), 1 = maximal movement
 * (voices deliberately leapfrog), in between = controlled chaos. Chords are
 * small (≤ 12 slots, typically 2-5 sounding), so full enumeration is cheap;
 * a greedy fallback guards the pathological all-12-voices-both-sides case.
 */

// Above this many candidate assignments, fall back to greedy matching
// (P(9,9) = 362 880 starts to matter inside a click handler).
const ENUMERATION_BUDGET = 60000;

const dist = (s, t) => Math.abs(Math.log2(t.hz / s.hz));

// Number of injections of a k-subset: P(n, k) = n·(n-1)…(n-k+1).
function permCount(n, k) {
  let c = 1;
  for (let i = 0; i < k; i++) {
    c *= (n - i);
    if (c > ENUMERATION_BUDGET) return c;
  }
  return c;
}

// All injective matchings of `small` into `large`, each as an array of
// large-side indices (position = small-side index), with total log2 cost.
function enumerateAssignments(small, large) {
  const out = [];
  const used = new Array(large.length).fill(false);
  const pick = new Array(small.length).fill(-1);
  const walk = (si, cost) => {
    if (si === small.length) {
      out.push({ pick: pick.slice(), cost });
      return;
    }
    for (let li = 0; li < large.length; li++) {
      if (used[li]) continue;
      used[li] = true;
      pick[si] = li;
      walk(si + 1, cost + dist(small[si], large[li]));
      used[li] = false;
    }
  };
  walk(0, 0);
  return out;
}

// Greedy fallback for oversized enumerations: each small-side voice in turn
// grabs its nearest (or furthest, past the fader midpoint) unused partner.
function greedyAssignment(small, large, connect) {
  const used = new Array(large.length).fill(false);
  const wantFar = connect >= 0.5;
  return small.map((s) => {
    let best = -1;
    let bestD = wantFar ? -1 : Infinity;
    for (let li = 0; li < large.length; li++) {
      if (used[li]) continue;
      const d = dist(s, large[li]);
      if (wantFar ? d > bestD : d < bestD) { bestD = d; best = li; }
    }
    used[best] = true;
    return best;
  });
}

/**
 * Match the audible voices of the current state to the audible notes of a
 * target save state.
 *
 * @param sources [{ i, hz }] — slot index + pitch of each sounding voice now
 * @param targets [{ i, hz }] — slot index + pitch of each note sounding in the save
 * @param connect 0..1 — percentile into the cost-ranked assignments
 *                (0 = closest / smoothest, 1 = furthest / most crossing)
 * @param maxTravelOct — pairs travelling further than this (in octaves) are
 *                demoted to an exit + entrance (a two-octave gliss reads as
 *                a portamento stunt, not voice leading)
 *
 * @returns {
 *   pairs:     [{ from, to, fromHz, toHz, d }]           — travelling voices
 *   entrances: [{ to, toHz, bloomFrom, bloomFromHz }]    — notes appearing
 *   exits:     [{ from, fromHz, mergeInto, mergeIntoHz }] — notes vanishing
 * }
 * bloomFrom / mergeInto are the nearest matched partner (null when the other
 * side is empty) — where a bloom departs from, where a merge dies into.
 */
export function matchVoices(sources, targets, { connect = 0, maxTravelOct = Infinity } = {}) {
  const m = sources.length;
  const n = targets.length;
  if (m === 0 || n === 0) {
    return {
      pairs: [],
      entrances: targets.map((t) => ({ to: t.i, toHz: t.hz, bloomFrom: null, bloomFromHz: null })),
      exits: sources.map((s) => ({ from: s.i, fromHz: s.hz, mergeInto: null, mergeIntoHz: null })),
    };
  }

  // Orient so we always inject the smaller side into the larger.
  const sourcesSmall = m <= n;
  const small = sourcesSmall ? sources : targets;
  const large = sourcesSmall ? targets : sources;

  let pick;
  if (permCount(large.length, small.length) <= ENUMERATION_BUDGET) {
    const all = enumerateAssignments(small, large);
    all.sort((a, b) => a.cost - b.cost);
    const idx = Math.round(Math.max(0, Math.min(1, connect)) * (all.length - 1));
    pick = all[idx].pick;
  } else {
    pick = greedyAssignment(small, large, connect);
  }

  const pairs = [];
  const usedLarge = new Set(pick);
  for (let si = 0; si < small.length; si++) {
    const s = sourcesSmall ? small[si] : large[pick[si]];
    const t = sourcesSmall ? large[pick[si]] : small[si];
    pairs.push({ from: s.i, to: t.i, fromHz: s.hz, toHz: t.hz, d: Math.log2(t.hz / s.hz) });
  }

  // Whatever the larger side didn't hand out is an entrance (extra targets)
  // or an exit (extra sources).
  const leftovers = large.filter((_, li) => !usedLarge.has(li));
  const entrances = [];
  const exits = [];
  for (const v of leftovers) {
    if (sourcesSmall) entrances.push({ to: v.i, toHz: v.hz, bloomFrom: null, bloomFromHz: null });
    else exits.push({ from: v.i, fromHz: v.hz, mergeInto: null, mergeIntoHz: null });
  }

  // Demote over-the-leash pairs: the source exits, the target enters.
  for (let k = pairs.length - 1; k >= 0; k--) {
    if (Math.abs(pairs[k].d) <= maxTravelOct) continue;
    const p = pairs[k];
    pairs.splice(k, 1);
    exits.push({ from: p.from, fromHz: p.fromHz, mergeInto: null, mergeIntoHz: null });
    entrances.push({ to: p.to, toHz: p.toHz, bloomFrom: null, bloomFromHz: null });
  }

  // Anchor entrances/exits to their nearest surviving partner: a bloom
  // departs from the pitch the ear is already tracking; a merge dies into
  // the note it converges on. Source pitches are read at PLAN time — by the
  // time a bloom departs its anchor may itself be travelling, but the pitch
  // it left behind is still the right starting point.
  const nearest = (hz, arr, key) => {
    let best = null;
    let bestD = Infinity;
    for (const p of arr) {
      const d = Math.abs(Math.log2(p[key] / hz));
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };
  for (const e of entrances) {
    const p = nearest(e.toHz, pairs, 'fromHz');
    if (p) { e.bloomFrom = p.from; e.bloomFromHz = p.fromHz; }
  }
  for (const x of exits) {
    const p = nearest(x.fromHz, pairs, 'toHz');
    if (p) { x.mergeInto = p.to; x.mergeIntoHz = p.toHz; }
  }

  return { pairs, entrances, exits };
}
