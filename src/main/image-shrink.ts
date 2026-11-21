import { nativeImage } from 'electron';

// Chromium ignores a CSS declaration value of 2^21 characters or more, so a background data URL
// that big is saved to settings.json but never painted — the user sees "uploaded, nothing changed".
// Every pick therefore gets squeezed into a small budget before it is stored.
const STEPS = [
  { width: 2560, quality: 88 },
  { width: 1920, quality: 84 },
  { width: 1600, quality: 78 },
  { width: 1280, quality: 70 },
  { width: 1024, quality: 62 },
];

/**
 * Re-encodes an oversized background data URL until it fits `limit` characters.
 * Returns null when the input is not a decodable image or cannot be squeezed small enough.
 * PNG sources keep their alpha channel while a PNG encoding still fits; otherwise JPEG is used.
 */
export function shrinkBackgroundImageDataUrl(dataUrl: unknown, limit: number): string | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  let image: Electron.NativeImage;
  try {
    image = nativeImage.createFromDataURL(dataUrl);
  } catch {
    return null;
  }
  if (!image || image.isEmpty()) return null;
  const width = image.getSize().width;
  const keepAlpha = dataUrl.startsWith('data:image/png');
  for (const step of STEPS) {
    const scaled = width > step.width ? image.resize({ width: step.width, quality: 'good' }) : image;
    if (keepAlpha) {
      const png = scaled.toPNG();
      if (png?.length) {
        const encoded = `data:image/png;base64,${png.toString('base64')}`;
        if (encoded.length <= limit) return encoded;
      }
    }
    const jpeg = scaled.toJPEG(step.quality);
    if (!jpeg?.length) continue;
    const encoded = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    if (encoded.length <= limit) return encoded;
  }
  return null;
}
