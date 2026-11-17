import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeMiniPlayerState } from '../src/main/mini-player-payload.mjs';
import { sanitizeMiniPlayer, sanitizeSettings } from '../src/main/settings.mjs';
import { clampRectangle, dockPosition } from '../src/main/mini-player-layout.mjs';

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

test('mini player settings sanitize the on/off flag and saved position', () => {
  assert.deepEqual(sanitizeMiniPlayer(null), { enabled: true, position: null });
  assert.deepEqual(sanitizeMiniPlayer({ enabled: false, position: { x: 12, y: 40 } }),
    { enabled: false, position: { x: 12, y: 40 } });
  assert.equal(sanitizeMiniPlayer({ position: { x: 1.5, y: 40 } }).position, null, 'fractional coords rejected');
  assert.equal(sanitizeMiniPlayer({ position: { x: 999999, y: 0 } }).position, null, 'off-screen coords rejected');
});

test('settings default enables the desktop mini bar and tray close behaviour', () => {
  const next = sanitizeSettings({ miniPlayer: { enabled: false, position: { x: 5, y: 6 } } });
  assert.deepEqual(next.miniPlayer, { enabled: false, position: { x: 5, y: 6 } });
  assert.deepEqual(sanitizeSettings({ volume: 0.4 }).miniPlayer, { enabled: true, position: null });
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
