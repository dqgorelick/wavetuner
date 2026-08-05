/**
 * CompactSlider - stacked label-over-slider control.
 *
 * Web port of the iOS `SettingsRowUI.compactSlider` (SoundDesignViews
 * .swift): the name and the live value share one line, the track sits
 * underneath. The full-width `.tune-slider-row` grid (label · track ·
 * value) can't survive a half-width column — the side-by-side sections
 * in the source trays (wave preview | shape+fold, envelope graph |
 * ADSR) use this instead so each column still gets a real track.
 *
 * Pure view: the host owns the value and the setter.
 */
export default function CompactSlider({
  label,
  value,
  min = 0,
  max = 1,
  step = 0.01,
  readout,
  onChange,
  disabled = false,
}) {
  return (
    <div className={`compact-slider${disabled ? ' disabled' : ''}`}>
      <div className="compact-slider-head">
        <span className="compact-slider-label">{label}</span>
        <span className="compact-slider-value">{readout}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="tune-slider"
        aria-label={label}
      />
    </div>
  );
}
