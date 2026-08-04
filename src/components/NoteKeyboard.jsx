import { useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import frequencyManager from '../audio/FrequencyManager';
import { nearestRatio, extendOctaves } from '../audio/jiRatios';
import { freqToMidiAndCents, midiToFreq } from '../ui/pitchMath';

// Note face of the per-voice frequency panel — web port of the iOS
// NoteKeyPicker + CentsDial + tuning cluster (PitchEntry/NoteKeyPicker
// .swift, host wiring in FrequencyPanel.noteCluster). One octave of
// piano keys where a tap commits IMMEDIATELY (audible feedback is the
// point, no confirm), an octave cluster, a ±50¢ rotary whose clean tap
// snaps to the exact note, and just⇄equal commit modes. All math runs
// in the HOST's entry domain: `hz` and every onCommitHz value share it,
// and `transposeRatio` scales the root reference into the same domain
// (1 = nominal; the panel passes the global transpose ratio while its
// "add transpose" toggle is on, then divides commits back to nominal).

const WHITE_PCS = [0, 2, 4, 5, 7, 9, 11];
const WHITE_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
// [pitch class, white-boundary position in white-key widths]
const BLACK_KEYS = [[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]];

const CENTS_MAX = 50;
const PT_PER_CENT = 0.8; // 80px of drag = the full ±50¢ sweep
const CENTS_DETENT = 2;
const DIAL_SLOP = 3; // px of movement before a tap becomes a drag

function CentsDial({ cents, midi, onCommit }) {
  const dragRef = useRef(null);
  const [tracking, setTracking] = useState(false);

  const clamped = Math.max(-CENTS_MAX, Math.min(CENTS_MAX, cents));
  const frac = clamped / CENTS_MAX;

  // Geometry: 40px dial in a 52px hit box; 270° track opening at the
  // bottom, value arc growing from twelve-o'clock toward the orb.
  const c = 26;
  const r = 17;
  const orbAngle = (-90 + 135 * frac) * (Math.PI / 180);
  const orbX = c + r * Math.cos(orbAngle);
  const orbY = c + r * Math.sin(orbAngle);
  const arcLen = (135 / 360) * 100 * Math.abs(frac);
  const arcRotation = frac >= 0 ? -90 : -90 + 135 * frac;

  const label = Math.abs(clamped) < 0.5
    ? '0¢'
    : `${clamped > 0 ? '+' : ''}${Math.round(clamped)}¢`;

  return (
    <div
      className={`cents-dial${tracking ? ' tracking' : ''}`}
      data-testid="centsDial"
      role="slider"
      aria-label="Cents"
      aria-valuemin={-CENTS_MAX}
      aria-valuemax={CENTS_MAX}
      aria-valuenow={Math.round(clamped)}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.preventDefault();
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
        // Anchor midi + cents at touch-down so a ±50 crossing mid-drag
        // can't ratchet the note name (iOS Drag anchor rule).
        dragRef.current = {
          pid: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startMidi: midi,
          startCents: clamped,
          dragged: false,
        };
        setTracking(true);
      }}
      onPointerMove={(e) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.pid) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.dragged && Math.hypot(dx, dy) < DIAL_SLOP) return;
        d.dragged = true;
        // Both axes: up OR right = sharper.
        let next = d.startCents + (dx - dy) / PT_PER_CENT;
        next = Math.max(-CENTS_MAX, Math.min(CENTS_MAX, next));
        if (Math.abs(next) < CENTS_DETENT) next = 0;
        onCommit(d.startMidi, next);
      }}
      onPointerUp={(e) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.pid) return;
        dragRef.current = null;
        setTracking(false);
        // Clean tap = snap to the exact note.
        if (!d.dragged) onCommit(d.startMidi, 0);
      }}
      onPointerCancel={(e) => {
        const d = dragRef.current;
        if (!d || e.pointerId !== d.pid) return;
        dragRef.current = null;
        setTracking(false);
      }}
    >
      <svg viewBox="0 0 52 52" width="52" height="52" aria-hidden="true">
        {/* 270° track lane */}
        <circle
          cx={c} cy={c} r={r}
          fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="3"
          strokeLinecap="round" pathLength="100"
          strokeDasharray="75 25"
          transform={`rotate(135 ${c} ${c})`}
        />
        {/* value arc from twelve-o'clock toward the orb */}
        {Math.abs(frac) > 0.005 && (
          <circle
            cx={c} cy={c} r={r}
            fill="none" stroke="rgba(255,255,255,0.7)" strokeWidth="3"
            strokeLinecap="round" pathLength="100"
            strokeDasharray={`${arcLen} ${100 - arcLen}`}
            transform={`rotate(${arcRotation} ${c} ${c})`}
          />
        )}
        <circle cx={orbX} cy={orbY} r="3.5" fill="rgba(255,255,255,0.95)" />
      </svg>
      <span className="cents-dial-label">{label}</span>
    </div>
  );
}

const TUNING_TIP = 'just — pure 5-limit ratios from the root voice\n'
  + 'equal — the standard 12 equal steps per octave';

export default function NoteKeyboard({ hz, color, slot, onCommitHz, transposeRatio = 1 }) {
  const [just, setJust] = useState(false);
  const [showTip, setShowTip] = useState(false);

  const { midi, cents } = freqToMidiAndCents(hz);
  const centsInt = Math.round(cents);
  const onNote = centsInt === 0;
  const octave = Math.floor(midi / 12) - 1;
  const pc = ((midi % 12) + 12) % 12;

  const anchorSlot = frequencyManager.anchorSlot ?? 0;
  const isRoot = slot === anchorSlot;
  const rootNominal = audioEngine.getFrequency(anchorSlot) || 0;
  // Root reference in the host's entry domain — the just quotient is
  // then domain-invariant (both sides carry the same ratio).
  const rootRef = rootNominal * transposeRatio;
  const justActive = just && !isRoot;

  const commitEqual = (newMidi) => {
    // Cents-preserving: never silently discard a microtonal offset.
    onCommitHz(midiToFreq(newMidi + cents / 100));
  };
  const commitJust = (newMidi) => {
    if (!(rootRef > 0)) { commitEqual(newMidi); return; }
    const nr = nearestRatio(midiToFreq(newMidi) / rootRef, '5-limit');
    if (!nr || nr.n == null || nr.d == null) { commitEqual(newMidi); return; }
    const ext = extendOctaves(nr.n, nr.d, nr.octave);
    // Exact ratio; the cents deviation is deliberately discarded.
    onCommitHz(rootRef * (ext.n / ext.d));
  };
  const select = (newMidi) => {
    if (newMidi < 0 || newMidi > 127) return;
    if (justActive) commitJust(newMidi); else commitEqual(newMidi);
  };
  // Key tap keeps the CURRENT octave (on C4, tapping B gives B4).
  const selectPc = (newPc) => select(12 * (octave + 1) + newPc);

  const rootLabel = rootRef > 0
    ? `root: ${isRoot ? 'this voice' : `voice ${anchorSlot + 1}`} (${rootRef >= 100 ? rootRef.toFixed(0) : rootRef.toFixed(1)}hz)`
    : 'root: —';

  return (
    <div className="vp-note-face" style={{ '--vp-color': color }} data-testid="pitchEntryPane">
      <div className="nkb-row">
        <div className="nkb" data-testid="noteKeyPicker">
          <div className="nkb-whites">
            {WHITE_PCS.map((wpc, wi) => {
              const sel = wpc === pc;
              return (
                <button
                  key={wpc}
                  type="button"
                  className={`nkb-white${sel ? ' sel' : ''}${sel && !onNote ? ' off' : ''}`}
                  onClick={() => selectPc(wpc)}
                  data-testid={`noteKey_${WHITE_NAMES[wi]}`}
                  aria-label={`${WHITE_NAMES[wi]}${octave}`}
                  aria-pressed={sel}
                >
                  {WHITE_NAMES[wi]}
                </button>
              );
            })}
          </div>
          {BLACK_KEYS.map(([bpc, pos]) => {
            const sel = bpc === pc;
            const name = `${WHITE_NAMES[pos - 1]}s`;
            return (
              <button
                key={bpc}
                type="button"
                className={`nkb-black${sel ? ' sel' : ''}${sel && !onNote ? ' off' : ''}`}
                style={{
                  left: `calc(${((pos / 7) * 100).toFixed(3)}% - ${((0.31 / 7) * 100).toFixed(3)}%)`,
                  width: `${((0.62 / 7) * 100).toFixed(3)}%`,
                }}
                onClick={() => selectPc(bpc)}
                data-testid={`noteKey_${name}`}
                aria-label={`${WHITE_NAMES[pos - 1]} sharp ${octave}`}
                aria-pressed={sel}
              />
            );
          })}
        </div>
        <div className="nkb-cluster">
          <span className="nkb-octave" data-testid="noteOctaveValue">{octave}</span>
          <div className="nkb-chevrons">
            <button
              type="button"
              className="nkb-chev"
              onClick={() => select(midi - 12)}
              disabled={midi - 12 < 0}
              data-testid="noteOctaveDown"
              aria-label="Octave down"
            >
              ▾
            </button>
            <button
              type="button"
              className="nkb-chev"
              onClick={() => select(midi + 12)}
              disabled={midi + 12 > 127}
              data-testid="noteOctaveUp"
              aria-label="Octave up"
            >
              ▴
            </button>
          </div>
          <CentsDial
            cents={cents}
            midi={midi}
            onCommit={(anchorMidi, c) => onCommitHz(midiToFreq(anchorMidi + c / 100))}
          />
        </div>
      </div>
      <div className="nkb-tuning">
        <div className="nkb-tuning-head">
          <span>tuning</span>
          <button
            type="button"
            className="nkb-tuning-info"
            onClick={() => setShowTip((v) => !v)}
            aria-label="Tuning modes explained"
            data-testid="tuningInfo"
          >
            ⓘ
          </button>
        </div>
        {showTip && <div className="nkb-tuning-tip" data-testid="tuningInfoTip">{TUNING_TIP}</div>}
        <div className="nkb-tuning-chips">
          <button
            type="button"
            className={`tuning-chip${justActive ? ' active' : ''}`}
            onClick={() => setJust(true)}
            disabled={isRoot}
            data-testid="tuningJust"
            aria-pressed={justActive}
          >
            just
          </button>
          <button
            type="button"
            className={`tuning-chip${!justActive ? ' active' : ''}`}
            onClick={() => setJust(false)}
            data-testid="tuningEqual"
            aria-pressed={!justActive}
          >
            equal
          </button>
        </div>
        <span className="nkb-tuning-root" data-testid="tuningRoot">{rootLabel}</span>
      </div>
    </div>
  );
}
