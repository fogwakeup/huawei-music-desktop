import { stat, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { MAX_BACKGROUND_IMAGE_BYTES } from './settings.mjs';

// Maps the file formats we accept to their data-URL MIME. Only raster images the renderer can
// paint as a CSS background are allowed; SVG is excluded because it can carry script.
const MIME_BY_EXT = Object.freeze({
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
});
/**
 * Reads a user-picked image and returns a strict data URL, or throws with a user-facing message.
 * The native picker itself is handled by the caller. The returned value may still be larger than
 * the CSS budget — callers must pass it through shrinkBackgroundImageDataUrl() before storing it,
 * because Chromium drops CSS values of 2^21 characters or more without any error.
 */
export async function readBackgroundImage(path) {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('这不是一个图片文件');
  if (info.size < 1) throw new Error('图片文件是空的');
  if (info.size > MAX_BACKGROUND_IMAGE_BYTES) {
    throw new Error(`图片过大（上限 ${Math.round(MAX_BACKGROUND_IMAGE_BYTES / 1024 / 1024)} MB）`);
  }
  const base64 = (await readFile(path)).toString('base64');
  return `data:${mime};base64,${base64}`;
}
