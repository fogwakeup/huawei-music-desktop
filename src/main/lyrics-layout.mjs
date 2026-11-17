// Pure geometry for the desktop lyrics overlay. Kept free of Electron imports so sizing and
// clamping can be unit-tested directly; desktop-lyrics.ts only feeds it display rectangles.

/** Height of the in-window style panel, added to the window while it is open. */
export const LYRICS_PANEL_HEIGHT = 208; // keep in sync with --lyrics-panel-height in lyrics.css

/** Rooms for one current line plus the smaller "next" line, plus breathing space. */
const LINE_HEIGHT_RATIO = 1.32;
const NEXT_LINE_RATIO = 0.5;
const MIN_NEXT_LINE = 16;
const LINE_GAP = 4;
const VERTICAL_PADDING = 20;

/** Gap between the default resting spot and the bottom of the work area. */
const DEFAULT_BOTTOM_MARGIN = 72;

export function lyricsWindowSize(input = {}) {
  const fontSize = Number.isFinite(input.fontSize) ? input.fontSize : 34;
  const width = Number.isFinite(input.width) ? input.width : 760;
  const current = Math.round(fontSize * LINE_HEIGHT_RATIO);
  const next = Math.max(MIN_NEXT_LINE, Math.round(fontSize * NEXT_LINE_RATIO));
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(48, current + LINE_GAP + next + VERTICAL_PADDING),
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resting rectangle for the overlay: the saved spot clamped into the work area, or a centred
 * slot near the bottom of the screen on first run.
 *
 * @param {{ width: number, height: number }} size
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 * @param {{ x: number, y: number } | null} [position]
 */
export function placeLyrics(size, workArea, position) {
  const maxX = workArea.x + Math.max(0, workArea.width - size.width);
  const maxY = workArea.y + Math.max(0, workArea.height - size.height);
  const fallback = {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - DEFAULT_BOTTOM_MARGIN),
  };
  const start = position && Number.isFinite(position.x) && Number.isFinite(position.y) ? position : fallback;
  return {
    x: Math.round(clamp(start.x, workArea.x, maxX)),
    y: Math.round(clamp(start.y, workArea.y, maxY)),
    width: size.width,
    height: size.height,
  };
}

/**
 * How far the window extends above the text block when the style panel is open (0 when the panel
 * opens downwards instead, or is closed). The value is cached by the caller so a drag can map the
 * window position back onto the persisted text position.
 *
 * @param {{ x: number, y: number, width: number, height: number }} base
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 * @param {boolean} panelOpen
 */
export function panelOffset(base, workArea, panelOpen) {
  if (!panelOpen) return 0;
  return base.y - LYRICS_PANEL_HEIGHT >= workArea.y ? LYRICS_PANEL_HEIGHT : 0;
}

/**
 * Full window bounds including the style panel. The panel opens upwards so the lyric lines keep
 * their on-screen position; when there is no room above, it opens downwards instead.
 *
 * @param {{ x: number, y: number, width: number, height: number }} base
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 * @param {boolean} panelOpen
 */
export function withPanel(base, workArea, panelOpen) {
  const shift = panelOffset(base, workArea, panelOpen);
  return { ...base, y: base.y - shift, height: base.height + (panelOpen ? LYRICS_PANEL_HEIGHT : 0) };
}

/**
 * Keep the bottom edge of the text block fixed while the window grows or shrinks for a new font
 * size, so changing the size never makes the lyrics jump away from where the user put them.
 *
 * @param {{ x: number, y: number, width: number, height: number }} current
 * @param {{ width: number, height: number }} size
 * @param {{ x: number, y: number, width: number, height: number }} workArea
 */
export function resizeFromBottom(current, size, workArea) {
  const bottom = current.y + current.height;
  const y = bottom - size.height;
  const maxX = workArea.x + Math.max(0, workArea.width - size.width);
  const maxY = workArea.y + Math.max(0, workArea.height - size.height);
  return {
    x: Math.round(clamp(current.x, workArea.x, maxX)),
    y: Math.round(clamp(y, workArea.y, maxY)),
    width: size.width,
    height: size.height,
  };
}

/**
 * Window origin while dragging: the grab offset captured at drag start plus the cursor movement.
 * Deriving it from the cursor (instead of the window, which is the thing being moved) keeps the
 * gesture stable — a window sliding under a stationary pointer cannot feed offsets back into itself.
 *
 * @param {{ cursorX: number, cursorY: number, windowX: number, windowY: number }} origin
 * @param {{ x: number, y: number }} cursor
 */
export function dragOriginTo(origin, cursor) {
  return {
    x: Math.round(origin.windowX + (cursor.x - origin.cursorX)),
    y: Math.round(origin.windowY + (cursor.y - origin.cursorY)),
  };
}
