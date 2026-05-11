import { useEffect, useMemo, useState } from 'react';
import { sampleWaveform } from '../audio/Wave';

const SAMPLES = 160;
const VB_W = 320;
const VB_H = 56;
const PAD_Y = 3;

// Mirror AudioEngine: fold uses sin(drive·π·x) with drive in 1..4, and
// the dry/wet gains cross-fade around the shaper. amount=0 ⇒ pure dry.
function buildPath(position, foldAmount) {
  const samples = sampleWaveform(position, SAMPLES);
  const drive = 1 + foldAmount * 3;
  const mixed = new Float32Array(SAMPLES);
  let peak = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const dry = samples[i];
    const wet = Math.sin(drive * Math.PI * dry);
    const m = dry * (1 - foldAmount) + wet * foldAmount;
    mixed[i] = m;
    const a = Math.abs(m);
    if (a > peak) peak = a;
  }
  const scale = peak > 0 ? 1 / peak : 0;
  const half = (VB_H - PAD_Y * 2) / 2;
  const mid = VB_H / 2;
  let d = '';
  for (let i = 0; i < SAMPLES; i++) {
    const x = (i / (SAMPLES - 1)) * VB_W;
    const y = mid - mixed[i] * scale * half;
    d += i === 0
      ? `M ${x.toFixed(2)} ${y.toFixed(2)}`
      : ` L ${x.toFixed(2)} ${y.toFixed(2)}`;
  }
  return d;
}

export default function WaveShapePreview({ wave, fold }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const u1 = wave.onChange(() => setTick(n => n + 1));
    const u2 = fold.onChange(() => setTick(n => n + 1));
    return () => { u1(); u2(); };
  }, [wave, fold]);

  const d = useMemo(
    () => buildPath(wave.position, fold.amount),
    [wave.position, fold.amount]
  );

  return (
    <svg
      className="wave-preview"
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <line
        x1="0" y1={VB_H / 2} x2={VB_W} y2={VB_H / 2}
        className="wave-preview-axis"
      />
      <path d={d} className="wave-preview-trace" />
    </svg>
  );
}
