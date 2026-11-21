import { stat, readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { MAX_BACKGROUND_IMAGE_BYTES, MAX_BACKGROUND_IMAGE_DATA_URL } from './settings.mjs';

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
 * The native picker itself is handled by the caller.
 */
export async function readBackgroundImage(path) {
  const mime = MIME_BY_EXT[extname(path).toLowerCase()];
  if (!mime) throw new Error('请选择 PNG、JPG、WebP 或 GIF 图片');
  const info = await stat(path);
  if (!info.isFile()) throw new Error('这不是一个图片文件');
  if (info.size < 1) throw new Error('图片文件是空的');
  if (info.size > MAX_BACKGROUND_IMAGE_BYTES) throw new Error('图片过大（上限 3 MB）');
  const base64 = (await readFile(path)).toString('base64');
  const dataUrl = `data:${mime};base64,${base64}`;
  // Same cap the settings sanitizer applies. Checking the *encoded* length here means whatever
  // the picker returns is guaranteed to survive sanitizeGlass — no more silent "upload did nothing".
  if (dataUrl.length > MAX_BACKGROUND_IMAGE_DATA_URL) throw new Error('图片过大（编码后超出上限）');
  return dataUrl;
}
