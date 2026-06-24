import { memo, useEffect, useState, useCallback } from 'react';
import midiCCMap from '../audio/MidiCCMap';
import midiInput from '../audio/MidiInput';
import midiOutput from '../audio/MidiOutput';
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

  // MIDI input status/devices, mirrored from the MidiInput singleton.
  const [midiStatus, setMidiStatus] = useState(midiInput.status);
  const [midiDevices, setMidiDevices] = useState(midiInput.devices);
  const [activeMidiInput, setActiveMidiInput] = useState(midiInput.activeInputId);
  const [midiInEnabled, setMidiInEnabled] = useState(midiInput.enabled);
  useEffect(() => {
    return midiInput.onChange(() => {
      setMidiStatus(midiInput.status);
      setMidiDevices(midiInput.devices);
      setActiveMidiInput(midiInput.activeInputId);
      setMidiInEnabled(midiInput.enabled);
    });
  }, []);

  // MIDI output (MPE) status, mirrored from the MidiOutput singleton.
  const [midiOutStatus, setMidiOutStatus] = useState(midiOutput.status);
  const [midiOutDevices, setMidiOutDevices] = useState(midiOutput.devices);
  const [activeMidiOutput, setActiveMidiOutput] = useState(midiOutput.activeOutputId);
  const [midiOutEnabled, setMidiOutEnabled] = useState(midiOutput.enabled);
  const [midiOutBendRange, setMidiOutBendRange] = useState(midiOutput.bendRange);
  useEffect(() => {
    return midiOutput.onChange(() => {
      setMidiOutStatus(midiOutput.status);
      setMidiOutDevices(midiOutput.devices);
      setActiveMidiOutput(midiOutput.activeOutputId);
      setMidiOutEnabled(midiOutput.enabled);
      setMidiOutBendRange(midiOutput.bendRange);
    });
  }, []);

  // Feedback-loop UX guard: never let the same physical bus be picked for
  // both input and output. We exclude by device NAME (IAC/loopMIDI buses
  // share a name across their input + output ports). The hard guard lives
  // in MidiInput; this just keeps the dropdowns honest.
  const activeOutName = (midiOutDevices.find((d) => d.id === activeMidiOutput) || {}).name || null;
  const activeInName = activeMidiInput !== 'all'
    ? ((midiDevices.find((d) => d.id === activeMidiInput) || {}).name || null)
    : null;

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
      {/* MIDI devices — input + output (MPE). Lives at the top of the MIDI
          menu so all MIDI controls are in one place, above the mappings. */}
      <div className="midi-panel-header">
        <span className="midi-panel-title">MIDI IN</span>
      </div>
      <div className="settings-section">
        {/* "MIDI: [on / off]" gates MIDI input only — the computer keyboard
            and on-screen input keep working when this is off. */}
        <div className="settings-inline-row settings-inline-row-spaced">
          <label className="settings-inline-label">MIDI:</label>
          <div className="settings-inline-toggle">
            <button
              type="button"
              className={`settings-toggle-btn ${midiInEnabled ? 'on' : 'off'}`}
              onClick={() => { if (!midiInEnabled) midiInput.setEnabled(true); }}
              aria-pressed={!!midiInEnabled}
              title="Enable MIDI input"
            >
              on
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${!midiInEnabled ? 'on' : 'off'}`}
              onClick={() => { if (midiInEnabled) midiInput.setEnabled(false); }}
              aria-pressed={!midiInEnabled}
              title="Mute MIDI input (keyboard/mouse still play)"
            >
              off
            </button>
          </div>
        </div>
        {midiStatus === 'unsupported' && (
          <span className="settings-info">
            This browser doesn't support Web MIDI (try Chrome or Edge).
          </span>
        )}
        {(midiStatus === 'idle' || midiStatus === 'denied' || midiStatus === 'error') && (
          <>
            {midiStatus === 'denied' && (
              <span className="settings-info">MIDI access denied.</span>
            )}
            {midiStatus === 'error' && (
              <span className="settings-info">MIDI couldn't connect.</span>
            )}
            <button
              type="button"
              className="permission-button"
              onClick={() => midiInput.connect()}
            >
              {midiStatus === 'idle' ? 'Connect MIDI' : 'Try again'}
            </button>
          </>
        )}
        {midiStatus === 'connecting' && (
          <span className="settings-info">Connecting…</span>
        )}
        {midiStatus === 'connected' && midiDevices.length > 0 && (
          <select
            className="settings-select"
            value={activeMidiInput}
            onChange={(e) => midiInput.setActiveInput(e.target.value)}
          >
            <option value="all">All inputs</option>
            {midiDevices.map((d) => {
              const blocked = midiOutEnabled && activeOutName && d.name === activeOutName;
              return (
                <option key={d.id} value={d.id} disabled={blocked}>
                  {d.name}
                  {d.manufacturer ? ` (${d.manufacturer})` : ''}
                  {d.state === 'disconnected' ? ' — offline' : ''}
                  {blocked ? ' — used for output' : ''}
                </option>
              );
            })}
          </select>
        )}
      </div>

      <div className="midi-panel-header">
        <span className="midi-panel-title">MIDI OUT (MPE)</span>
      </div>
      <div className="settings-section">
        {/* Sends the drones AND anything you play (computer keyboard + MIDI
            in) out as MPE, retuned to the active scale, so an external synth
            (e.g. Vital) is the sound source. Target a virtual port (IAC
            Driver / loopMIDI). */}
        <div className="settings-inline-row settings-inline-row-spaced">
          <label className="settings-inline-label">MIDI out (MPE):</label>
          <div className="settings-inline-toggle">
            <button
              type="button"
              className={`settings-toggle-btn ${midiOutEnabled ? 'on' : 'off'}`}
              onClick={() => { if (!midiOutEnabled) midiOutput.setEnabled(true); }}
              aria-pressed={!!midiOutEnabled}
              title="Send drones + played notes to an external synth as MPE"
            >
              on
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${!midiOutEnabled ? 'on' : 'off'}`}
              onClick={() => { if (midiOutEnabled) midiOutput.setEnabled(false); }}
              aria-pressed={!midiOutEnabled}
              title="Stop sending MPE (releases held notes)"
            >
              off
            </button>
          </div>
        </div>
        {midiOutStatus === 'unsupported' && (
          <span className="settings-info">
            This browser doesn't support Web MIDI (try Chrome or Edge).
          </span>
        )}
        {(midiOutStatus === 'idle' || midiOutStatus === 'denied' || midiOutStatus === 'error') && (
          <>
            {midiOutStatus === 'denied' && (
              <span className="settings-info">MIDI access denied.</span>
            )}
            {midiOutStatus === 'error' && (
              <span className="settings-info">MIDI couldn't connect.</span>
            )}
            <button
              type="button"
              className="permission-button"
              onClick={() => midiOutput.connect()}
            >
              {midiOutStatus === 'idle' ? 'Connect MIDI' : 'Try again'}
            </button>
          </>
        )}
        {midiOutStatus === 'connecting' && (
          <span className="settings-info">Connecting…</span>
        )}
        {midiOutStatus === 'connected' && midiOutDevices.length > 0 && (
          <select
            className="settings-select"
            value={activeMidiOutput || ''}
            onChange={(e) => midiOutput.setActiveOutput(e.target.value)}
          >
            {midiOutDevices.map((d) => {
              const blocked = activeInName && d.name === activeInName;
              return (
                <option key={d.id} value={d.id} disabled={blocked}>
                  {d.name}
                  {d.manufacturer ? ` (${d.manufacturer})` : ''}
                  {d.state === 'disconnected' ? ' — offline' : ''}
                  {blocked ? ' — used for input' : ''}
                </option>
              );
            })}
          </select>
        )}
        {midiOutStatus === 'connected' && midiOutDevices.length === 0 && (
          <span className="settings-info">
            No MIDI output ports. Create a virtual port (IAC Driver on macOS,
            loopMIDI on Windows) and run your synth on it.
          </span>
        )}
        {midiOutStatus === 'connected' && midiOutDevices.length > 0 && (
          <>
            <label className="settings-sublabel">Pitch bend range</label>
            <select
              className="settings-select"
              value={midiOutBendRange}
              onChange={(e) => midiOutput.setBendRange(parseInt(e.target.value, 10))}
              title="Must match the synth's pitch-bend range."
            >
              <option value={48}>±48 semitones (default)</option>
              <option value={24}>±24 semitones</option>
              <option value={12}>±12 semitones</option>
              <option value={2}>±2 semitones</option>
            </select>
          </>
        )}
      </div>

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
