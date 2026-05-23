import { memo, useEffect, useState, useCallback } from 'react';
import midiCCMap from '../audio/MidiCCMap';
import palette, { useTheme } from '../theme/palette';

/**
 * MidiPanel — appears above the Mixer when MIDI learn mode is on.
 *
 * Sources its data from midiCCMap (mapping rows) and audioEngine
 * (oscillator count, for marking out-of-range bindings). React state
 * holds a `rev` counter that bumps on every midiCCMap.onChange ping;
 * we re-render on bump rather than subscribing to specific fields.
 *
 * The "armed" row appears when the user has clicked a drone in the
 * mixer but no CC message has arrived yet. Clicking cancel clears
 * the arm without exiting learn mode entirely.
 */

function formatTargetLabel(target) {
  if (!target) return '—';
  if (target.kind === 'drone-volume') return `D${target.slot + 1}`;
  return target.kind;
}

function MidiPanel({ oscillatorCount }) {
  useTheme();
  // Bump on every midiCCMap change. We don't need the values — we read
  // them straight from the singleton on render. This avoids holding a
  // stale snapshot in React state.
  const [, setRev] = useState(0);
  useEffect(() => {
    return midiCCMap.onChange(() => setRev((r) => (r + 1) & 0xffff));
  }, []);

  const rows = midiCCMap.list();
  const armed = midiCCMap.armed;

  const handleSave = useCallback(() => {
    midiCCMap.saveToStorage();
  }, []);
  const handleClearAll = useCallback(() => {
    if (rows.length === 0 && !armed) return;
    const ok = window.confirm('Clear all MIDI mappings? This also wipes the saved version.');
    if (!ok) return;
    midiCCMap.clear();
    midiCCMap.clearStorage();
  }, [rows.length, armed]);
  const handleCancelArm = useCallback(() => {
    midiCCMap.cancelArm();
  }, []);
  const handleRowClear = useCallback((target) => {
    midiCCMap.unbind(target);
  }, []);

  const stopPointer = (e) => e.stopPropagation();

  return (
    <div
      className="midi-panel"
      role="region"
      aria-label="MIDI mappings"
      onPointerDown={stopPointer}
    >
      <div className="midi-panel-header">
        <span className="midi-panel-title">MIDI MAPPINGS</span>
        <div className="midi-panel-header-actions">
          <button
            type="button"
            className="midi-panel-btn"
            onClick={handleSave}
            title="Save these mappings for the next session"
          >Save</button>
          <button
            type="button"
            className="midi-panel-btn"
            onClick={handleClearAll}
            title="Clear every mapping"
          >Clear</button>
        </div>
      </div>

      {armed && (
        <div className="midi-row midi-row-armed">
          <span
            className="midi-row-dot"
            style={{ background: armed.kind === 'drone-volume'
              ? palette.oscColor(armed.slot, oscillatorCount)
              : '#fff' }}
          />
          <span className="midi-row-target">{formatTargetLabel(armed)}</span>
          <span className="midi-row-armed-text">waiting for CC…</span>
          <button
            type="button"
            className="midi-panel-btn midi-row-cancel"
            onClick={handleCancelArm}
          >cancel</button>
        </div>
      )}

      <div className="midi-panel-body">
        {rows.length === 0 && !armed ? (
          <div className="midi-panel-empty">
            Click a drone in the mixer below, then move a CC knob on your controller.
          </div>
        ) : (
          rows.map((r) => {
            const color = r.target.kind === 'drone-volume'
              ? palette.oscColor(r.target.slot, oscillatorCount)
              : '#fff';
            const inRange = r.target.kind !== 'drone-volume' || r.target.slot < oscillatorCount;
            const valuePct = Math.max(0, Math.min(1, r.lastValue / 127)) * 100;
            return (
              <div
                key={r.targetKey}
                className={`midi-row ${inRange ? '' : 'out-of-range'}`}
                style={{ '--midi-row-color': color }}
              >
                <span className="midi-row-dot" style={{ background: color }} />
                <span className="midi-row-target">{formatTargetLabel(r.target)}</span>
                <span className="midi-row-cc">CC {r.cc}</span>
                <span className="midi-row-ch">ch {r.channel}</span>
                <div className="midi-row-bar">
                  {inRange ? (
                    <div className="midi-row-bar-fill" style={{ width: `${valuePct}%` }} />
                  ) : (
                    <span className="midi-row-bar-empty">—</span>
                  )}
                </div>
                <button
                  type="button"
                  className="midi-row-x"
                  onClick={() => handleRowClear(r.target)}
                  title="Clear this mapping"
                  aria-label="Clear mapping"
                >×</button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default memo(MidiPanel);
