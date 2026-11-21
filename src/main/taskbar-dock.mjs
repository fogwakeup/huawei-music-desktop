// Pure geometry for docking the transport strip into the taskbar's *measured* blank gap.
//
// Everything here works in DIP (device-independent pixels) so it can be unit tested in plain
// Node: the Win32 layer converts physical pixels before calling in, and Electron's setBounds
// speaks DIP. The rules mirror what the Chinese music clients do:
//   1. Only the free band between the app-button area and the tray/clock cluster is usable.
//   2. The strip keeps a 12 DIP margin from the docked edge and 40 DIP max height, centred.
//   3. Width degrades 388 → 248 → 108 DIP as the gap shrinks; below that the strip hides
//      instead of squeezing on top of the taskbar buttons.
//
// The taskbar has no public extension API on Windows 11, so this geometry is the part we can
// own; the Win32 layer (win32-taskbar.ts) supplies the real rectangles.

export const TASKBAR_DOCK = Object.freeze({
  normalWidthDip: 388,
  compactWidthDip: 248,
  nanoWidthDip: 108,
  maxHeightDip: 40,
  edgeMarginDip: 12,
});

/**
 * The usable band of a horizontal taskbar: from the right edge of the app buttons (or the start
 * button when there are none) to the left edge of the tray cluster. Null when nothing is left.
 *
 * @param {{ taskbar?: any, start?: any, buttons?: any, tray?: any }} parts
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
export function taskbarGap({ taskbar, start, buttons, tray } = {}) {
  if (!taskbar || !(taskbar.width > 0) || !(taskbar.height > 0)) return null;
  const barRight = taskbar.x + taskbar.width;
  const left = buttons
    ? buttons.x + buttons.width
    : start
      ? start.x + start.width
      : taskbar.x;
  const right = tray ? tray.x : barRight;
  const width = right - left;
  if (!(width > 0)) return null;
  return { x: Math.round(left), y: Math.round(taskbar.y), width: Math.round(width), height: Math.round(taskbar.height) };
}

/**
 * Widest presentation that still fits the gap with a margin on both sides, or null when even the
 * nano strip does not fit (the caller hides the strip in that case).
 */
export function dockWidthDip(gapWidth, options = {}) {
  const margin = Number.isFinite(options.edgeMarginDip) ? options.edgeMarginDip : TASKBAR_DOCK.edgeMarginDip;
  const available = Number(gapWidth) - margin * 2;
  if (!Number.isFinite(available)) return null;
  for (const width of [TASKBAR_DOCK.normalWidthDip, TASKBAR_DOCK.compactWidthDip, TASKBAR_DOCK.nanoWidthDip]) {
    if (available >= width) return width;
  }
  return null;
}

/**
 * The docked rectangle inside a gap. `side: 'right'` hugs the tray, `side: 'left'` hugs the app
 * buttons; both keep `edgeMarginDip` from the edge they touch. Null when the gap is too narrow.
 *
 * @param {{ x: number, y: number, width: number, height: number } | null} gap
 * @param {'left'|'right'} [side]
 * @param {number|null} [widthDip]
 * @param {{ edgeMarginDip?: number, maxHeightDip?: number }} [options]
 * @returns {{ x: number, y: number, width: number, height: number, side: 'left'|'right', widthDip: number } | null}
 */
export function dockRect(gap, side = 'right', widthDip = null, options = {}) {
  if (!gap) return null;
  const margin = Number.isFinite(options.edgeMarginDip) ? options.edgeMarginDip : TASKBAR_DOCK.edgeMarginDip;
  const maxHeight = Number.isFinite(options.maxHeightDip) ? options.maxHeightDip : TASKBAR_DOCK.maxHeightDip;
  const width = Number.isFinite(widthDip) && widthDip > 0 ? widthDip : dockWidthDip(gap.width, { edgeMarginDip: margin });
  if (!width) return null;
  const usable = gap.width - margin * 2;
  if (usable < TASKBAR_DOCK.nanoWidthDip) return null;
  const finalWidth = Math.min(width, usable);
  const height = Math.max(1, Math.min(maxHeight, gap.height));
  const y = Math.round(gap.y + (gap.height - height) / 2);
  const x = side === 'left'
    ? gap.x + margin
    : gap.x + gap.width - margin - finalWidth;
  return { x: Math.round(x), y, width: Math.round(finalWidth), height: Math.round(height), side, widthDip: finalWidth };
}

/** The preferred docked rectangle, falling back to the other side when one does not fit. */
/**
 * @param {{ x: number, y: number, width: number, height: number } | null} gap
 * @param {'left'|'right'} [side]
 * @param {number|null} [widthDip]
 * @param {{ edgeMarginDip?: number, maxHeightDip?: number }} [options]
 * @returns {{ x: number, y: number, width: number, height: number, side: 'left'|'right', widthDip: number } | null}
 */
export function preferredDockRect(gap, side = 'right', widthDip = null, options = {}) {
  const first = dockRect(gap, side, widthDip, options);
  if (first) return first;
  return dockRect(gap, side === 'right' ? 'left' : 'right', widthDip, options);
}

/**
 * Keep a user-dragged x inside the gap: never over the buttons, never over the tray. Returns the
 * clamped x, or null when the gap cannot host the strip at all.
 */
export function clampDockedX(gap, width, x, options = {}) {
  if (!gap) return null;
  const margin = Number.isFinite(options.edgeMarginDip) ? options.edgeMarginDip : TASKBAR_DOCK.edgeMarginDip;
  const usable = gap.width - margin * 2;
  if (usable < TASKBAR_DOCK.nanoWidthDip) return null;
  const finalWidth = Math.min(Number(width) || usable, usable);
  const min = gap.x + margin;
  const max = Math.max(min, gap.x + gap.width - margin - finalWidth);
  const desired = Number.isFinite(x) ? x : max;
  return Math.round(Math.min(Math.max(desired, min), max));
}

/**
 * True when the foreground window covers the display the taskbar lives on. Borderless full-screen
 * games never shrink the work area, so this is the only reliable "yield to the game" signal.
 * A 2 px tolerance absorbs rounding at non-integer DPI scales.
 */
export function isFullscreenForeground(foreground, display, tolerance = 2) {
  if (!foreground || !display) return false;
  if (!(foreground.width > 0) || !(foreground.height > 0)) return false;
  const right = display.x + display.width;
  const bottom = display.y + display.height;
  return foreground.x <= display.x + tolerance
    && foreground.y <= display.y + tolerance
    && foreground.x + foreground.width >= right - tolerance
    && foreground.y + foreground.height >= bottom - tolerance;
}
