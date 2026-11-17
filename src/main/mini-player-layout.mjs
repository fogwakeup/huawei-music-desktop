// Pure geometry for the desktop transport bar. Kept free of Electron imports so both the
// floating-capsule and the taskbar-strip layouts can be unit tested in plain Node.
//
// Windows 11 retired the public taskbar-extension API (DeskBand), so a bar cannot become a real
// child of Explorer's taskbar. The taskbar-strip mode instead draws a topmost window exactly on
// the taskbar's own rectangle, which is how the Chinese music clients present the same feature.

/** Clamp a rectangle into a given area (taskbar excluded) so nothing hides off-screen. */
export function clampRectangle(
  x, y,
  area, // { x, y, width, height } of a display work area
  size = { width: 560, height: 66 },
) {
  const nx = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - size.width));
  const ny = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - size.height));
  return { x: Math.round(nx), y: Math.round(ny) };
}

/** Dock the floating capsule just above the taskbar, horizontally centered. */
export function dockPosition(area, gap = 8, size = { width: 560, height: 66 }) {
  return clampRectangle(
    Math.round(area.x + (area.width - size.width) / 2),
    Math.round(area.y + area.height - size.height - gap),
    area,
    size,
  );
}

/**
 * Derive the taskbar strip of a display: the band between the screen bounds and the work area.
 * Electron exposes both, so the strip is correct for any edge, DPI scale or taskbar size. When the
 * taskbar is auto-hidden (work area == bounds) no inset survives, so fall back to a bottom strip of
 * `fallbackThickness` — the bar then hugs the screen edge and appears together with the taskbar.
 *
 * @returns {{ edge: 'bottom'|'top'|'left'|'right', rect: { x: number, y: number, width: number, height: number } }}
 */
export function taskbarStrip(bounds, workArea, fallbackThickness = 48) {
  const top = workArea.y - bounds.y;
  const left = workArea.x - bounds.x;
  const bottom = bounds.y + bounds.height - (workArea.y + workArea.height);
  const right = bounds.x + bounds.width - (workArea.x + workArea.width);
  const thickest = Math.max(top, left, bottom, right);
  if (!(thickest > 0)) {
    return {
      edge: 'bottom',
      rect: { x: bounds.x, y: bounds.y + bounds.height - fallbackThickness, width: bounds.width, height: fallbackThickness },
    };
  }
  if (thickest === top) return { edge: 'top', rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: top } };
  if (thickest === left) return { edge: 'left', rect: { x: bounds.x, y: bounds.y, width: left, height: bounds.height } };
  if (thickest === right) {
    return { edge: 'right', rect: { x: bounds.x + bounds.width - right, y: bounds.y, width: right, height: bounds.height } };
  }
  return { edge: 'bottom', rect: { x: bounds.x, y: bounds.y + bounds.height - bottom, width: bounds.width, height: bottom } };
}

/**
 * Lay the bar out inside a taskbar strip.
 *
 * Horizontal taskbars: the bar fills the strip height (leaving `margin` on each side) and its x is
 * the user's saved anchor, clamped into the strip. `trayReserve` is the fallback distance from the
 * right edge, so the first run starts left of the clock/tray instead of on top of it.
 * Vertical taskbars: only the y anchor is meaningful; the bar hugs the strip width.
 *
 * @param {{ edge: 'bottom'|'top'|'left'|'right', rect: { x: number, y: number, width: number, height: number } }} strip
 * @param {{ width: number, height: number }} [size]
 * @param {number|null} [anchor] saved x (or y for a vertical taskbar) anchor
 * @param {{ margin?: number, trayReserve?: number }} [options]
 */
export function taskbarBarRect(strip, size = { width: 400, height: 40 }, anchor = null, options = {}) {
  const { margin = 4, trayReserve = 300 } = options;
  const rect = strip.rect;
  const horizontal = strip.edge === 'bottom' || strip.edge === 'top';
  const usable = Math.max(1, rect.height - margin * 2);
  const height = Math.round(Math.max(20, Math.min(size.height, usable)));
  const hasAnchor = Number.isFinite(anchor);
  if (horizontal) {
    const width = Math.round(Math.max(160, Math.min(size.width, rect.width - margin * 2)));
    const minX = rect.x + margin;
    const maxX = Math.max(minX, rect.x + rect.width - width - margin);
    const desired = hasAnchor ? anchor : rect.x + rect.width - width - trayReserve;
    return {
      x: Math.round(Math.min(Math.max(desired, minX), maxX)),
      y: Math.round(rect.y + (rect.height - height) / 2),
      width,
      height,
    };
  }
  const width = Math.round(Math.max(20, Math.min(size.width, rect.width - margin * 2)));
  const minY = rect.y + margin;
  const maxY = Math.max(minY, rect.y + rect.height - height - margin);
  const desired = hasAnchor ? anchor : rect.y + rect.height - height - trayReserve;
  return {
    x: Math.round(rect.x + (rect.width - width) / 2),
    y: Math.round(Math.min(Math.max(desired, minY), maxY)),
    width,
    height,
  };
}
