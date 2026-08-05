import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { keymap } from '@codemirror/view';
import {
  evalUserCode,
  selectSketch,
  getSketches,
  supportsLiveCode,
  supportsFeedback,
  DEFAULT_SKETCH_ID,
} from '../visuals/backend';
import { listUserSketches, saveSketch, deleteSketch } from '../visuals/hydraStorage';

function VizSlider({ label, value, min, max, step, format, onChange, title, disabled = false }) {
  return (
    <div className={`tune-slider-row${disabled ? ' disabled' : ''}`} title={title}>
      <span className="tune-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="tune-slider"
      />
      <span className="tune-slider-value">{format(value)}</span>
    </div>
  );
}

/**
 * HydraPanel — left-side slide-in with a CodeMirror editor and a list
 * of starter + saved sketches.
 *
 * Live-coding model:
 *   - Default code on open: passthrough sketch (`src(s0).out()`)
 *   - Cmd/Ctrl-Enter inside the editor → eval current code
 *   - Run button in the header → eval
 *   - Hush button → silence Hydra (keeps the canvas, just stops output)
 *   - Save button → prompt for name, persist to localStorage
 *
 * Errors from `evalUserCode` surface in a small status bar below the
 * editor so a typo doesn't silently fail.
 */
export default function HydraPanel({
  isOpen,
  onClose,
  isRunning,
  onEnabledChange,
  vizScale,
  onVizScaleChange,
  vizOutline,
  onVizOutlineChange,
  vizLineWidth,
  onVizLineWidthChange,
  vizCycles,
  onVizCyclesChange,
  vizRotation,
  onVizRotationChange,
  vizMode,
  faceScale,
  onFaceScaleChange,
  faceEyeSize,
  onFaceEyeSizeChange,
  faceEyeGap,
  onFaceEyeGapChange,
  faceMouthWidth,
  onFaceMouthWidthChange,
  faceMouthLineWidth,
  onFaceMouthLineWidthChange,
  faceStandingHeight,
  onFaceStandingHeightChange,
  faceStandingPeriods,
  onFaceStandingPeriodsChange,
  faceMouthGap,
  onFaceMouthGapChange,
  faceMouthCurve,
  onFaceMouthCurveChange,
  faceMouthCurveWidth,
  onFaceMouthCurveWidthChange,
  faceMouthPauseNeutral,
  onFaceMouthPauseNeutralChange,
  timelineWindowSec,
  onTimelineWindowChange,
  timelineFreqMin,
  onTimelineFreqMinChange,
  timelineFreqMax,
  onTimelineFreqMaxChange,
  timelineAutoRange,
  onTimelineAutoRangeChange,
  vizQuality,
  onVizQualityChange,
  vfxScale,
  onVfxScaleChange,
  vfxBlend,
  onVfxBlendChange,
  vfxModR,
  onVfxModRChange,
  vfxModG,
  onVfxModGChange,
  vfxModB,
  onVfxModBChange,
}) {
  const sketches = useMemo(() => getSketches(), []);
  const defaultCode = useMemo(
    () => sketches.find(s => s.id === DEFAULT_SKETCH_ID)?.code || '',
    [sketches]
  );
  const [code, setCode] = useState(defaultCode);
  const codeRef = useRef(code);
  useEffect(() => { codeRef.current = code; }, [code]);

  const [status, setStatus] = useState({ kind: 'idle', text: '' });
  const [userSketches, setUserSketches] = useState([]);
  const refreshUserSketches = useCallback(() => {
    setUserSketches(listUserSketches());
  }, []);
  useEffect(() => { if (isOpen) refreshUserSketches(); }, [isOpen, refreshUserSketches]);

  const panelRef = useRef(null);
  // ESC closes. Click-outside is intentionally NOT a close trigger —
  // the user often interacts with the scope (drag → vfx sliders) while
  // the panel is open and watches the sliders move.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const runCode = useCallback(() => {
    if (!isRunning) {
      setStatus({ kind: 'error', text: 'Hydra is not enabled — toggle it on first.' });
      return;
    }
    const result = evalUserCode(codeRef.current);
    if (result.ok) setStatus({ kind: 'ok', text: 'Sketch evaluated.' });
    else setStatus({ kind: 'error', text: result.error });
  }, [isRunning]);
  // Refs so the CodeMirror keymap (built once, lifetime of the editor)
  // always calls the latest version of runCode without re-creating the
  // editor on every change.
  const runCodeRef = useRef(runCode);
  useEffect(() => { runCodeRef.current = runCode; }, [runCode]);

  const handleToggleEnable = useCallback(() => {
    const next = !isRunning;
    onEnabledChange?.(next);
    setStatus({
      kind: 'idle',
      text: next
        ? 'Hydra enabled. The default sketch will run automatically.'
        : 'Hydra disabled — showing the oscilloscope.',
    });
  }, [isRunning, onEnabledChange]);

  const handleSave = useCallback(() => {
    const name = window.prompt('Name this sketch:', 'My sketch');
    if (!name) return;
    const saved = saveSketch({ name: name.trim(), code: codeRef.current });
    if (saved) {
      setStatus({ kind: 'ok', text: `Saved "${saved.name}".` });
      refreshUserSketches();
    } else {
      setStatus({ kind: 'error', text: 'Could not save (storage unavailable?).' });
    }
  }, [refreshUserSketches]);

  const handleLoad = useCallback((sketch) => {
    // Switch the backend immediately so a preset click "just runs" in
    // both Hydra and shader modes. In the Hydra build we also seed the
    // editor with the source so the user can tweak it; in the shader
    // build the editor is hidden and `sketch.code` is undefined anyway.
    selectSketch(sketch.id);
    if (sketch.code !== undefined) setCode(sketch.code);
    setStatus({
      kind: 'idle',
      text: supportsLiveCode
        ? `Loaded "${sketch.name}". Cmd-Enter to run again.`
        : `Running "${sketch.name}".`,
    });
  }, []);

  const handleDelete = useCallback((id, name) => {
    if (!window.confirm(`Delete "${name}"?`)) return;
    deleteSketch(id);
    refreshUserSketches();
  }, [refreshUserSketches]);

  // Cmd/Ctrl-Enter binding inside the editor. Built once — the keymap
  // handler dispatches through runCodeRef so it always sees the current
  // closure without invalidating the extension array. The lint rule
  // flags the ref read pessimistically; the closure body only runs in
  // a key event, never during render.
  /* eslint-disable react-hooks/refs */
  const cmExtensions = useMemo(() => [
    javascript(),
    keymap.of([{
      key: 'Mod-Enter',
      run: () => { runCodeRef.current(); return true; },
    }]),
  ], []);
  /* eslint-enable react-hooks/refs */

  return (
    <aside
      ref={panelRef}
      className={`hydra-panel${isOpen ? ' open' : ''}`}
      aria-hidden={!isOpen}
    >
      <header className="hydra-panel-header">
        <h3>Visuals</h3>
        <button
          type="button"
          className="hydra-close"
          onClick={onClose}
          aria-label="Close visuals"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
            <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </header>

      <div
        className="hydra-quality-row hydra-quality-top"
        title="Render quality. Pretty: full per-frame detail. Performance: skips work the active mode doesn't need (phase calibration on the plain Lissajous, audio-feature analysis when nothing reads it) and halves the feature rate — looks ~the same, costs much less. Off: falls back to the lightweight Timeline visualizer instead of the scope."
      >
        <span className="tune-slider-label">Quality</span>
        <div className="settings-toggle-row hydra-quality-toggle">
          <button
            type="button"
            className={`settings-toggle-btn ${vizQuality === 'pretty' ? 'on' : 'off'}`}
            onClick={() => onVizQualityChange('pretty')}
            aria-pressed={vizQuality === 'pretty'}
          >
            pretty
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${vizQuality === 'performance' ? 'on' : 'off'}`}
            onClick={() => onVizQualityChange('performance')}
            aria-pressed={vizQuality === 'performance'}
          >
            perf
          </button>
          <button
            type="button"
            className={`settings-toggle-btn ${vizQuality === 'off' ? 'on' : 'off'}`}
            onClick={() => onVizQualityChange('off')}
            aria-pressed={vizQuality === 'off'}
          >
            off
          </button>
        </div>
      </div>

      <section className="hydra-section">
        <VizSlider
          label="Scale"
          value={vizScale}
          min={0.3}
          max={1.5}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={onVizScaleChange}
          title="Overall zoom on the lissajous figure. 100% = the original size; lower shrinks, higher pushes past the canvas edges."
        />
        <VizSlider
          label="Outline"
          value={vizOutline}
          min={0}
          max={3}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={onVizOutlineChange}
          title="Colored neon halo behind the white core (applies to the scope and the timeline). 0% = no halo, just the white core; 100% = original; up to 300% for thick glow."
        />
        <VizSlider
          label="White line"
          value={vizLineWidth}
          min={0.2}
          max={3}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={onVizLineWidthChange}
          title="Thickness of the white core stroke (applies to the scope and the timeline). 100% = original."
        />
        <VizSlider
          label="Trails"
          value={vizCycles}
          min={1}
          max={16}
          step={1}
          format={(v) => `${v}`}
          onChange={onVizCyclesChange}
          title="How many cycles of the lowest sounding frequency fit per frame. Higher = longer trails / more drift."
        />
        <div
          className="tune-slider-row hydra-shape-row"
          title="Rotate the lissajous. Square: L on X, R on Y. Diamond: rotated +45° (mono draws vertically). Mirror: rotated −45° (mirrors the diamond — useful for asymmetric figures)."
        >
          <span className="tune-slider-label">Shape</span>
          <div className="settings-toggle-row hydra-shape-toggle">
            <button
              type="button"
              className={`settings-toggle-btn ${vizRotation === 0 ? 'on' : 'off'}`}
              onClick={() => onVizRotationChange(0)}
              aria-pressed={vizRotation === 0}
            >
              square
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${vizRotation === 1 ? 'on' : 'off'}`}
              onClick={() => onVizRotationChange(1)}
              aria-pressed={vizRotation === 1}
            >
              diamond
            </button>
            <button
              type="button"
              className={`settings-toggle-btn ${vizRotation === -1 ? 'on' : 'off'}`}
              onClick={() => onVizRotationChange(-1)}
              aria-pressed={vizRotation === -1}
            >
              mirror
            </button>
          </div>
        </div>
      </section>

      {(vizMode === 2 || vizMode === 5) && (
        <section className="hydra-section">
          <h5 className="hydra-section-title">
            {vizMode === 2 ? 'Smiling face' : 'Face 2'}
          </h5>
          <VizSlider
            label="Face scale"
            value={faceScale}
            min={0.3}
            max={1.5}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={onFaceScaleChange}
            title="Overall size of the whole face — eyes, gaps and mouth scale together. 100% = original."
          />
          {vizMode === 2 && (
          <>
          <VizSlider
            label="Eye size"
            value={faceEyeSize}
            min={0.3}
            max={2}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={onFaceEyeSizeChange}
            title="Size of the two oscilloscope eyes only (mouth unaffected). 100% = original."
          />
          <VizSlider
            label="Eye gap"
            value={faceEyeGap}
            min={-4}
            max={5}
            step={0.1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={onFaceEyeGapChange}
            title="Horizontal space between the two eyes. 100% = original; 0 = eye boxes touching; negative overlaps them so the drawn figures can close the remaining visible gap."
          />
          <VizSlider
            label="Mouth gap"
            value={faceMouthGap}
            min={-4}
            max={4}
            step={0.1}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={onFaceMouthGapChange}
            title="Vertical space between the eyes and the mouth. 100% = original; 0 = boxes touching; negative overlaps them to pull the visible mouth right up to the eyes."
          />
          <VizSlider
            label="Mouth width"
            value={faceMouthWidth}
            min={0.3}
            max={2}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={onFaceMouthWidthChange}
            title="Horizontal width of the straight mouth. 100% = the eye span; higher extends past the eyes, lower pulls it in. When the Smile knob leaves center, the width blends toward Curve width."
          />
          <VizSlider
            label="Smile"
            value={faceMouthCurve}
            min={-1}
            max={1}
            step={0.05}
            format={(v) => {
              const pct = Math.round(Math.abs(v) * 100);
              if (pct === 0) return '—';
              return v > 0 ? `☺ ${pct}%` : `☹ ${pct}%`;
            }}
            onChange={onFaceMouthCurveChange}
            title="Bend of the mouth's standing wave. Center = straight line; right swings the corners up into a smile, left down into a frown; the extremes are full semicircles. The mouth's average height stays on the neutral line."
          />
          <div
            className="tune-slider-row hydra-shape-row"
            title="Relax: while playback is paused the smile/frown eases back to the neutral straight line (with the wave settling), then eases back to the set bend on play. Keep: the bend stays through pause."
          >
            <span className="tune-slider-label">On pause</span>
            <div className="settings-toggle-row hydra-shape-toggle">
              <button
                type="button"
                className={`settings-toggle-btn ${faceMouthPauseNeutral ? 'on' : 'off'}`}
                onClick={() => onFaceMouthPauseNeutralChange(true)}
                aria-pressed={faceMouthPauseNeutral}
              >
                relax
              </button>
              <button
                type="button"
                className={`settings-toggle-btn ${!faceMouthPauseNeutral ? 'on' : 'off'}`}
                onClick={() => onFaceMouthPauseNeutralChange(false)}
                aria-pressed={!faceMouthPauseNeutral}
              >
                keep
              </button>
            </div>
          </div>
          <VizSlider
            label="Curve width"
            value={faceMouthCurveWidth}
            min={0.3}
            max={2}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={onFaceMouthCurveWidthChange}
            title="Mouth width at full smile/frown. The effective width blends from Mouth width to this as the Smile knob leaves center."
          />
          <VizSlider
            label="Mouth line"
            value={faceMouthLineWidth}
            min={0.5}
            max={6}
            step={0.1}
            format={(v) => `${v.toFixed(1)}×`}
            onChange={onFaceMouthLineWidthChange}
            title="Thickness of the mouth's standing-wave line."
          />
          <VizSlider
            label="Wave height"
            value={faceStandingHeight}
            min={0.2}
            max={2.5}
            step={0.05}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={onFaceStandingHeightChange}
            title="Amplitude of the mouth's standing wave. 100% = original."
          />
          <VizSlider
            label="Wave periods"
            value={faceStandingPeriods}
            min={2}
            max={60}
            step={1}
            format={(v) => `${v}`}
            onChange={onFaceStandingPeriodsChange}
            title="How many periods of the fundamental fit across the mouth. Fewer = easier to read the wave shape; more = denser, better for beat envelopes."
          />
          </>
          )}
        </section>
      )}

      {(vizMode === 4 || vizQuality === 'off') && (
        <section className="hydra-section">
          <VizSlider
            label="Time"
            value={timelineWindowSec}
            min={2}
            max={120}
            step={1}
            format={(v) => `${v}s`}
            onChange={onTimelineWindowChange}
            title="Timeline X-range: how many seconds of history are visible. 'Now' is the right edge; higher = a longer window scrolling more slowly."
          />
          <div
            className="tune-slider-row hydra-shape-row"
            title="Auto: the Low/High range continuously eases to frame whatever's sounding. Manual: set Low/High by hand with the sliders below."
          >
            <span className="tune-slider-label">Range</span>
            <div className="settings-toggle-row hydra-shape-toggle">
              <button
                type="button"
                className={`settings-toggle-btn ${timelineAutoRange ? 'on' : 'off'}`}
                onClick={() => onTimelineAutoRangeChange(true)}
                aria-pressed={timelineAutoRange}
              >
                auto
              </button>
              <button
                type="button"
                className={`settings-toggle-btn ${!timelineAutoRange ? 'on' : 'off'}`}
                onClick={() => onTimelineAutoRangeChange(false)}
                aria-pressed={!timelineAutoRange}
              >
                manual
              </button>
            </div>
          </div>
          <VizSlider
            label="Low"
            value={timelineFreqMin}
            min={20}
            max={1000}
            step={5}
            format={(v) => `${Math.round(v)}Hz`}
            onChange={onTimelineFreqMinChange}
            disabled={timelineAutoRange}
            title="Timeline Y-range floor: the lowest frequency shown (bottom of the view). Disabled while Range is set to auto."
          />
          <VizSlider
            label="High"
            value={timelineFreqMax}
            min={1000}
            max={16000}
            step={100}
            format={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${v}Hz`)}
            onChange={onTimelineFreqMaxChange}
            disabled={timelineAutoRange}
            title="Timeline Y-range ceiling: the highest frequency shown (top of the view). Disabled while Range is set to auto."
          />
        </section>
      )}

      <header className="hydra-header">
        <h3>Hydra</h3>
        <div className="hydra-header-actions">
          <button
            type="button"
            className={`hydra-action-btn hydra-enable-btn ${isRunning ? 'on' : 'off'}`}
            onClick={handleToggleEnable}
            title={isRunning
              ? 'Hydra is on — click to switch back to the plain oscilloscope'
              : 'Hydra is off — click to start the video synth'}
            aria-pressed={isRunning}
          >
            {isRunning ? 'on' : 'off'}
          </button>
          {isRunning && supportsLiveCode && (
            <>
              <button type="button" className="hydra-action-btn" onClick={runCode} title="Run (Cmd-Enter)">
                run
              </button>
              <button type="button" className="hydra-action-btn" onClick={handleSave} title="Save current sketch">
                save
              </button>
            </>
          )}
        </div>
      </header>

      {/* The code editor only exists in the hydra build. The shader
          backend (the web default) ships fixed presets and has no
          JS-evaluable DSL, so the editor window is dropped entirely and
          the RGB split below sits directly under the Hydra header. */}
      {isRunning && supportsLiveCode && (
        <>
          <div className="hydra-editor-wrap">
            <CodeMirror
              value={code}
              onChange={setCode}
              extensions={cmExtensions}
              theme="dark"
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: true,
                indentOnInput: true,
              }}
              height="240px"
            />
          </div>

          <div className={`hydra-status hydra-status-${status.kind}`}>
            {status.text || 'Hydra ready. Cmd-Enter to run.'}
          </div>
        </>
      )}

      {/* Shader backend only (hydra sketches drive their own split in
          code). Lives OUTSIDE the supportsFeedback gate: the mobile lite
          pipeline has no feedback but does have the RGB split, so these
          are the one set of visual sliders a phone gets. Mirrors iOS's
          oscModR/G/B "rgb offset" params. */}
      {!supportsLiveCode && (
      <section className="hydra-section">
        <h5 className="hydra-section-title">RGB split</h5>
        <VizSlider
          label="Red"
          value={vfxModR}
          min={0}
          max={0.1}
          step={0.001}
          format={(v) => v.toFixed(3)}
          onChange={onVfxModRChange}
          title="How far the red channel's tap drifts from the trace. 0 = no red fringe."
        />
        <VizSlider
          label="Green"
          value={vfxModG}
          min={0}
          max={0.1}
          step={0.001}
          format={(v) => v.toFixed(3)}
          onChange={onVfxModGChange}
          title="How far the green channel's tap drifts from the trace. 0 = no green fringe."
        />
        <VizSlider
          label="Blue"
          value={vfxModB}
          min={0}
          max={0.1}
          step={0.001}
          format={(v) => v.toFixed(3)}
          onChange={onVfxModBChange}
          title="How far the blue channel's tap drifts from the trace. 0 = no blue fringe."
        />
      </section>
      )}

      {/* Hidden when the running pipeline has no feedback layer (the
          mobile lite shader) — the sliders would be dead controls. */}
      {supportsFeedback() && (
      <section className="hydra-section">
        <h5 className="hydra-section-title">Feedback</h5>
        <VizSlider
          label="Scale"
          value={vfxScale}
          min={0}
          max={3}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={onVfxScaleChange}
          title="How much the previous frame zooms before being added back. 0 disables the feedback layer. Drag on the oscilloscope to scrub this and Blend together."
        />
        <VizSlider
          label="Blend"
          value={vfxBlend}
          min={0}
          max={1}
          step={0.01}
          format={(v) => v.toFixed(2)}
          onChange={onVfxBlendChange}
          title="How strongly the feedback layer mixes in. 0 = no feedback; 1 = doubled feedback. Also drag-scrubable from the oscilloscope."
        />
      </section>
      )}

      <section className="hydra-section">
        <h5 className="hydra-section-title">Built-ins</h5>
        {sketches.map((s) => (
          <div key={s.id} className="hydra-sketch-card builtin">
            <button
              type="button"
              className="hydra-sketch-load"
              onClick={() => handleLoad(s)}
              title={s.description}
            >
              <span className="hydra-sketch-name">{s.name}</span>
            </button>
          </div>
        ))}
      </section>

      <section className="hydra-section">
        <h5 className="hydra-section-title">Yours</h5>
        {userSketches.length === 0 ? (
          <p className="hydra-empty">
            No saved sketches yet. Hit "save" to keep one.
          </p>
        ) : (
          userSketches.map((s) => (
            <div key={s.id} className="hydra-sketch-card user">
              <button
                type="button"
                className="hydra-sketch-load"
                onClick={() => handleLoad(s)}
              >
                <span className="hydra-sketch-name">{s.name}</span>
              </button>
              <button
                type="button"
                className="hydra-sketch-delete"
                onClick={() => handleDelete(s.id, s.name)}
                title="Delete"
                aria-label={`Delete ${s.name}`}
              >
                ×
              </button>
            </div>
          ))
        )}
      </section>
    </aside>
  );
}
