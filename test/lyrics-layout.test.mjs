import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LYRICS_PANEL_HEIGHT, dragOriginTo, lyricsWindowSize, placeLyrics, panelOffset, resizeFromBottom, withPanel,
} from '../src/main/lyrics-layout.mjs';

const WORK = { x: 0, y: 0, width: 1920, height: 1032 };

test('lyrics window height follows the font size and the width comes from settings', () => {
  const small = lyricsWindowSize({ fontSize: 24, width: 600 });
  const large = lyricsWindowSize({ fontSize: 48, width: 600 });
  assert.equal(small.width, 600);
  assert.ok(large.height > small.height, 'a bigger font needs a taller window');
  // Two lines plus padding: never a sliver, never a full-screen overlay.
  assert.ok(small.height >= 48);
  assert.ok(large.height < 200);
});

test('lyrics window size falls back sanely for missing values', () => {
  assert.deepEqual(lyricsWindowSize({}), lyricsWindowSize({ fontSize: 34, width: 760 }));
  assert.ok(lyricsWindowSize({ width: 0 }).width >= 1);
});

test('placeLyrics centres the first run near the bottom of the work area', () => {
  const size = lyricsWindowSize({ fontSize: 34, width: 760 });
  const rect = placeLyrics(size, WORK, null);
  assert.equal(rect.x, Math.round((1920 - 760) / 2));
  assert.equal(rect.y + rect.height, WORK.y + WORK.height - 72);
});

test('placeLyrics clamps a saved spot that fell off a disconnected monitor', () => {
  const size = lyricsWindowSize({ fontSize: 34, width: 760 });
  const rect = placeLyrics(size, WORK, { x: -4000, y: 9000 });
  assert.equal(rect.x, WORK.x);
  assert.equal(rect.y + rect.height, WORK.y + WORK.height);
});

test('the style panel grows the window upwards and keeps the text in place', () => {
  const size = lyricsWindowSize({ fontSize: 34, width: 760 });
  const base = placeLyrics(size, WORK, { x: 400, y: 500 });
  const open = withPanel(base, WORK, true);
  assert.equal(open.height, base.height + LYRICS_PANEL_HEIGHT);
  assert.equal(open.y, base.y - LYRICS_PANEL_HEIGHT);
  // Text block bottom edge is unchanged, so the lyrics do not jump when the panel opens.
  assert.equal(open.y + open.height, base.y + base.height);
  assert.equal(panelOffset(base, WORK, true), LYRICS_PANEL_HEIGHT);
  assert.deepEqual(withPanel(base, WORK, false), base);
  assert.equal(panelOffset(base, WORK, false), 0);
});

test('the panel opens downwards when there is no room above', () => {
  const size = lyricsWindowSize({ fontSize: 34, width: 760 });
  const base = placeLyrics(size, WORK, { x: 400, y: 4 });
  const open = withPanel(base, WORK, true);
  assert.equal(open.y, base.y, 'no room above: the window keeps its top edge');
  assert.equal(open.height, base.height + LYRICS_PANEL_HEIGHT);
  assert.equal(panelOffset(base, WORK, true), 0);
});

test('resizeFromBottom keeps the bottom edge while the font changes', () => {
  const before = lyricsWindowSize({ fontSize: 34, width: 760 });
  const after = lyricsWindowSize({ fontSize: 52, width: 900 });
  const current = placeLyrics(before, WORK, { x: 500, y: 600 });
  const next = resizeFromBottom(current, after, WORK);
  assert.equal(next.y + next.height, current.y + current.height);
  assert.equal(next.width, 900);
  assert.equal(next.x, 500);
  // A size that no longer fits above the bottom edge is pushed back into the work area.
  const huge = resizeFromBottom(placeLyrics(before, WORK, { x: 500, y: WORK.height - before.height }), after, WORK);
  assert.ok(huge.y >= WORK.y);
  assert.ok(huge.y + huge.height <= WORK.y + WORK.height);
});

test('dragging derives the window origin from the cursor, not from the window', () => {
  const origin = { cursorX: 900, cursorY: 700, windowX: 500, windowY: 600 };
  // Moving the cursor 120px left and 90px up carries the window with the same offset.
  assert.deepEqual(dragOriginTo(origin, { x: 780, y: 610 }), { x: 380, y: 510 });
  // A stationary cursor never nudges the window, however often the event fires.
  assert.deepEqual(dragOriginTo(origin, { x: 900, y: 700 }), { x: 500, y: 600 });
});
