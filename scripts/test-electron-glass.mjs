// Offline regression for the frosted-glass settings page: sliders, colours, image upload/clear,
// reset, and the CSS variables applied to the document root. No network or account path.
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as playwright } from 'playwright-core';

process.umask(0o077);
const profile = await mkdtemp(join(tmpdir(), 'huawei-glass-profile-'));
const sampleImage = await mkdtemp(join(tmpdir(), 'huawei-glass-image-'));
const imagePath = join(sampleImage, 'bg.png');
// A tiny valid PNG (1x1 red) — enough to exercise the picker -> data URL -> settings path.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
await writeFile(imagePath, Buffer.from(PNG, 'base64'));

const DEFAULT_GLASS = {
  blur: 0, opacity: 0.1, saturate: 0.51, backgroundColor: '#ffEBEB', radius: 20,
  borderWidth: 0.5, borderColor: '#ffEBEB', borderOpacity: 0.3, shadowSize: 7,
  shadowOpacity: 0.15, backgroundImage: '',
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

  // Replace only the three settings-related handlers with in-memory fixtures. Everything else
  // (renderer, CSS, IPC bridge) is the real shipped build.
  await app.evaluate(({ ipcMain }, { defaultGlass, dataUrl }) => {
    const ok = data => ({ ok: true, data });
    const full = () => ({
      closeBehavior: 'tray', quality: 'standard', volume: 0.85, repeatMode: 'off', shuffle: false,
      syncHistory: true, thirdPartyLyrics: true, glass: { ...globalThis.__glass },
      appearance: { accent: 'red', panelOpacity: 1, cornerRadius: 11, fontScale: 1, fontFamily: 'sans', customAccent: '#c8202e', customFont: '' },
      desktopLyrics: {
        enabled: true, locked: false, position: null, fontColor: '#ffffff',
        showBackground: false, backgroundOpacity: 0.55, fontSize: 34, width: 760,
      },
      miniPlayer: { enabled: true, position: null, embedInTaskbar: true, taskbarX: null },
    });
    globalThis.__glass = { ...defaultGlass };
    globalThis.__fullSettings = full;
    for (const channel of ['auth:status', 'settings:get', 'settings:update', 'settings:pick-background']) ipcMain.removeHandler(channel);
    ipcMain.handle('auth:status', () => ok({ authenticated: true, persistence: 'memory-only' }));
    ipcMain.handle('settings:get', () => ok(full()));
    ipcMain.handle('settings:update', (_event, patch) => {
      if (patch?.glass) globalThis.__glass = { ...globalThis.__glass, ...patch.glass };
      return ok(full());
    });
    ipcMain.handle('settings:pick-background', () => ok(dataUrl));
  }, { defaultGlass: DEFAULT_GLASS, dataUrl: `data:image/png;base64,${PNG}` });

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: '设置' }).click();
  await page.getByRole('button', { name: '毛玻璃' }).click();

  // Glass titlebar replaces the opaque native caption, and the header is no longer sticky
  // (a translucent sticky header let scrolled rows show through and overlap its title).
  assert.equal(await page.locator('.window-titlebar').count(), 1, 'glass titlebar missing');
  assert.equal(await page.locator('.window-buttons button').count(), 3, 'window controls missing');
  const headerPosition = await page.locator('.topbar').evaluate(el => getComputedStyle(el).position);
  assert.notEqual(headerPosition, 'sticky', 'settings header must scroll with content');

  // Sliders: drag blur to a mid value and confirm the CSS variable is applied.
  const blur = page.getByRole('slider', { name: '毛玻璃模糊' });
  await blur.waitFor({ timeout: 5000 });
  await blur.fill('16');
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--glass-blur') === '16px');

  // Colour picker feeds the rgb component variables.
  await page.getByLabel('毛玻璃背景色').fill('#123456');
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--glass-bg-r') === '18');

  // Upload -> background image is injected as a url() on the root and stored in settings.
  await page.getByRole('button', { name: '上传背景图片' }).click();
  await page.waitForFunction(() => {
    const value = document.documentElement.style.getPropertyValue('--bg-image');
    return value.startsWith('url("data:image/png;base64,');
  });
  assert.equal(await page.locator('.bg-preview').count(), 1, 'background preview missing after upload');
  const backdropImage = await page.locator('.app-backdrop').evaluate(el => getComputedStyle(el).backgroundImage);
  assert.match(backdropImage, /data:image\/png;base64,/, 'uploaded image not painted on backdrop layer');
  if (process.env.CAPTURE_BG) {
    await page.locator('.main-content').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: process.env.CAPTURE_BG });
  }
  if (process.env.CAPTURE_SCROLL) {
    await page.locator('.main-content').evaluate(el => { el.scrollTop = 220; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: process.env.CAPTURE_SCROLL });
  }

  // Clear removes the image again.
  await page.getByRole('button', { name: '清除背景' }).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg-image') === 'none');

  // Reset restores the defaults (blur 0 etc.).
  await page.getByRole('button', { name: '恢复默认毛玻璃' }).click();
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--glass-blur') === '0px');

  const stored = await app.evaluate(() => globalThis.__glass);
  assert.equal(stored.blur, 0, 'reset did not persist default blur');
  assert.equal(stored.backgroundImage, '', 'reset did not persist empty background');
  assert.equal(stored.backgroundColor, '#ffEBEB');

  const capture = process.env.CAPTURE_GLASS;
  if (capture) {
    await page.locator('.main-content').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: capture });
  }
  console.log('Glass settings regression passed.');
} finally {
  if (app) await app.close().catch(() => undefined);
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  await rm(sampleImage, { recursive: true, force: true }).catch(() => undefined);
}
