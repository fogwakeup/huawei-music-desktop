// Pure geometry for the desktop mini transport bar. Kept free of Electron imports so the
// taskbar-occlusion fix can be unit tested in plain Node.
export function clampRectangle(
  x, y,
  area, // { x, y, width, height } of a display work area (taskbar excluded)
  size = { width: 560, height: 66 },
) {
  const nx = Math.min(Math.max(x, area.x), Math.max(area.x, area.x + area.width - size.width));
  const ny = Math.min(Math.max(y, area.y), Math.max(area.y, area.y + area.height - size.height));
  return { x: Math.round(nx), y: Math.round(ny) };
}

/** Dock the bar just above the taskbar, horizontally centered, within the given work area. */
export function dockPosition(area, gap = 8, size = { width: 560, height: 66 }) {
  return clampRectangle(
    Math.round(area.x + (area.width - size.width) / 2),
    Math.round(area.y + area.height - size.height - gap),
    area,
    size,
  );
}
