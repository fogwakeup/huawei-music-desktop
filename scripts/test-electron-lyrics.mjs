// Offline regression for the desktop lyrics overlay: bare text by default (no dark plate), pointer
// dragging, in-window size/colour controls, the panel resizing the window, and locking.
// Runs against the real main process and the real settings store — only auth is stubbed.
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as playwright } from 'playwright-core';

process.umask(0o077);
const profile = await mkdtemp(join(tmpdir(), 'huawei-lyrics-profile-'));
const PANEL_HEIGHT = 208; // mirrors LYRICS_PANEL_HEIGHT in src/main/lyrics-layout.mjs

// The settings store is schema-versioned: a bare object is treated as corrupt and replaced.
await writeFile(join(profile, 'settings.json'), JSON.stringify({
  schemaVersion: 1,
  data: {
  closeBehavior: 'tray',
  desktopLyrics: {
    enabled: true, locked: false, position: { x: 240, y: 320 }, fontColor: '#ffffff',
    showBackground: false, backgroundOpacity: 0.55, fontSize: 38, width: 720,
  },
  miniPlayer: { enabled: false, position: null, embedInTaskbar: true, taskbarX: null },
  },
}), 'utf8');

const lyricsPageOf = async app => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const window = app.windows().find(candidate => candidate.url().includes('lyrics.html'));
    if (window) return window;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('desktop lyrics window was never created');
};

const boundsOf = app => app.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('lyrics.html'));
  return window ? { ...window.getBounds(), alwaysOnTop: window.isAlwaysOnTop(), visible: window.isVisible() } : null;
});

const savedLyrics = async () => {
  const raw = await readFile(join(profile, 'settings.json'), 'utf8').catch(() => '{}');
  return JSON.parse(raw).data?.desktopLyrics ?? {};
};

let app;
try {
  app = await playwright.launch({
    executablePath: electron,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`, 'out/main/index.js'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('auth:status');
    ipcMain.handle('auth:status', () => ({ ok: true, data: { authenticated: true, persistence: 'memory-only' } }));
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  const lyrics = await lyricsPageOf(app);
  await lyrics.waitForLoadState('domcontentloaded');
  await lyrics.waitForSelector('.lyrics-body');
  await new Promise(resolve => setTimeout(resolve, 300));

  const start = await boundsOf(app);
  assert.ok(start, 'lyrics window missing');
  assert.equal(start.visible, true, 'lyrics window must be visible');
  assert.equal(start.alwaysOnTop, true, 'lyrics window must stay above other windows');
  assert.equal(start.x, 240, 'saved position is not honoured');
  assert.equal(start.y, 320);
  assert.equal(start.width, 720, 'saved width is not honoured');

  // 1. No black plate: the default overlay is transparent, so only the text shows on the desktop.
  const plate = await lyrics.locator('.lyrics-body').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.match(plate, /rgba\(0, 0, 0, 0\)|transparent/, `default overlay painted a background: ${plate}`);
  assert.equal(await lyrics.locator('#lyrics').evaluate(el => el.classList.contains('has-bg')), false);

  // Push a realistic line through the real bridge so the screenshots and the layout reflect
  // production text rather than the idle placeholder.
  await page.evaluate(() => window.desktop.desktopLyrics.update({
    title: '晴天', artist: '周杰伦', synced: true,
    current: { text: '刮风这天我试过握着你手', translation: null },
    next: { text: '但偏偏雨渐渐大到我看你不见', translation: null },
  }));
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await lyrics.locator('#lyrics-current').textContent(), '刮风这天我试过握着你手');

  // 2. Dragging: the gesture is wired to the drag channels, and dropping the overlay elsewhere
  //    persists that spot. The window follows the OS cursor, which synthetic pointer events cannot
  //    move, so the offset maths itself is covered by test/lyrics-layout.test.mjs.
  await app.evaluate(({ ipcMain }) => {
    globalThis.__drag = [];
    for (const channel of ['desktop-lyrics:drag-start', 'desktop-lyrics:drag-move', 'desktop-lyrics:drag-end']) {
      ipcMain.on(channel, () => globalThis.__drag.push(channel));
    }
  });
  const body = await lyrics.locator('.lyrics-body').boundingBox();
  await lyrics.mouse.move(body.x + body.width / 2, body.y + body.height / 2);
  await lyrics.mouse.down();
  await lyrics.mouse.move(body.x + body.width / 2 - 60, body.y + body.height / 2 - 40, { steps: 6 });
  await lyrics.mouse.up();
  await new Promise(resolve => setTimeout(resolve, 300));
  const dragEvents = await app.evaluate(() => globalThis.__drag);
  assert.equal(dragEvents[0], 'desktop-lyrics:drag-start', 'pressing the lyrics did not start a drag');
  assert.ok(dragEvents.includes('desktop-lyrics:drag-move'), 'moving the pointer did not drive the drag');
  assert.equal(dragEvents.at(-1), 'desktop-lyrics:drag-end', 'releasing the pointer did not end the drag');

  // Dropped somewhere else: the resting spot is written back to settings.
  await lyrics.evaluate(() => { window.desktopLyricsWindow.dragStart(); });
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('lyrics.html'));
    window.setPosition(160, 400);
  });
  await lyrics.evaluate(() => window.desktopLyricsWindow.endDrag());
  await new Promise(resolve => setTimeout(resolve, 700));
  const moved = await boundsOf(app);
  assert.equal(moved.x, 160, 'drag end did not keep the horizontal spot');
  assert.equal(moved.y, 400, 'drag end did not keep the vertical spot');
  assert.deepEqual((await savedLyrics()).position, { x: 160, y: 400 }, 'dragged position was not saved');

  // 3. In-window style panel: opening it grows the window upwards and keeps the text anchored.
  // The control strip only appears while the pointer is over the overlay.
  await lyrics.hover('.lyrics-body');
  await lyrics.click('#lyrics-style');
  await new Promise(resolve => setTimeout(resolve, 500));
  const opened = await boundsOf(app);
  assert.equal(opened.height, moved.height + PANEL_HEIGHT, 'panel did not enlarge the window');
  assert.equal(opened.y + opened.height, moved.y + moved.height, 'panel pushed the lyrics out of place');
  assert.equal(await lyrics.locator('#lyrics-panel').isVisible(), true, 'style panel did not open');

  // 4. Font size and width are live: the window is re-sized from the bottom edge.
  await lyrics.locator('#opt-size').fill('58');
  await new Promise(resolve => setTimeout(resolve, 600));
  const bigger = await boundsOf(app);
  assert.ok(bigger.height > moved.height + PANEL_HEIGHT, 'font size did not grow the window');
  assert.equal(bigger.y + bigger.height, moved.y + moved.height, 'font size change shifted the lyrics');
  assert.equal((await savedLyrics()).fontSize, 58, 'font size was not saved');

  await lyrics.locator('#opt-width').fill('900');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal((await boundsOf(app)).width, 900, 'width slider did not resize the window');
  assert.equal((await savedLyrics()).width, 900, 'width was not saved');

  // 5. Colour swatches drive the CSS variable and the stored colour.
  await lyrics.locator('#opt-colors button[data-color="#ffe680"]').click();
  await lyrics.waitForFunction(() => document.documentElement.style.getPropertyValue('--lyrics-font-color') === '#ffe680');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await savedLyrics()).fontColor, '#ffe680', 'colour was not saved');

  // 6. The plate is opt-in: enabling it paints a background, disabling it clears it again.
  await lyrics.locator('#opt-bg').check();
  await new Promise(resolve => setTimeout(resolve, 400));
  const tinted = await lyrics.locator('.lyrics-body').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.doesNotMatch(tinted, /rgba\(0, 0, 0, 0\)|transparent/, 'enabling the plate painted nothing');
  if (process.env.CAPTURE_PANEL) await lyrics.screenshot({ path: process.env.CAPTURE_PANEL });
  await lyrics.locator('#opt-bg').uncheck();
  await new Promise(resolve => setTimeout(resolve, 400));
  const cleared = await lyrics.locator('.lyrics-body').evaluate(el => getComputedStyle(el).backgroundColor);
  assert.match(cleared, /rgba\(0, 0, 0, 0\)|transparent/, 'disabling the plate left a background');

  // 7. 完成 collapses the panel; the window returns to text-only height.
  await lyrics.click('#opt-done');
  await new Promise(resolve => setTimeout(resolve, 500));
  const done = await boundsOf(app);
  assert.equal(done.height, bigger.height - PANEL_HEIGHT, 'panel did not collapse');
  assert.equal(await lyrics.locator('#lyrics-panel').isVisible(), false, 'style panel stayed visible');

  // 8. Locking hides every control and drops the plate, so what remains is text only.
  await lyrics.hover('.lyrics-body');
  await lyrics.click('#lyrics-lock');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await lyrics.locator('#lyrics-bar').isVisible(), false, 'control strip stayed visible while locked');
  assert.equal(await lyrics.locator('.lyrics-body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)');
  const locked = await savedLyrics();
  assert.equal(locked.locked, true, 'lock state was not saved');
  assert.equal(locked.showBackground, false);
  if (process.env.CAPTURE_BARE) await lyrics.screenshot({ path: process.env.CAPTURE_BARE });

  // 9. The main window settings surface exposes the same controls and drives the same window.
  await page.getByRole('button', { name: '设置' }).click();
  // The tab shares its label with the transport buttons, so scope the click to the settings nav.
  await page.locator('.settings-nav-item').filter({ hasText: '播放' }).click();
  const sizeSlider = page.getByRole('slider', { name: '歌词字号' });
  await sizeSlider.scrollIntoViewIfNeeded();
  if (process.env.CAPTURE_SETTINGS) await page.screenshot({ path: process.env.CAPTURE_SETTINGS });
  assert.equal(await sizeSlider.inputValue(), '58', 'settings page did not read the overlay font size');
  await sizeSlider.fill('30');
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal((await savedLyrics()).fontSize, 30, 'settings page font size did not reach the overlay');
  assert.ok((await boundsOf(app)).height < done.height, 'overlay did not shrink for the smaller font');

  await page.getByRole('button', { name: '重置歌词位置' }).click();
  await new Promise(resolve => setTimeout(resolve, 700));
  const reset = await boundsOf(app);
  const workArea = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  assert.equal(reset.x, Math.round(workArea.x + (workArea.width - reset.width) / 2), 'reset position is not centred');
  // A cleared spot means "default": the window centres itself again on every start.
  assert.equal((await savedLyrics()).position, null, 'reset position did not clear the stored spot');

  console.log('Desktop lyrics regression passed.');
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
