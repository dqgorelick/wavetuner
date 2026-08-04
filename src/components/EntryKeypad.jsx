// Numeric entry keypad — web port of iOS PitchEntry/EntryKeypad.swift.
// A dumb value editor over a host-owned buffer string; the frequency
// panel mounts it beside a buffer readout with set / clear buttons.
// Buffer rules make most invalid states unreachable by construction.

const DIGIT_ROWS = [['7', '8', '9'], ['4', '5', '6'], ['1', '2', '3']];

function appendDigit(buffer, digit) {
  // A lone "0" is replaced by the new digit (no "05"); "0." keeps appending.
  const neg = buffer.startsWith('-');
  const digits = neg ? buffer.slice(1) : buffer;
  if (digits === '0') return (neg ? '-' : '') + digit;
  return buffer + digit;
}

function appendPoint(buffer) {
  if (buffer.includes('.')) return buffer;
  const neg = buffer.startsWith('-');
  const digits = neg ? buffer.slice(1) : buffer;
  if (digits === '') return (neg ? '-' : '') + '0.';
  return buffer + '.';
}

function deleteLast(buffer) {
  const next = buffer.slice(0, -1);
  return next === '-' ? '' : next;
}

export default function EntryKeypad({ buffer, onBuffer, onSet }) {
  const key = (label, action, testid) => (
    <button
      key={label}
      type="button"
      className="ekp-key"
      onClick={action}
      data-testid={testid}
    >
      {label}
    </button>
  );
  return (
    <div className="ekp" data-testid="entryKeypad">
      {DIGIT_ROWS.map((row) => (
        <div className="ekp-row" key={row[0]}>
          {row.map((d) => key(d, () => onBuffer(appendDigit(buffer, d)), `keypad_${d}`))}
        </div>
      ))}
      <div className="ekp-row">
        {key('.', () => onBuffer(appendPoint(buffer)), 'keypadPoint')}
        {key('0', () => onBuffer(appendDigit(buffer, '0')), 'keypad_0')}
        {key('⌫', () => onBuffer(deleteLast(buffer)), 'keypadDelete')}
      </div>
      {onSet && (
        <div className="ekp-row">
          <button type="button" className="ekp-key" onClick={onSet} data-testid="keypadSetInline">set</button>
        </div>
      )}
    </div>
  );
}
