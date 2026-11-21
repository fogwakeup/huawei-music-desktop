import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBackgroundImage } from '../src/main/background-image.mjs';
import { sanitizeGlass } from '../src/main/settings.mjs';
import { MAX_BACKGROUND_IMAGE_BYTES } from '../src/main/settings.mjs';

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

test('a full-size image accepted by the picker survives the settings sanitizer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-image-limit-'));
  try {
    const file = join(dir, 'big.png');
    // Exactly the picker's raw cap: base64 inflates to ~4 MB. This used to be silently dropped
    // by sanitizeGlass because its 4 MB cap was smaller than the picker's encoded output.
    await writeFile(file, Buffer.alloc(MAX_BACKGROUND_IMAGE_BYTES, 7));
    const dataUrl = await readBackgroundImage(file);
    const stored = sanitizeGlass({ backgroundImage: dataUrl }).backgroundImage;
    assert.equal(stored, dataUrl, 'a picked image must never be discarded by sanitizeGlass');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readBackgroundImage rejects unsupported/empty files and directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bg-image-'));
  try {
    const svg = join(dir, 'pic.svg');
    await writeFile(svg, '<svg></svg>');
    await assert.rejects(() => readBackgroundImage(svg), /PNG/);

    const empty = join(dir, 'empty.png');
    await writeFile(empty, '');
    await assert.rejects(() => readBackgroundImage(empty), /空的/);

    const subdir = join(dir, 'folder.png');
    await mkdir(subdir);
    await assert.rejects(() => readBackgroundImage(subdir), /不是一个图片文件/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
