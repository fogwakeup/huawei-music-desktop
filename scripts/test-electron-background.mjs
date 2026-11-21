// Regression for the "uploaded but nothing changed" background bug.
// Root cause: Chromium silently drops a CSS declaration value of 2^21 characters or more, so a
// large photo landed in settings.json but the backdrop stayed blank. This test drives the REAL
// main-process stack (no IPC fixtures): a huge image must be squeezed before it is stored, and the
// renderer must end up with a --bg-image value it can actually paint.
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as playwright } from 'playwright-core';

process.umask(0o077);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'huawei-bg-e2e-'));
const CSS_CEILING = 2 * 1024 * 1024;
let app;

try {
  app = await playwright.launch({
    executablePath: electron,
    args: [`--user-data-dir=${profile}`, join(repoRoot, 'out/main/index.js')],
    cwd: repoRoot,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1500);

  // Build a genuinely large image inside the main process: pseudo-random pixels defeat PNG
  // compression, so the encoded data URL comfortably exceeds the 2 MiB CSS ceiling.
  const width = 1500;
  const height = 1500;
  const hugeUrl = await app.evaluate(({ nativeImage }, size) => {
    const buffer = Buffer.alloc(size.width * size.height * 4);
    let seed = 123456789;
    for (let i = 0; i < buffer.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      buffer[i] = (seed >>> 15) & 0xff;
    }
    const image = nativeImage.createFromBuffer(buffer, size);
    return `data:image/png;base64,${image.toPNG().toString('base64')}`;
  }, { width, height });
  assert.ok(hugeUrl.length > CSS_CEILING, `fixture ${hugeUrl.length} must exceed the CSS ceiling`);

  const result = await page.evaluate(async url => {
    const current = await window.desktop.settings.get();
    return window.desktop.settings.update({ glass: { ...current.data.glass, backgroundImage: url } });
  }, hugeUrl);
  assert.equal(result.ok, true, 'settings:update rejected the large image');

  const saved = result.data.glass.backgroundImage;
  assert.ok(saved.length > 0, 'background image was dropped entirely');
  assert.ok(saved.length <= CSS_CEILING, `stored image ${saved.length} is still above the CSS ceiling`);

  // The renderer must be able to paint it after a boot: an oversized value would be stored but the
  // property never appears in the computed style, which is exactly the bug this covers.
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg-image').length > 0,
    undefined, { timeout: 15_000 });
  const painted = await page.evaluate(() => {
    const value = document.documentElement.style.getPropertyValue('--bg-image');
    const backdrop = document.querySelector('.app-backdrop');
    return { len: value.length, head: value.slice(0, 12), startsWith: value.startsWith('url('), computed: backdrop ? getComputedStyle(backdrop).backgroundImage : '' };
  });
  assert.ok(painted.len > 0 && painted.len <= CSS_CEILING, `--bg-image length ${painted.len}`);
  assert.equal(painted.startsWith, true, `unexpected --bg-image value: ${painted.head}`);
  assert.equal(painted.computed.startsWith('url("data:image/'), true, 'backdrop layer is not painting the image');

  // settings.json must not balloon to megabytes of base64 either.
  await page.waitForTimeout(600);
  const size = (await stat(join(profile, 'settings.json'))).size;
  assert.ok(size < 1_500_000, `settings.json is ${size} bytes — the image was not squeezed`);

  // Clearing still clears (an explicit empty string must not be treated as "keep the old one").
  const cleared = await page.evaluate(async () => {
    const current = await window.desktop.settings.get();
    return window.desktop.settings.update({ glass: { ...current.data.glass, backgroundImage: '' } });
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.data.glass.backgroundImage, '');
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--bg-image') === 'none',
    undefined, { timeout: 15_000 });

  console.log('background upload regression passed');
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
