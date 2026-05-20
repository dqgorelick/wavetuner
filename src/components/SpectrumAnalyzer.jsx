import { useEffect, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import { DUO_ORANGE, DUO_WHITE } from '../theme/palette';

// Display range. F_MIN/MAX bound the visible log frequency axis; values
// outside are clipped. DB_MIN/MAX bound the vertical dBFS scale —
// summed L+R can reach ~+6 dB above either channel, so MAX is left a
// bit of headroom above 0.
const F_MIN = 30;
const F_MAX = 18000;
const DB_MIN = -90;
const DB_MAX = 0;

// Peak-hold decay rate. 8 dB/sec is slow enough to read transient
// peaks but fast enough that the held line tracks slow envelope changes
// over a few seconds.
const HOLD_DECAY_DB_PER_SEC = 8;
const HELD_FLOOR_DB = -200;

// Octave-ish grid lines drawn behind the spectrum — placed at decade
// + half-decade points so the eye can map x-position back to a Hz value
// without an axis label.
const GRID_FREQS = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const GRID_DBS = [-60, -30];

export default function SpectrumAnalyzer() {
  const canvasRef = useRef(null);
  const [holdEnabled, setHoldEnabled] = useState(false);
  const holdRef = useRef(false);
  const heldRef = useRef(null);
  const lastFrameRef = useRef(performance.now());

  // Mirror hold flag into a ref so the rAF loop can read it without
  // re-subscribing on every toggle.
  useEffect(() => { holdRef.current = holdEnabled; }, [holdEnabled]);

  // Reset peaks when hold is freshly enabled — feels more responsive than
  // showing stale peaks from the last time hold was on.
  useEffect(() => {
    if (holdEnabled && heldRef.current) heldRef.current.fill(HELD_FLOOR_DB);
  }, [holdEnabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let rafId = null;
    let dpr = window.devicePixelRatio || 1;
    let dataL = null;
    let dataR = null;
    let summed = null;
    let colMag = null;
    let colHeld = null;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;
      colMag = new Float32Array(w);
      colHeld = new Float32Array(w);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = () => {
      rafId = requestAnimationFrame(draw);
      // Prefer the dedicated 32k-FFT analysers; fall back to the shared
      // 8k ones if the engine hasn't been upgraded yet (or wasn't
      // re-initialized after a code change).
      const a1 = audioEngine.spectrumAnalyserL || audioEngine.analyserNode1;
      const a2 = audioEngine.spectrumAnalyserR || audioEngine.analyserNode2;
      const audioCtx = audioEngine.audioContext;
      if (!a1 || !a2 || !audioCtx) return;
      const W = canvas.width;
      const H = canvas.height;
      if (W < 2 || H < 2) return;

      const N = a1.frequencyBinCount;
      if (!dataL || dataL.length !== N) {
        dataL = new Float32Array(N);
        dataR = new Float32Array(N);
        summed = new Float32Array(N);
        heldRef.current = new Float32Array(N).fill(HELD_FLOOR_DB);
      }
      a1.getFloatFrequencyData(dataL);
      a2.getFloatFrequencyData(dataR);

      // Sum L+R in linear power, convert back to dBFS. Mono sum reads
      // best in a narrow display — overlapping L/R lines turn to mud.
      for (let i = 0; i < N; i++) {
        const lin = Math.pow(10, dataL[i] / 20) + Math.pow(10, dataR[i] / 20);
        summed[i] = 20 * Math.log10(Math.max(1e-12, lin * 0.5));
      }

      // Peak hold with constant-dB decay. Clamp dt so a long
      // tab-backgrounded gap doesn't dump the held line in one frame.
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastFrameRef.current) / 1000);
      lastFrameRef.current = now;
      const held = heldRef.current;
      if (holdRef.current) {
        const decay = HOLD_DECAY_DB_PER_SEC * dt;
        for (let i = 0; i < N; i++) {
          const d = held[i] - decay;
          held[i] = summed[i] > d ? summed[i] : d;
        }
      }

      const sampleRate = audioCtx.sampleRate;
      const binHz = sampleRate / a1.fftSize;
      const fMaxClamped = Math.min(F_MAX, sampleRate / 2 - binHz);
      const logRatio = Math.log(fMaxClamped / F_MIN);

      ctx.clearRect(0, 0, W, H);

      // Background grid: log-spaced frequency verticals + a couple of
      // dB horizontals. Very low contrast — present for orientation,
      // not for reading off values.
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of GRID_FREQS) {
        if (f < F_MIN || f > fMaxClamped) continue;
        const x = Math.round(W * Math.log(f / F_MIN) / logRatio) + 0.5;
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
      }
      for (const db of GRID_DBS) {
        const t = (db - DB_MIN) / (DB_MAX - DB_MIN);
        const y = Math.round(H - t * H) + 0.5;
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
      }
      ctx.stroke();

      const dbToY = (db) => {
        if (db <= DB_MIN) return H;
        if (db >= DB_MAX) return 0;
        return H - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * H;
      };

      // Resample bins onto pixel columns. Two regimes:
      //   • Sub-bin (pixel spans <1 bin, low frequencies): linearly
      //     interpolate between neighboring bins so the line is smooth
      //     instead of stair-stepping across pixels that share one bin.
      //   • Multi-bin (pixel spans >1 bin, high frequencies): take the
      //     bin max so a narrow peak between sample points doesn't get
      //     averaged into invisibility.
      const lastBin = N - 1;
      for (let x = 0; x < W; x++) {
        const fb0 = (F_MIN * Math.exp(logRatio * x / W)) / binHz;
        const fb1 = (F_MIN * Math.exp(logRatio * (x + 1) / W)) / binHz;
        let m, mh;
        if (fb1 - fb0 < 1) {
          const fc = (fb0 + fb1) * 0.5;
          const i0 = Math.max(0, Math.min(lastBin, Math.floor(fc)));
          const i1 = Math.min(lastBin, i0 + 1);
          const t = fc - i0;
          m = summed[i0] * (1 - t) + summed[i1] * t;
          mh = held[i0] * (1 - t) + held[i1] * t;
        } else {
          const i0 = Math.max(0, Math.floor(fb0));
          const i1 = Math.min(lastBin, Math.ceil(fb1));
          m = summed[i0];
          mh = held[i0];
          for (let b = i0 + 1; b <= i1; b++) {
            if (summed[b] > m) m = summed[b];
            if (held[b] > mh) mh = held[b];
          }
        }
        colMag[x] = m;
        colHeld[x] = mh;
      }

      // Live spectrum: filled area under the line for readability.
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let x = 0; x < W; x++) ctx.lineTo(x + 0.5, dbToY(colMag[x]));
      ctx.lineTo(W, H);
      ctx.closePath();
      ctx.fillStyle = `${DUO_WHITE}38`;
      ctx.fill();

      ctx.beginPath();
      for (let x = 0; x < W; x++) {
        const y = dbToY(colMag[x]);
        if (x === 0) ctx.moveTo(x + 0.5, y);
        else ctx.lineTo(x + 0.5, y);
      }
      ctx.strokeStyle = DUO_WHITE;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.stroke();

      // Held peaks line, drawn on top in the accent color so it's the
      // first thing the eye picks up.
      if (holdRef.current) {
        ctx.beginPath();
        for (let x = 0; x < W; x++) {
          const y = dbToY(colHeld[x]);
          if (x === 0) ctx.moveTo(x + 0.5, y);
          else ctx.lineTo(x + 0.5, y);
        }
        ctx.strokeStyle = DUO_ORANGE;
        ctx.lineWidth = Math.max(1, dpr * 1.1);
        ctx.stroke();
      }
    };
    rafId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
    };
  }, []);

  const handleClear = () => {
    if (heldRef.current) heldRef.current.fill(HELD_FLOOR_DB);
  };

  return (
    <div className="spectrum-analyzer">
      <div className="spectrum-header">
        <span className="spectrum-title">Spectrum</span>
        <div className="spectrum-actions">
          <button
            type="button"
            className={`spectrum-btn${holdEnabled ? ' active' : ''}`}
            onClick={() => setHoldEnabled((v) => !v)}
            title={holdEnabled ? 'Peak hold on — click to disable' : 'Enable peak hold'}
            aria-pressed={holdEnabled}
          >
            Hold
          </button>
          <button
            type="button"
            className="spectrum-btn"
            onClick={handleClear}
            disabled={!holdEnabled}
            title="Reset held peaks"
          >
            Clear
          </button>
        </div>
      </div>
      <canvas ref={canvasRef} className="spectrum-canvas" />
    </div>
  );
}
