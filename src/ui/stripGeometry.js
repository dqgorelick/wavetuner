// Column geometry for the mixer console — a direct port of the iOS
// VoiceColumns.geometry math (wavetuner-native: HomeMixerSection.swift),
// in CSS px. The whole console layout is a pure function of
// (count, rowWidth, magnify): the group [label rail][lanes][ALL slot] is
// centered in the row, lanes stretch to fill the room up to MAX_STRETCH,
// and when the voices don't fit the strip pages by whole columns.

export const BASE_PITCH = 46; // un-magnified column pitch
export const GUTTER_WIDTH = 32; // label-rail width AND the ALL column's floor
export const RAIL_INSET = 32; // reservation on each outer edge of the row
export const MAX_STRETCH = 1.35; // cap on stretched pitch vs base
export const ALL_SLOT_SHARE = 0.6; // ALL column ≤ 60% of a lane pitch

// Row skeleton shared by the label rail, voice lanes and the ALL lane.
// Heights of the three fixed rows scale with the control channel; the
// LEVEL fader takes the remaining flex height. Tightened 2026-08-04
// (Dan — "tighten up the spacing between the elements"): the readout row
// lost the slack the smaller freq type freed, the inter-row gap went
// 3 → 2, and the fader's pads 4/5 → 3/4. The ~9px that frees also lifts
// the controlScale cap, so the mute/pan cells get closer to full size.
// Headroom the console claims ABOVE --console-h: the air that used to
// sit between the console's top edge and the edge rails' top. The NOTE
// row (the per-voice frequency button) eats all of it, so its top edge
// lands level with the rail's play/pause box. Must match the same term
// inside --fsb-lift (App.css, #wrapper).
export const CONSOLE_HEAD = 6;

export const PITCH_ROW_H = 45; // freq/note readout row
// Full NOTE-row height as laid out (the readout row plus the head it
// absorbs) — published as --console-note-h. The mobile frequency sheet
// hangs off it (App.css) so it opens straight below the freq buttons.
export const NOTE_ROW_H = PITCH_ROW_H + CONSOLE_HEAD;
// Flattened 2026-08-06 (Dan): the mute cell is a short rectangle on the
// main console rather than a square, so the row gives ~10px back to the
// rest of the column. The SQUARE cell survives inside the FREQUENCY MENU
// (.vp-mute, .freq-rail-marker), which is a list, not a column.
export const MUTE_ROW_BASE = 26;
export const PAN_ROW_BASE = 42;
export const ROW_SPACING = 2;
export const FADER_PAD_TOP = 3;
export const FADER_PAD_BOTTOM = 4;

// Control cells at base pitch (30pt pan dial as on iOS). The mute cell
// is a flat rectangle — 30 wide, matching the pan dial's diameter right
// below it so the two controls share a width and leave a visible gap
// between neighbouring lanes (Dan, 2026-08-06), and 22 tall, which is
// the height the column gets back.
export const PAN_DIAL_BASE = 30;
export const MUTE_CELL_W_BASE = PAN_DIAL_BASE;
export const MUTE_CELL_H_BASE = 22;

export function stripGeometry({
  count,
  rowWidth,
  magnify = 1,
  // Outer-edge reservations. RAIL_INSET is only the fallback: the web
  // console passes a matched, tighter pair (MixerConsole EDGE_INSET) so
  // the label rail and the ALL lane sit equally close to its edges, with
  // the group centered between them.
  leadingInset = RAIL_INSET,
  trailingInset = RAIL_INSET,
}) {
  // The magnifier raises the MINIMUM pitch; fill can still stretch above it.
  const base = BASE_PITCH * Math.max(0.5, magnify);
  const room = rowWidth - leadingInset - trailingInset - GUTTER_WIDTH;
  const allBase = Math.max(GUTTER_WIDTH, ALL_SLOT_SHARE * base);
  const visibleTarget = Math.min(
    count,
    Math.max(1, Math.floor((room - allBase) / base + 0.0001))
  );

  // Fill: solve visible·p + allSlot(p) = room, where
  // allSlot(p) = max(GUTTER_WIDTH, ALL_SLOT_SHARE·p) — two regimes.
  const flat = (room - GUTTER_WIDTH) / visibleTarget;
  const solved = ALL_SLOT_SHARE * flat <= GUTTER_WIDTH
    ? flat
    : room / (visibleTarget + ALL_SLOT_SHARE);
  const pitch = Math.min(Math.max(solved, 34), base * MAX_STRETCH);
  const allSlot = Math.max(GUTTER_WIDTH, ALL_SLOT_SHARE * pitch);

  const groupWidth = GUTTER_WIDTH + visibleTarget * pitch + allSlot;
  const groupX = Math.max(leadingInset, (rowWidth - groupWidth) / 2);
  const leading = groupX + GUTTER_WIDTH;
  const trailing = rowWidth - leading - visibleTarget * pitch;

  const scale = pitch / BASE_PITCH; // drives TYPE sizes
  const laneWidth = pitch - 2 * scale; // 44-in-46 margin, carried proportionally
  const contentWidth = count * pitch;
  const span = rowWidth - leading - trailing;
  // Floor + epsilon: span is an exact column multiple by construction,
  // so float dust must not drop a column.
  const visibleColumns = Math.max(1, Math.floor(span / pitch + 0.0001));
  const viewport = visibleColumns * pitch;
  const slack = Math.max(0, span - viewport);
  const overflows = count > visibleColumns;
  const maxOffset = overflows ? (count - visibleColumns) * pitch : 0;

  const snap = (o) =>
    Math.max(0, Math.min(maxOffset, Math.round(o / pitch) * pitch));

  // X position of the strip's left edge for a given scroll offset.
  const stripX = (offset) => (overflows
    ? leading + slack / 2 - offset
    : leading + (span - contentWidth) / 2);

  return {
    pitch,
    scale,
    laneWidth,
    allSlot,
    leading,
    trailing,
    railLeadingInset: leading - GUTTER_WIDTH,
    allLaneTrailingInset: trailing - allSlot,
    contentWidth,
    span,
    visibleColumns,
    viewport,
    slack,
    overflows,
    maxOffset,
    snap,
    stripX,
    // Clip edges for the scrolling strip (4px fudge for ball glow).
    maskLeft: leading + slack / 2 - 4,
    maskRight: Math.max(0, rowWidth - leading - slack / 2 - viewport - 4),
  };
}

// UIScrollView-style diminishing overshoot (iOS VoiceColumns.rubber):
// approaches (never reaches) 90px as the pointer pulls further past
// the end of the strip.
export function rubber(overshoot) {
  const dim = 90;
  return dim * (1 - 1 / ((0.55 * overshoot) / dim + 1));
}

// Height-capped scale for CONTROL ROW HEIGHTS — deliberately separate
// from `scale`, which drives type. The cap keeps the flex LEVEL fader at
// ≥1.5× the pan row; without it tall type on a short console crushes the
// fader.
export function controlScale(scale, height) {
  const fixed = PITCH_ROW_H + ROW_SPACING * 3 + FADER_PAD_TOP + FADER_PAD_BOTTOM; // 58
  const perScale = MUTE_ROW_BASE + PAN_ROW_BASE + 1.5 * PAN_ROW_BASE; // 131
  return Math.min(scale, Math.max(1, (height - fixed) / perScale));
}

// Mute cell + pan dial sizes. The mute cell is a FLAT RECTANGLE (Dan,
// 2026-08-06) rather than the square it was through 2026-08-05: the
// square spent height the column needed elsewhere. It keeps roughly the
// width it always had — 30·scale, the pan dial's own type-scaled ideal,
// so cell and dial read as one stack and the lanes keep visible air
// between them — and only loses height, to the smaller of 22·scale and
// the mute row less a hair of breathing room. Both sides still yield to
// the lane's width. The cap at muteW keeps a squeezed lane from pushing
// the cell back toward a square. The pan dial IS round, so its diameter
// answers to all three limits.
export function cellGeometry({ scale, control, laneWidth }) {
  const muteW = Math.min(MUTE_CELL_W_BASE * scale, laneWidth);
  const muteH = Math.min(MUTE_CELL_H_BASE * scale, MUTE_ROW_BASE * control - 3, muteW);
  const dial = Math.min(PAN_DIAL_BASE * scale, PAN_ROW_BASE * control - 3, laneWidth);
  return { muteW, muteH, dial };
}
