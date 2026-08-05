/**
 * GenerativePanel — throw-away debug UI for the one-shot generative TRANSITION
 * (GENERATIVE.md, transition phase). Pinned top-middle, inline styles only.
 *
 * The user stages a save state in the capture bar (their choice — saves have
 * no order); this panel shows the PLAN the conductor rolled for the journey
 * from the current positions into that state: per voice the departure time,
 * mode (glide/step), duration and cents to travel. SHUFFLE re-rolls the dice
 * to preview a different outcome; TRANSITION executes exactly the plan shown;
 * HALT cancels the not-yet-departed voices. Below, the knobs that shape a
 * transition (spread / order / jitter / glide↔step / glide times — step
 * timing lives in the tuning menu) and the event log.
 *
 * While a plan is running it polls a re-render 4×/s so the per-move progress
 * bars and live cents stay current (react-compiler lint: no Date.now() in
 * render — the sampled `now` state is the clock).
 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import conductor from '../audio/GenerativeConductor';
import frequencyManager from '../audio/FrequencyManager';

// One subscribe covering both singletons — either firing re-reads everything.
function subscribe(cb) {
  const offA = conductor.onChange(cb);
  const offB = frequencyManager.onChange(cb);
  return () => { offA(); offB(); };
}

// A monotonic version string bumped on any conductor/FM change; forces the
// component to re-read the (mutable) singletons via useSyncExternalStore.
let version = 0;
conductor.onChange(() => { version += 1; });
frequencyManager.onChange(() => { version += 1; });
function getSnapshot() { return version; }

const wrapStyle = {
  position: 'fixed',
  top: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  zIndex: 9000,
  width: 420,
  maxHeight: '80vh',
  overflowY: 'auto',
  background: 'rgba(20,20,24,0.92)',
  color: '#e8e8ec',
  border: '1px solid #444',
  borderRadius: 8,
  padding: '8px 10px',
  font: '11px/1.4 ui-monospace, Menlo, monospace',
  boxShadow: '0 4px 18px rgba(0,0,0,0.45)',
};

const rowStyle = { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 };
const labelStyle = { flex: '0 0 110px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const readoutStyle = { flex: '0 0 58px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function btn(active, disabled) {
  return {
    flex: 1,
    padding: '5px 6px',
    background: active ? '#3a6ea5' : '#2a2a30',
    color: 'var(--ink)',
    border: '1px solid #555',
    borderRadius: 5,
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.4 : 1,
    font: 'inherit',
  };
}

const fmtHz = (hz) => (hz >= 1000 ? String(Math.round(hz)) : hz.toFixed(1));
const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`;

// Native inputs can't be two-thumbed and thumb pseudo-elements can't be
// styled inline, so the range slider gets this one small style block.
const RANGE_CSS = `
.gen-range-thumb { position:absolute; inset:0; width:100%; height:16px; margin:0;
  -webkit-appearance:none; appearance:none; background:transparent; pointer-events:none; }
.gen-range-thumb::-webkit-slider-thumb { -webkit-appearance:none; appearance:none;
  pointer-events:auto; width:11px; height:11px; border-radius:50%; background:#e8e8ec;
  border:none; cursor:pointer; }
.gen-range-thumb::-moz-range-thumb { pointer-events:auto; width:11px; height:11px;
  border-radius:50%; background:#e8e8ec; border:none; cursor:pointer; }
.gen-range-thumb::-moz-range-track { background:transparent; }
`;

// Two-thumb min/max slider: two overlaid native range inputs (tracks hidden,
// only the thumbs interactive) over a drawn track + filled span. The thumbs
// cross-clamp so lo ≤ hi always. When both thumbs pile up at one end, z-order
// flips so the one that can still move is on top. The filled bar between the
// thumbs is itself draggable: it slides the whole window, width preserved.
function RangeSlider({ spec, lo, hi, onChange }) {
  const trackRef = useRef(null);
  const pct = (v) => ((v - spec.min) / (spec.max - spec.min)) * 100;
  const loOnTop = lo > (spec.min + spec.max) / 2;

  const dragBar = (e) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (rect.width <= 0) return;
    const startX = e.clientX;
    const lo0 = lo;
    const width = hi - lo;
    const move = (ev) => {
      const dv = ((ev.clientX - startX) / rect.width) * (spec.max - spec.min);
      let newLo = Math.round((lo0 + dv) / spec.step) * spec.step;
      newLo = Math.max(spec.min, Math.min(spec.max - width, newLo));
      // Order matters for the conductor's lo≤hi cross-clamp: moving right,
      // raise hi first so lo isn't capped at the OLD hi; moving left, mirror.
      if (dv >= 0) {
        onChange(spec.hiKey, newLo + width);
        onChange(spec.loKey, newLo);
      } else {
        onChange(spec.loKey, newLo);
        onChange(spec.hiKey, newLo + width);
      }
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    e.preventDefault();
  };

  return (
    <span ref={trackRef} style={{ flex: 1, position: 'relative', height: 16 }}>
      <span style={{ position: 'absolute', top: 7, left: 0, right: 0, height: 3, background: 'rgba(var(--ink-rgb),0.15)', borderRadius: 2 }} />
      {/* Grab strip: taller invisible hit area carrying the visible 3px fill. */}
      <span
        onPointerDown={dragBar}
        style={{ position: 'absolute', top: 2, height: 13, left: `${pct(lo)}%`, width: `${pct(hi) - pct(lo)}%`, zIndex: 1, cursor: 'grab', touchAction: 'none', display: 'flex', alignItems: 'center' }}
      >
        <span style={{ width: '100%', height: 3, background: '#3a6ea5', borderRadius: 2 }} />
      </span>
      <input
        className="gen-range-thumb"
        style={{ zIndex: loOnTop ? 4 : 2 }}
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={lo}
        onChange={(e) => onChange(spec.loKey, Math.min(Number(e.target.value), hi))}
        aria-label={`${spec.label} min`}
      />
      <input
        className="gen-range-thumb"
        style={{ zIndex: 3 }}
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={hi}
        onChange={(e) => onChange(spec.hiKey, Math.max(Number(e.target.value), lo))}
        aria-label={`${spec.label} max`}
      />
    </span>
  );
}

// One planned move: `v0  220.0→246.9  +200¢  glide 6.0s @0.0s` plus a live
// progress bar while the plan runs and ✓ once the voice has arrived.
function MoveRow({ mv, plan, now, liveCents }) {
  const elapsed = plan.startedAt != null && now > 0 ? now - plan.startedAt : null;
  const dur = mv.durMs ?? Math.max(mv.stepMs ?? 0, 400);
  let progress = 0;
  if (elapsed != null) progress = Math.max(0, Math.min(1, (elapsed - mv.departMs) / Math.max(1, dur)));
  if (plan.state === 'done') progress = 1;
  const arrived = liveCents != null && Math.abs(liveCents) < 2;
  const flying = plan.state === 'running' && progress > 0 && !arrived;
  const glyph = plan.state === 'preview' ? '·' : arrived || progress >= 1 ? '✓' : flying ? '▶' : '·';
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontVariantNumeric: 'tabular-nums' }}>
      <span style={{ flex: '0 0 10px', color: arrived ? '#6fbf73' : '#e0b25a' }}>{glyph}</span>
      <span style={{ flex: '0 0 36px' }}>
        {mv.held ? '♪' : <>v{mv.i}{mv.mode === 'travel' ? `→v${mv.to}` : ''}</>}
      </span>
      <span style={{ flex: '0 0 96px', textAlign: 'right' }}>{fmtHz(mv.fromHz)}→{fmtHz(mv.toHz)}</span>
      <span style={{ flex: '0 0 46px', textAlign: 'right' }}>{mv.cents > 0 ? '+' : ''}{mv.cents}¢</span>
      <span style={{ flex: '0 0 80px' }}>
        {mv.mode === 'silent' ? 'retune 🔇'
          : mv.mode === 'travel' ? `gliss ${fmtS(mv.durMs)}`
          : mv.mode === 'bloom' ? `✿ bloom ${fmtS(mv.durMs)}`
          : mv.mode === 'merge' ? `⤞ merge ${fmtS(mv.durMs)}`
          : mv.mode === 'fade-in' ? 'note on'
          : mv.mode === 'fade-out' ? 'note off'
          : mv.mode === 'n-glide' ? `gliss ${fmtS(mv.durMs)}`
          : mv.mode === 'n-bloom' ? `✿ bloom ${fmtS(mv.durMs)}`
          : mv.mode === 'n-merge' ? `⤞ merge ${fmtS(mv.durMs)}`
          : mv.mode === 'n-fade-in' ? 'note on'
          : mv.mode === 'n-fade-out' ? 'note off'
          : mv.mode === 'step' ? `step ${fmtS(mv.stepMs)}`
          : `glide ${fmtS(mv.durMs)}`}
      </span>
      <span style={{ flex: '0 0 44px', textAlign: 'right' }}>@{fmtS(mv.departMs)}</span>
      <span style={{ flex: 1, height: 4, background: 'rgba(var(--ink-rgb),0.12)', borderRadius: 2, overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.round(progress * 100)}%`, background: arrived || progress >= 1 ? '#6fbf73' : '#3a6ea5' }} />
      </span>
    </div>
  );
}

export default function GenerativePanel() {
  // Re-render on any conductor / FrequencyManager change.
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  // Wall clock sampled 4×/s while a plan runs — the re-render pulse for the
  // progress bars and live cents, and the countdown's "now".
  const [now, setNow] = useState(0);

  const plan = conductor.getPlan();
  const running = conductor.running;
  const config = conductor.getConfig();
  const schema = conductor.getConfigSchema();
  const dbg = conductor.getDebugState();
  const log = conductor.getLog();
  // Saves the capture bar displays — stored slots can include invisible ones
  // (old sessions, patch imports) the conductor will never travel to.
  const count = (() => {
    try { return conductor.getVisibleSlots().length; } catch { return 0; }
  })();

  // Poll while a plan is running (progress bars) OR previewed (orb drags
  // bypass the manager's onChange, so the preview re-checks staleness here).
  const previewing = plan?.state === 'preview';
  useEffect(() => {
    if (!running && !previewing) return undefined;
    const t = setInterval(() => {
      conductor.refreshPreviewIfStale();
      setNow(Date.now());
    }, 250);
    return () => clearInterval(t);
  }, [running, previewing]);

  const centsByVoice = new Map(dbg.voices.map((v) => [v.i, v.cents]));

  return (
    <div style={wrapStyle}>
      <style>{RANGE_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <strong style={{ flex: '0 0 auto' }}>Transition</strong>
        <span style={{ flex: 1, color: '#e0b25a', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          in development
        </span>
        <span style={{ opacity: 0.7 }}>
          {dbg.slotName != null ? <>current → save <b>{dbg.slotName}</b></> : 'select a save state'}
        </span>
        <button style={{ ...btn(false, false), flex: '0 0 auto', padding: '2px 6px' }} onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? 'expand' : 'hide knobs'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button style={btn(false, running || !plan)} disabled={running || !plan} onClick={() => conductor.shuffle()}>
          ⚂ Shuffle
        </button>
        <button style={btn(true, running || count === 0)} disabled={running || count === 0} onClick={() => conductor.transition()}>
          Transition
        </button>
        <button style={btn(false, !running)} disabled={!running} onClick={() => conductor.halt()}>
          Halt
        </button>
      </div>

      {!collapsed && (
        <div>
          {schema.filter((s) => s.section !== 'rules').map((s) => {
            if (s.type === 'enum') {
              return (
                <div key={s.key} style={rowStyle}>
                  <span style={labelStyle} title={s.key}>{s.label}</span>
                  <div style={{ flex: 1, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {s.options.map((o) => (
                      <button
                        key={o.id}
                        style={{ ...btn(config[s.key] === o.id, false), flex: '0 0 auto', padding: '2px 7px' }}
                        onClick={() => conductor.setConfigValue(s.key, o.id)}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              );
            }
            if (s.type === 'range') {
              const lo = config[s.loKey];
              const hi = config[s.hiKey];
              return (
                <div key={s.key} style={rowStyle}>
                  <span style={labelStyle} title={`${s.loKey} / ${s.hiKey}`}>{s.label}</span>
                  <RangeSlider spec={s} lo={lo} hi={hi} onChange={(k, v) => conductor.setConfigValue(k, v)} />
                  <span style={{ ...readoutStyle, flex: '0 0 78px' }}>{fmtS(lo)}–{fmtS(hi)}</span>
                </div>
              );
            }
            const val = config[s.key];
            const display = Math.abs(val) >= 100 ? Math.round(val) : (Math.round(val * 100) / 100);
            return (
              <div key={s.key} style={rowStyle}>
                <span style={labelStyle} title={s.key}>{s.label}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={val}
                  onChange={(e) => conductor.setConfigValue(s.key, e.target.value)}
                  style={{ flex: 1 }}
                />
                <span style={readoutStyle}>{display}</span>
              </div>
            );
          })}

          {/* ── Rules — musical heuristics, slider = chance each applies ── */}
          <div style={{ margin: '6px 0 3px', opacity: 0.6, borderTop: '1px solid rgba(var(--ink-rgb),0.12)', paddingTop: 5 }}>
            rules <span style={{ opacity: 0.7 }}>· chance each applies per transition</span>
          </div>
          {schema.filter((s) => s.section === 'rules').map((s) => (
            <div key={s.key} style={rowStyle}>
              <span style={labelStyle} title={s.key}>{s.label}</span>
              <input
                type="range"
                min={s.min}
                max={s.max}
                step={s.step}
                value={config[s.key]}
                onChange={(e) => conductor.setConfigValue(s.key, e.target.value)}
                style={{ flex: 1 }}
              />
              <span style={readoutStyle}>{Math.round(config[s.key] * 100)}%</span>
            </div>
          ))}
        </div>
      )}

      {/* ── The plan: what the conductor rolled, live progress while it runs ── */}
      <div style={{ marginBottom: 6, padding: '6px 8px', background: 'rgba(var(--ink-rgb),0.05)', borderRadius: 6 }}>
        {count === 0 && (
          <div style={{ color: '#e0b25a' }}>
            no save states — transitions travel between saves, so save at least
            one state in the capture bar (click a + slot) first
          </div>
        )}
        {count > 0 && !plan && <div style={{ opacity: 0.5 }}>no plan — select a save state in the capture bar</div>}
        {plan && (
          <>
            <div style={{ display: 'flex', marginBottom: 4, opacity: 0.8 }}>
              <span style={{ flex: 1 }}>
                plan #{plan.seq} · {plan.moves.length} move{plan.moves.length === 1 ? '' : 's'} · {fmtS(plan.totalMs)} total
                {plan.rules?.length > 0 && <span style={{ color: '#8fb8e0' }}> · {plan.rules.join(' · ')}</span>}
              </span>
              <span>{plan.state}</span>
            </div>
            {plan.moves.map((mv) => (
              // Voice-led plans can put one slot in two moves (its voice
              // travels away AND a note arrives there) — key by mode too.
              // Live cents only make sense for moves whose row tracks the
              // slot's own pitch; a travel/bloom/merge row tracks a voice
              // the debug read can't see, so its glyph runs on progress.
              <MoveRow
                key={`${mv.mode}:${mv.i}:${mv.to ?? ''}`}
                mv={mv}
                plan={plan}
                now={now}
                liveCents={mv.mode === 'glide' || mv.mode === 'step' || mv.mode === 'silent' ? centsByVoice.get(mv.i) : null}
              />
            ))}
            {plan.skipped.map((s) => (
              <div key={`s${s.i}`} style={{ opacity: 0.4 }}>
                {'  '}v{s.i} {s.reason === 'no-target' ? '⚠ no target in this save' : '✓ already at target'}
              </div>
            ))}
          </>
        )}
        <div style={{ marginTop: 5, maxHeight: 84, overflow: 'auto', opacity: 0.75, borderTop: '1px solid rgba(var(--ink-rgb),0.12)', paddingTop: 4 }}>
          {log.length === 0 && <div style={{ opacity: 0.5 }}>no events yet</div>}
          {[...log].reverse().map((e) => (
            <div key={e.n} style={{ whiteSpace: 'nowrap' }}>
              <span style={{ opacity: 0.45 }}>#{e.n} </span>{e.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
