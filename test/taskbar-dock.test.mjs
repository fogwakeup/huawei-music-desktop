import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASKBAR_DOCK, clampDockedX, dockRect, dockWidthDip, isFullscreenForeground,
  preferredDockRect, taskbarGap,
} from '../src/main/taskbar-dock.mjs';

// Real numbers measured on Windows 11 (2560×1440, taskbar 48 px tall, 100 % scale).
const taskbar = { x: 0, y: 1392, width: 2560, height: 48 };
const buttons = { x: 55, y: 1392, width: 356, height: 48 };
const tray = { x: 2079, y: 1392, width: 481, height: 48 };
const start = { x: 0, y: 1392, width: 55, height: 48 };

test('the free band runs from the app buttons to the tray cluster', () => {
  assert.deepEqual(taskbarGap({ taskbar, buttons, tray }), { x: 411, y: 1392, width: 1668, height: 48 });
  // No app buttons yet: the band starts after the start button.
  assert.deepEqual(taskbarGap({ taskbar, start, tray }), { x: 55, y: 1392, width: 2024, height: 48 });
  // No tray measurement: the whole rest of the taskbar is fair game.
  assert.deepEqual(taskbarGap({ taskbar, buttons }).width, taskbar.width - 411);
  assert.equal(taskbarGap({}), null);
  assert.equal(taskbarGap({ taskbar: { x: 0, y: 0, width: 0, height: 48 } }), null);
  assert.equal(taskbarGap({ taskbar, buttons: { x: 0, y: 0, width: 2560, height: 48 }, tray }), null,
    'a full taskbar has no free band');
});

test('width degrades 388 → 248 → 108 and gives up below the nano strip', () => {
  assert.equal(dockWidthDip(1668), TASKBAR_DOCK.normalWidthDip);
  assert.equal(dockWidthDip(412), 388, 'exactly normal + both margins');
  assert.equal(dockWidthDip(400), 248, 'normal does not fit with margins, compact does');
  assert.equal(dockWidthDip(387), 248);
  assert.equal(dockWidthDip(248 + 24), 248);
  assert.equal(dockWidthDip(200), 108);
  assert.equal(dockWidthDip(108 + 24), 108);
  assert.equal(dockWidthDip(131), null, 'not even nano + margins fits');
  assert.equal(dockWidthDip(Number.NaN), null);
});

test('docking keeps a 12 DIP margin, 40 DIP height and centres vertically', () => {
  const gap = taskbarGap({ taskbar, buttons, tray });
  const right = dockRect(gap, 'right');
  assert.deepEqual(right, { x: 1679, y: 1396, width: 388, height: 40, side: 'right', widthDip: 388 });
  assert.equal(right.x + right.width, 2079 - TASKBAR_DOCK.edgeMarginDip, 'right side hugs the tray with a margin');
  const left = dockRect(gap, 'left');
  assert.equal(left.x, 411 + TASKBAR_DOCK.edgeMarginDip);
  assert.equal(left.y, right.y);
  assert.equal(left.width, right.width);
});

test('a taskbar that is nearly full hides the strip instead of covering buttons', () => {
  const cramped = taskbarGap({
    taskbar,
    buttons: { x: 55, y: 1392, width: 1945, height: 48 },
    tray,
  });
  assert.equal(cramped.width, 79);
  assert.equal(dockRect(cramped, 'right'), null);
  assert.equal(preferredDockRect(cramped, 'right'), null);

  const tight = taskbarGap({ taskbar, buttons: { x: 55, y: 1392, width: 1795, height: 48 }, tray });
  const nano = dockRect(tight, 'right');
  assert.equal(tight.width, 229);
  assert.equal(nano.width, TASKBAR_DOCK.nanoWidthDip, 'nano strip when only 108 DIP fit');
});

test('a short taskbar clamps the strip height to the band', () => {
  const shortBar = { x: 0, y: 1400, width: 2560, height: 40 };
  const gap = taskbarGap({ taskbar: shortBar, buttons: { x: 55, y: 1400, width: 356, height: 40 }, tray });
  const rect = dockRect(gap, 'right');
  assert.equal(rect.height, 40);
  assert.equal(rect.y, 1400);
});

test('clampDockedX keeps a dragged strip inside the free band', () => {
  const gap = taskbarGap({ taskbar, buttons, tray });
  assert.equal(clampDockedX(gap, 388, 0), 423, 'never left of the app buttons + margin');
  assert.equal(clampDockedX(gap, 388, 9999), 1679, 'never over the clock/tray');
  assert.equal(clampDockedX(gap, 388, 1200), 1200, 'a position inside the band is kept verbatim');
  assert.equal(clampDockedX(gap, 388, null), 1679, 'no saved anchor → hug the tray');
  assert.equal(clampDockedX(null, 388, 500), null);
});

test('full-screen detection accepts borderless games and rejects maximised windows', () => {
  const display = { x: 0, y: 0, width: 2560, height: 1440 };
  assert.equal(isFullscreenForeground({ x: 0, y: 0, width: 2560, height: 1440 }, display), true);
  assert.equal(isFullscreenForeground({ x: -8, y: -8, width: 2576, height: 1408 }, display), false,
    'a maximised window stops above the taskbar, so the strip must stay');
  assert.equal(isFullscreenForeground({ x: 0, y: 0, width: 1920, height: 1080 }, display), false);
  assert.equal(isFullscreenForeground(null, display), false);
  assert.equal(isFullscreenForeground({ x: 0, y: 0, width: 2560, height: 1440 }, null), false);
});
