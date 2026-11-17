// Offline regression for the taskbar presentation of the transport bar: the window must sit on
// the taskbar band (not above it, not under it), survive a mode switch through the real settings
// pipeline, and snap back onto the band when something moves it.
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as playwright } from 'playwright-core';

process.umask(0o077);
const profile = await mkdtemp(join(tmpdir(), 'huawei-taskbar-profile-'));
// Pre-seed the real settings store: this suite exercises the production settings pipeline, so the
// mode switch in the UI must reach the mini-player module for real (no IPC fixtures for settings).
await writeFile(join(profile, 'settings.json'), JSON.stringify({
  closeBehavior: 'tray',
  desktopLyrics: {
    enabled: true, locked: false, position: null, fontColor: '#ffffff',
    showBackground: false, backgroundOpacity: 0.55, fontSize: 34, width: 760,
  },
  miniPlayer: { enabled: true, position: null, embedInTaskbar: true, taskbarX: null },
}), 'utf8');

const miniPageOf = async app => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const window = app.windows().find(candidate => candidate.url().includes('mini.html'));
    if (window) return window;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('mini transport window was never created');
};

const geometryOf = app => app.evaluate(({ BrowserWindow, screen }) => {
  const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('mini.html'));
  if (!window) return null;
  const display = screen.getPrimaryDisplay();
  return {
    bounds: window.getBounds(),
    display: display.bounds,
    workArea: display.workArea,
    alwaysOnTop: window.isAlwaysOnTop(),
    visible: window.isVisible(),
  };
});

let app;
try {
  app = await playwright.launch({
    executablePath: electron,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`, 'out/main/index.js'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Only auth is stubbed; settings stay real so the UI drives the actual module.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('auth:status');
    ipcMain.handle('auth:status', () => ({ ok: true, data: { authenticated: true, persistence: 'memory-only' } }));
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');

  const mini = await miniPageOf(app);
  await mini.waitForLoadState('domcontentloaded');
  assert.ok(await mini.evaluate(() => document.body.classList.contains('mode-taskbar')), 'mini bar not rendered in taskbar mode');

  const geometry = await geometryOf(app);
  assert.ok(geometry, 'mini window disappeared');
  assert.equal(geometry.visible, true, 'mini bar must be visible');
  assert.equal(geometry.alwaysOnTop, true, 'mini bar must stay above the taskbar');

  const taskbarThickness = geometry.display.height - geometry.workArea.height;
  const taskbarTop = geometry.workArea.y + geometry.workArea.height;
  if (taskbarThickness > 0) {
    // The whole point of the redesign: the strip lives ON the taskbar band.
    assert.ok(geometry.bounds.y >= taskbarTop, `bar top ${geometry.bounds.y} must be on the taskbar (>= ${taskbarTop})`);
    assert.ok(geometry.bounds.y + geometry.bounds.height <= geometry.display.y + geometry.display.height,
      'bar must not spill below the screen');
    assert.ok(geometry.bounds.height <= taskbarThickness, 'bar must not be taller than the taskbar');
    assert.ok(geometry.bounds.height >= 24, 'bar must stay usable at small taskbar sizes');
  }

  if (process.env.CAPTURE_DESKTOP) {
    const shot = await app.evaluate(async ({ desktopCapturer, screen }) => {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: display.bounds.width, height: display.bounds.height },
      });
      const match = sources.find(source => String(source.display_id) === String(display.id)) ?? sources[0];
      return match?.thumbnail.toDataURL() ?? null;
    });
    if (shot) {
      await writeFile(process.env.CAPTURE_DESKTOP, Buffer.from(shot.split(',')[1], 'base64'));
      console.log(`Desktop capture written to ${process.env.CAPTURE_DESKTOP}`);
    }
  }
  if (process.env.CAPTURE_BAR) await mini.screenshot({ path: process.env.CAPTURE_BAR, omitBackground: false });

  // The strip is non-focusable, so its controls must still receive clicks.
  await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('index.html'));
    main?.hide();
  });
  await new Promise(resolve => setTimeout(resolve, 300));
  await mini.click('[data-action="show-main"]');
  await new Promise(resolve => setTimeout(resolve, 600));
  const mainVisible = await app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('index.html'));
    return !!main && main.isVisible();
  });
  assert.equal(mainVisible, true, 'toolbar button did not reach the app (non-focusable window lost the click)');

  // Programmatic move: the strip must snap back onto the band and keep the horizontal anchor.
  const before = geometry.bounds;
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('mini.html'));
    window.setBounds({ x: window.getBounds().x + 90, y: window.getBounds().y - 14, width: window.getBounds().width, height: window.getBounds().height });
  });
  await new Promise(resolve => setTimeout(resolve, 600));
  const afterMove = (await geometryOf(app)).bounds;
  assert.equal(afterMove.y, before.y, 'vertical drift must snap back onto the taskbar band');
  assert.equal(afterMove.x, before.x + 90, 'horizontal slide along the taskbar is kept');

  // Mode switch through the real settings page: the module must rebuild in the floating layout.
  await page.getByRole('button', { name: '设置' }).click();
  if (process.env.CAPTURE_SETTINGS) {
    await page.waitForTimeout(400);
    await page.screenshot({ path: process.env.CAPTURE_SETTINGS });
  }
  await page.getByLabel('播控条样式').selectOption('float');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const floatMini = await miniPageOf(app);
  assert.ok(await floatMini.evaluate(() => document.body.classList.contains('mode-float')), 'mode switch did not rebuild the bar');
  const floatGeometry = await geometryOf(app);
  assert.ok(floatGeometry.bounds.y + floatGeometry.bounds.height <= floatGeometry.workArea.y + floatGeometry.workArea.height,
    'floating capsule must stay inside the work area');
  assert.ok(floatGeometry.bounds.height > 50, 'floating capsule keeps its taller capsule layout');

  // And back: the taskbar presentation is restored from the same control.
  await page.getByLabel('播控条样式').selectOption('taskbar');
  await new Promise(resolve => setTimeout(resolve, 1200));
  const restored = await miniPageOf(app);
  assert.ok(await restored.evaluate(() => document.body.classList.contains('mode-taskbar')), 'switching back did not restore the strip');
  const restoredGeometry = await geometryOf(app);
  if (taskbarThickness > 0) {
    assert.ok(restoredGeometry.bounds.y >= taskbarTop, 'restored strip must be back on the taskbar');
  }

  console.log('Taskbar transport regression passed:', JSON.stringify({ taskbarThickness, geometry: geometry.bounds, float: floatGeometry.bounds }));
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
}
