import { memo, useEffect, useMemo, useRef, useState } from 'react';
import audioEngine from '../audio/AudioEngine';
import { droneWave, keyboardWave } from '../audio/Wave';
import { droneFold, keyboardFold, FOLD_TYPES } from '../audio/Fold';
import { noise, NOISE_TYPES } from '../audio/Noise';
import useBusGains, { BUS_MAX } from '../hooks/useBusGains';
import { DRIVE_MIN, DRIVE_MAX } from './SourceTrayPanel';
import SourceKnob from './SourceKnob';

// Source knob band — web take on the iOS SourceKnobTray (BottomKnobBar
// .swift). Five dials in one sound-design row:
//
//   waves ‒ shape ‒ fold · noise · saturate
//
// waves/shape/fold are joined by short link lines — all three act on
// the same wave engine (waves = its level, shape/fold = its character).
// iOS pages between two trios on narrow phones; the web band always has
// the width for a flat row, so there's no paging — it fills the console
// column and the dials scale with it (dialGeometry). Tapping a knob (no
// drag) or its label opens that source's tray. The tray itself no longer
// floats above the band: it opens in the side-menu column beside the
// console (SourceTrayPanel), radio with the mixer / tuning / perform and
// frequency menus, so App owns the selection and this row is controlled.
// Grains/ambient/mic are iOS-only.
//
// The drone / kbd / midi bus dials used to sit in a second group here.
// They're gone: their level sliders and envelopes now live inside the
// waves tray, one behind each of three tabs, so the three ADSR panels
// don't stack on top of each other in the menu.

// Dial geometry — the band fills the console column's width instead of
// stepping between two hardcoded sizes at a breakpoint (the old 46 / 32
// pair). The row is five equal slots; the circle takes SIZE_IN_SLOT of
// its slot and the remainder is the air between dials, so gaps scale
// with the dials. MAX_SLOT caps the stretch: past it the band stops
// growing and sits centered under the console with air on the flanks
// (the console is up to 720px wide — five 140px dials would be absurd).
const SLOTS = 5;
const SIZE_IN_SLOT = 0.76;
const MIN_SIZE = 24;
const MAX_SIZE = 50;
const MAX_SLOT = MAX_SIZE / SIZE_IN_SLOT;

const clamp = (lo, v, hi) => Math.max(lo, Math.min(hi, v));

// Slot width → dial size + the type that rides with it. Height matters
// too: the label sits under the circle inside the band's fixed height
// (--knob-band-h), so a wide-but-short band caps the dial as well.
function dialGeometry(width, height) {
  const slot = Math.min((width || 300) / SLOTS, MAX_SLOT);
  // "saturate" is the longest label — ~5.6 slot-widths per em keeps it
  // on one line at every slot size.
  const labelFont = clamp(8, slot / 5.6, 11);
  // Band height minus the label row (font + its 1px underline slot and
  // 2px of padding) and the 1px column gap.
  const heightCap = (height || 66) - labelFont - 8;
  const size = Math.round(clamp(MIN_SIZE, Math.min(slot * SIZE_IN_SLOT, heightCap), MAX_SIZE));
  return {
    slot: Math.round(slot),
    size,
    labelFont: Math.round(labelFont * 10) / 10,
    readoutFont: Math.round(clamp(8, size * 0.22, 12) * 10) / 10,
  };
}

function SourceKnobBand({
  saturationCurve,
  saturationDrive,
  onSaturationCurveChange,
  onSaturationDriveChange,
  // Which tray is open in the side-menu column (App state — the column
  // is a radio shared with the other menus), and the toggle for it.
  openTray = null,
  onToggleTray,
}) {
  // Re-render tick for the singleton modules (wave / fold / noise).
  const [, setTick] = useState(0);
  useEffect(() => {
    const subs = [droneWave, keyboardWave, droneFold, keyboardFold, noise]
      .map((m) => m.onChange(() => setTick((n) => n + 1)));
    return () => subs.forEach((u) => u());
  }, []);

  // The band stretches to the console column's width (the mixer above
  // defines it: viewport lane on phones, shrink-wrapped voice group on
  // desktop, minus the side-menu carve-out when one is open), and the
  // dials are sized from what that measures. No breakpoint jump — the
  // row shrinks continuously as the lane narrows.
  const wrapRef = useRef(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setBox((prev) => (Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5
        ? prev
        : { w: width, h: height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const dial = useMemo(() => dialGeometry(box.w, box.h), [box.w, box.h]);

  const [bus, setBusGain] = useBusGains();

  // Wave dial is a macro: dragging it snaps BOTH pools' shape to the
  // dial value (they can still diverge via the tray's per-pool sliders,
  // in which case the dial shows the drone pool).
  const handleWaveChange = (v) => {
    const p = v * 3;
    droneWave.setPosition(p);
    keyboardWave.setPosition(p);
  };

  // Fold dial is the same kind of macro: dragging sweeps BOTH pools'
  // fold amount 0..1 (the curve's drive rises with it, so the sweep
  // moves through progressively more folds). Per-pool divergence via
  // the tray's sliders, in which case the dial shows the drone pool.
  const handleFoldChange = (v) => {
    droneFold.setAmount(v);
    keyboardFold.setAmount(v);
  };

  // Saturate dial = drive sweep; raising it from zero wakes the
  // saturator (curve off → tanh), mirroring the iOS wake-on-raise.
  const satValue = (saturationDrive - DRIVE_MIN) / (DRIVE_MAX - DRIVE_MIN);
  const handleSaturateChange = (v) => {
    if (saturationCurve === 'off' && v > 0.01) onSaturationCurveChange('tanh');
    onSaturationDriveChange(DRIVE_MIN + v * (DRIVE_MAX - DRIVE_MIN));
  };

  const knobs = [
    {
      kind: 'waves',
      value: bus.waves / BUS_MAX,
      readout: `${Math.round(bus.waves * 100)}`,
      dimmed: bus.waves < 0.005,
      title: 'Wave generator level — volume of the onboard oscillators (100 = unity); tap for the drone / kbd / midi envelopes',
      onChange: setBusGain('waves', (g) => audioEngine.setWaveBusGain(g)),
      linkNext: true,
    },
    {
      kind: 'shape',
      value: droneWave.position / 3,
      readout: `${Math.round((droneWave.position / 3) * 100)}`,
      title: 'Wave shape — sine → triangle → square → saw (drone + keyboard)',
      onChange: handleWaveChange,
      linkNext: true,
    },
    {
      kind: 'fold',
      value: droneFold.amount,
      readout: `${Math.round(droneFold.amount * 100)}`,
      dimmed: droneFold.amount < 0.005,
      title: `Wavefold amount — sweeps through the folds (${FOLD_TYPES[droneFold.type].label.toLowerCase()}, drone + keyboard)`,
      onChange: handleFoldChange,
    },
    {
      kind: 'noise',
      value: noise.level,
      readout: `${Math.round(noise.level * 100)}`,
      dimmed: noise.level < 0.005,
      title: `Noise level (${NOISE_TYPES[noise.type].label.toLowerCase()})`,
      onChange: (v) => noise.setLevel(v),
    },
    {
      kind: 'saturate',
      value: Math.max(0, Math.min(1, satValue)),
      readout: saturationCurve === 'off' ? 'off' : `${Math.round(satValue * 100)}`,
      dimmed: saturationCurve === 'off',
      title: 'Saturation drive — raise to wake the master saturator',
      onChange: handleSaturateChange,
    },
  ];

  return (
    <div className="source-knob-band-wrap" ref={wrapRef}>
      <div
        className="source-knob-band"
        style={{
          '--knob-label-font': `${dial.labelFont}px`,
          '--knob-readout-font': `${dial.readoutFont}px`,
        }}
      >
        {knobs.map((k) => (
          <SourceKnob
            key={k.kind}
            label={k.kind}
            value={k.value}
            readout={k.readout}
            title={k.title}
            dimmed={k.dimmed}
            selected={openTray === k.kind}
            size={dial.size}
            slot={dial.slot}
            linkNext={k.linkNext}
            onChange={k.onChange}
            onSelect={() => onToggleTray?.(k.kind)}
          />
        ))}
      </div>
    </div>
  );
}

export default memo(SourceKnobBand);
