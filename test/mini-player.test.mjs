import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMiniPlayerState } from '../src/main/mini-player-payload.mjs';
import { sanitizeMiniPlayer, sanitizeSettings } from '../src/main/settings.mjs';
import { clampRectangle, dockPosition, isFullscreenBand, taskbarBarRect, taskbarStrip } from '../src/main/mini-player-layout.mjs';

const COVER = 'https://img.kuke.com/cover/123.jpg';

test('mini player state keeps visible text, flags and allowlisted covers', () => {
  assert.deepEqual(sanitizeMiniPlayerState({
    hasTrack: true, title: '晴天', artist: '周杰伦', coverUrl: COVER,
    playing: true, favorite: true, desktopLyrics: true,
  }), {
    hasTrack: true, title: '晴天', artist: '周杰伦', coverUrl: COVER,
    playing: true, favorite: true, desktopLyrics: true,
  });
});

test('mini player state never forwards unsafe URLs or oversized text', () => {
  const cleaned = sanitizeMiniPlayerState({
    hasTrack: 'yes', title: 'x'.repeat(400), artist: 12,
    coverUrl: 'https://evil.example.com/track.js', playing: 'true', favorite: 1, desktopLyrics: {},
  });
  assert.deepEqual(cleaned, {
    hasTrack: false, title: 'x'.repeat(200), artist: '', coverUrl: null,
    playing: false, favorite: false, desktopLyrics: false,
  });
  assert.equal(sanitizeMiniPlayerState(null), null);
});

test('mini player settings sanitize the on/off flag, saved position and taskbar anchor', () => {
  assert.deepEqual(sanitizeMiniPlayer(null),
    { enabled: true, position: null, embedInTaskbar: process.platform !== 'darwin', taskbarX: null });
  assert.deepEqual(sanitizeMiniPlayer({ enabled: false, position: { x: 12, y: 40 } }),
    { enabled: false, position: { x: 12, y: 40 }, embedInTaskbar: process.platform !== 'darwin', taskbarX: null });
  assert.equal(sanitizeMiniPlayer({ position: { x: 1.5, y: 40 } }).position, null, 'fractional coords rejected');
  assert.equal(sanitizeMiniPlayer({ position: { x: 999999, y: 0 } }).position, null, 'off-screen coords rejected');
  assert.equal(sanitizeMiniPlayer({ embedInTaskbar: 'yes' }).embedInTaskbar,
    process.platform !== 'darwin', 'non-boolean mode ignored');
  assert.equal(sanitizeMiniPlayer({ embedInTaskbar: false }).embedInTaskbar, false);
  assert.equal(sanitizeMiniPlayer({ taskbarX: 999999 }).taskbarX, null, 'wild taskbar anchor rejected');
  assert.equal(sanitizeMiniPlayer({ taskbarX: 1500 }).taskbarX, 1500);
});

test('settings default enables the desktop mini bar and tray close behaviour', () => {
  const next = sanitizeSettings({ miniPlayer: { enabled: false, position: { x: 5, y: 6 } } });
  assert.deepEqual(next.miniPlayer,
    { enabled: false, position: { x: 5, y: 6 }, embedInTaskbar: process.platform !== 'darwin', taskbarX: null });
  assert.deepEqual(sanitizeSettings({ volume: 0.4 }).miniPlayer,
    { enabled: true, position: null, embedInTaskbar: process.platform !== 'darwin', taskbarX: null });
  assert.equal(sanitizeSettings(null).closeBehavior, 'tray');
});

// Work area = the screen region ABOVE the taskbar. DEFAULT size 560x66 used explicitly.
const AREA = { x: 0, y: 0, width: 1920, height: 1040 };
const SIZE = { width: 560, height: 66 };

test('clampRectangle keeps the bar fully inside the work area (never under the taskbar)', () => {
  assert.deepEqual(clampRectangle(680, 974, AREA, SIZE), { x: 680, y: 974 }, 'already docked, unchanged');
  assert.deepEqual(clampRectangle(680, 2000, AREA, SIZE), { x: 680, y: 974 }, 'below taskbar pulled back up');
  assert.deepEqual(clampRectangle(-50, -30, AREA, SIZE), { x: 0, y: 0 }, 'negative coords clamped');
  assert.deepEqual(clampRectangle(5000, 500, AREA, SIZE), { x: 1360, y: 500 }, 'right edge clamped');
});

test('clampRectangle handles a work area smaller than the bar without going negative', () => {
  const tiny = { x: 0, y: 0, width: 300, height: 40 };
  assert.deepEqual(clampRectangle(100, 100, tiny, SIZE), { x: 0, y: 0 });
});

test('dockPosition centers horizontally and sits above the taskbar', () => {
  assert.deepEqual(dockPosition(AREA, 8, SIZE), { x: 680, y: 966 });
});

// --- Taskbar presentation ---------------------------------------------------
const BOUNDS = { x: 0, y: 0, width: 1920, height: 1080 };
const WORK = { x: 0, y: 0, width: 1920, height: 1032 }; // 48px bottom taskbar

test('taskbarStrip derives the bottom taskbar band from bounds minus work area', () => {
  assert.deepEqual(taskbarStrip(BOUNDS, WORK), {
    edge: 'bottom',
    rect: { x: 0, y: 1032, width: 1920, height: 48 },
  });
});

test('taskbarStrip handles top, left and right taskbars', () => {
  assert.deepEqual(taskbarStrip(BOUNDS, { x: 0, y: 48, width: 1920, height: 1032 }).rect,
    { x: 0, y: 0, width: 1920, height: 48 });
  assert.deepEqual(taskbarStrip(BOUNDS, { x: 48, y: 0, width: 1872, height: 1080 }),
    { edge: 'left', rect: { x: 0, y: 0, width: 48, height: 1080 } });
  assert.deepEqual(taskbarStrip(BOUNDS, { x: 0, y: 0, width: 1872, height: 1080 }),
    { edge: 'right', rect: { x: 1872, y: 0, width: 48, height: 1080 } });
});

test('isFullscreenBand detects a game covering the taskbar and ignores a normal desktop', () => {
  assert.equal(isFullscreenBand(BOUNDS, WORK), false, 'a visible taskbar is not full-screen');
  assert.equal(isFullscreenBand(BOUNDS, BOUNDS), true, 'work area filling the display means full-screen');
  // Auto-hidden taskbar on the bottom still counts (work area == bounds) — the bar steps aside.
  assert.equal(isFullscreenBand(BOUNDS, { x: 0, y: 0, width: 1920, height: 1080 }), true);
  assert.equal(isFullscreenBand(null, BOUNDS), false);
  assert.equal(isFullscreenBand(BOUNDS, null), false);
});

test('taskbarStrip falls back to a bottom band when the taskbar auto-hides', () => {
  // Auto-hide reports workArea == bounds, so no inset survives.
  const strip = taskbarStrip(BOUNDS, BOUNDS);
  assert.equal(strip.edge, 'bottom');
  assert.deepEqual(strip.rect, { x: 0, y: 1032, width: 1920, height: 48 });
});

test('taskbarBarRect sits inside the band and keeps a margin from the edges', () => {
  const strip = taskbarStrip(BOUNDS, WORK);
  const rect = taskbarBarRect(strip, { width: 420, height: 40 }, null);
  assert.equal(rect.height, 40, 'bar height capped by the taskbar band');
  assert.ok(rect.y >= 1032 && rect.y + rect.height <= 1080, 'bar stays on the taskbar');
  assert.equal(rect.width, 420);
  // Default slot leaves room for the clock/tray on the right.
  assert.equal(rect.x, 1920 - 420 - 300);
});

test('taskbarBarRect clamps a dragged anchor into the band', () => {
  const strip = taskbarStrip(BOUNDS, WORK);
  assert.equal(taskbarBarRect(strip, { width: 420, height: 40 }, -500).x, 4);
  assert.equal(taskbarBarRect(strip, { width: 420, height: 40 }, 5000).x, 1920 - 420 - 4);
  assert.equal(taskbarBarRect(strip, { width: 420, height: 40 }, 600).x, 600);
});

test('taskbarBarRect shrinks the bar on a narrow taskbar band', () => {
  const strip = { edge: 'left', rect: { x: 0, y: 0, width: 44, height: 1080 } };
  const rect = taskbarBarRect(strip, { width: 420, height: 40 }, null);
  assert.ok(rect.width <= 44 - 8, 'vertical taskbar: bar never wider than the band');
  assert.ok(rect.x >= 4 && rect.x + rect.width <= 40, 'bar stays inside the vertical band');
});
