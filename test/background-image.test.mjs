import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBackgroundImage } from '../src/main/background-image.mjs';
import {
  CSS_DECLARATION_VALUE_LIMIT, MAX_BACKGROUND_IMAGE_BYTES, MAX_BACKGROUND_IMAGE_DATA_URL, sanitizeGlass,
} from '../src/main/settings.mjs';

test('readBackgroundImage encodes supported raster formats as strict data URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-image-'));
  try {
    for (const [ext, mime] of [['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif']]) {
      const file = join(dir, `pic${ext}`);
      await writeFile(file, Buffer.from('fake-image-bytes'));
      const dataUrl = await readBackgroundImage(file);
      assert.equal(dataUrl.startsWith(`data:${mime};base64,`), true);
      assert.equal(Buffer.from(dataUrl.split(',')[1], 'base64').toString(), 'fake-image-bytes');
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the stored background budget stays clear of the Chromium CSS value ceiling', () => {
  // Chromium silently ignores CSS declaration values of 2^21 characters or more, so anything at
  // or above that ceiling would be stored but never painted. The budget must leave real headroom.
  assert.equal(CSS_DECLARATION_VALUE_LIMIT, 2 * 1024 * 1024);
  assert.ok(MAX_BACKGROUND_IMAGE_DATA_URL < CSS_DECLARATION_VALUE_LIMIT * 0.75,
    `budget ${MAX_BACKGROUND_IMAGE_DATA_URL} is too close to ${CSS_DECLARATION_VALUE_LIMIT}`);
});

test('readBackgroundImage no longer enforces the CSS budget — the shrink step does', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-image-limit-'));
  try {
    const file = join(dir, 'big.png');
    // 3 MB raw -> ~4 MB of base64, i.e. over the stored budget and over the CSS ceiling. Reading
    // must succeed (the main process re-encodes it later); failing here was the old behaviour.
    await writeFile(file, Buffer.alloc(3 * 1024 * 1024, 7));
    const dataUrl = await readBackgroundImage(file);
    assert.ok(dataUrl.length > MAX_BACKGROUND_IMAGE_DATA_URL, 'fixture must exceed the stored budget');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readBackgroundImage rejects files above the raw cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-image-cap-'));
  try {
    const file = join(dir, 'huge.png');
    await writeFile(file, Buffer.alloc(MAX_BACKGROUND_IMAGE_BYTES + 1, 7));
    await assert.rejects(() => readBackgroundImage(file), /图片过大/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('sanitizeGlass keeps a working image when a patch carries an unusable one', () => {
  const previous = `data:image/png;base64,${Buffer.alloc(64, 1).toString('base64')}`;
  // Oversized (would be dropped by Chromium) and malformed values must not wipe the stored image.
  const oversized = `data:image/png;base64,${'A'.repeat(MAX_BACKGROUND_IMAGE_DATA_URL + 10)}`;
  assert.equal(sanitizeGlass({ backgroundImage: oversized }, { backgroundImage: previous }).backgroundImage, previous);
  assert.equal(sanitizeGlass({ backgroundImage: 'not-an-image' }, { backgroundImage: previous }).backgroundImage, previous);
  assert.equal(sanitizeGlass({ blur: 4 }, { backgroundImage: previous }).backgroundImage, previous);
  // An explicit clear still clears.
  assert.equal(sanitizeGlass({ backgroundImage: '' }, { backgroundImage: previous }).backgroundImage, '');
  assert.equal(sanitizeGlass({ backgroundImage: null }, { backgroundImage: previous }).backgroundImage, '');
});
