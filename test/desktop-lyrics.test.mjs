import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDesktopLyricsUpdate } from '../src/main/desktop-lyrics-payload.mjs';
import { sanitizeDesktopLyrics, sanitizeSettings } from '../src/main/settings.mjs';

test('desktop lyrics payloads keep short text lines and drop junk', () => {
  const cleaned = sanitizeDesktopLyricsUpdate({
    title: '晴天', artist: '周杰伦', synced: true,
    current: { text: '刮风这天我试过握着你手', translation: '但偏偏雨渐渐大到我看你不见' },
    next: { text: '还要多久我才能在你身边', translation: null },
  });
  assert.deepEqual(cleaned, {
    title: '晴天', artist: '周杰伦', synced: true,
    current: { text: '刮风这天我试过握着你手', translation: '但偏偏雨渐渐大到我看你不见' },
    next: { text: '还要多久我才能在你身边', translation: null },
  });
  assert.equal(sanitizeDesktopLyricsUpdate(null), null);
  assert.equal(sanitizeDesktopLyricsUpdate({}), null, 'completely empty push is dropped');
  assert.deepEqual(sanitizeDesktopLyricsUpdate({ title: '晴天' }),
    { title: '晴天', artist: '', synced: false, current: null, next: null }, 'title-only clears the overlay');
});

test('desktop lyrics payloads clamp long text and strip non-string fields', () => {
  const cleaned = sanitizeDesktopLyricsUpdate({
    title: 'x'.repeat(400), artist: 42, synced: 'yes',
    current: { text: 'y'.repeat(600), translation: 7 }, next: { translation: 'z'.repeat(600) },
  });
  assert.equal(cleaned.title.length, 200);
  assert.equal(cleaned.artist, '');
  assert.equal(cleaned.synced, false);
  assert.equal(cleaned.current.text.length, 500);
  assert.equal(cleaned.current.translation, null);
  assert.equal(cleaned.next.text, '');
  assert.equal(cleaned.next.translation.length, 500);
});

const DEFAULTS = {
  enabled: true, locked: false, position: null, fontColor: '#ffffff',
  showBackground: false, backgroundOpacity: 0.55, fontSize: 34, width: 760,
};

test('desktop lyrics settings sanitize flags, positions and appearance', () => {
  assert.deepEqual(sanitizeDesktopLyrics(null), DEFAULTS);
  assert.deepEqual(sanitizeDesktopLyrics({ enabled: true, locked: 'x', position: { x: 10, y: 20 } }),
    { ...DEFAULTS, position: { x: 10, y: 20 } });
  assert.equal(sanitizeDesktopLyrics({ position: { x: 1.5, y: 20 } }).position, null, 'fractional coords rejected');
  assert.equal(sanitizeDesktopLyrics({ position: { x: 999999, y: 0 } }).position, null, 'off-screen coords rejected');
  // A style-only patch keeps the stored spot: the overlay sends {fontSize} while the user drags a
  // slider, and dropping the position would teleport the lyrics back to the default corner.
  assert.deepEqual(sanitizeDesktopLyrics({ locked: true }, { ...DEFAULTS, position: { x: 1, y: 2 } }),
    { ...DEFAULTS, locked: true, position: { x: 1, y: 2 } });
  assert.equal(sanitizeDesktopLyrics({ fontSize: 40 }, { ...DEFAULTS, position: { x: 1, y: 2 } }).position.y, 2);
  assert.equal(sanitizeDesktopLyrics({ position: null }, { ...DEFAULTS, position: { x: 1, y: 2 } }).position, null,
    'an explicit null still resets the position');
});

test('desktop lyrics appearance fields are validated and clamped', () => {
  assert.equal(sanitizeDesktopLyrics({ fontColor: '#AbCdEf' }).fontColor, '#abcdef', 'hex normalised to lower case');
  assert.equal(sanitizeDesktopLyrics({ fontColor: 'red' }).fontColor, '#ffffff', 'named colours rejected');
  assert.equal(sanitizeDesktopLyrics({ fontColor: 'javascript:alert(1)' }).fontColor, '#ffffff');
  assert.equal(sanitizeDesktopLyrics({ backgroundOpacity: 5 }).backgroundOpacity, 1);
  assert.equal(sanitizeDesktopLyrics({ backgroundOpacity: -2 }).backgroundOpacity, 0);
  assert.equal(sanitizeDesktopLyrics({ backgroundOpacity: Number.NaN }).backgroundOpacity, 0.55);
  assert.equal(sanitizeDesktopLyrics({ backgroundOpacity: 0.3 }).backgroundOpacity, 0.3);
  // The plate is opt-in, so an untouched install draws no dark box behind the lyrics.
  assert.equal(sanitizeDesktopLyrics(null).showBackground, false);
  assert.equal(sanitizeDesktopLyrics({ showBackground: true }).showBackground, true);
  assert.equal(sanitizeDesktopLyrics({ showBackground: 'yes' }).showBackground, false);
  // Stored settings that predate these fields still come back complete.
  const legacy = sanitizeDesktopLyrics(undefined, { enabled: true, locked: true, position: { x: 5, y: 5 } });
  assert.equal(legacy.fontColor, '#ffffff');
  assert.equal(legacy.backgroundOpacity, 0.55);
  assert.equal(legacy.enabled, true);
  assert.equal(legacy.fontSize, 34);
  assert.equal(legacy.width, 760);
});

test('desktop lyrics size settings are clamped to a usable range', () => {
  assert.equal(sanitizeDesktopLyrics({ fontSize: 4 }).fontSize, 16);
  assert.equal(sanitizeDesktopLyrics({ fontSize: 400 }).fontSize, 96);
  assert.equal(sanitizeDesktopLyrics({ fontSize: 48.4 }).fontSize, 48, 'size is rounded to whole px');
  assert.equal(sanitizeDesktopLyrics({ width: 10 }).width, 280);
  assert.equal(sanitizeDesktopLyrics({ width: 99999 }).width, 2400);
  assert.equal(sanitizeDesktopLyrics({ width: Number.NaN }).width, 760);
});

test('settings sanitize integrates the desktop lyrics block', () => {
  const next = sanitizeSettings({ desktopLyrics: { enabled: true, locked: true, position: { x: -8, y: 40 }, fontColor: '#FFE680', backgroundOpacity: 0.2 } });
  assert.deepEqual(next.desktopLyrics, {
    enabled: true, locked: true, position: { x: -8, y: 40 }, fontColor: '#ffe680',
    showBackground: false, backgroundOpacity: 0.2, fontSize: 34, width: 760,
  });
  const untouched = sanitizeSettings({ volume: 0.4 });
  assert.deepEqual(untouched.desktopLyrics, DEFAULTS);
});
