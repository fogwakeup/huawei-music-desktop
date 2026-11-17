// Pure settings/queue sanitation so persisted JSON can never widen the IPC contract.
/** @type {import('../shared/types').AppSettings} */
export const DEFAULT_SETTINGS = Object.freeze({
  // Closing the window keeps music playing in the tray by default; the settings page can
  // still switch back to a real quit.
  closeBehavior: 'tray',
  quality: 'standard',
  volume: 0.85,
  repeatMode: 'off',
  shuffle: false,
  syncHistory: true,
  thirdPartyLyrics: true,
  appearance: Object.freeze({
    accent: 'red',
    panelOpacity: 1,
    cornerRadius: 11,
    fontScale: 1,
    fontFamily: 'sans',
    customAccent: '#c8202e',
    customFont: '',
  }),
  glass: Object.freeze({
    blur: 0,
    opacity: 0.1,
    saturate: 0.51,
    backgroundColor: '#ffEBEB',
    radius: 20,
    borderWidth: 0.5,
    borderColor: '#ffEBEB',
    borderOpacity: 0.3,
    shadowSize: 7,
    shadowOpacity: 0.15,
    backgroundImage: '',
  }),
  shortcuts: Object.freeze({
    'play-pause': 'Control+Alt+P',
    next: 'Control+Alt+Right',
    previous: 'Control+Alt+Left',
    'volume-up': 'Control+Alt+Up',
    'volume-down': 'Control+Alt+Down',
    mute: 'Control+Alt+M',
    like: 'Control+Alt+L',
  }),
  // Bare text by default: the old always-on dark plate read as a black box over the desktop.
  desktopLyrics: Object.freeze({
    enabled: true, locked: false, position: null,
    fontColor: '#ffffff', showBackground: false, backgroundOpacity: 0.55,
    fontSize: 34, width: 760,
  }),
  miniPlayer: Object.freeze({ enabled: true, position: null, embedInTaskbar: true, taskbarX: null }),
});

import { isSafeResourceUrl } from '../safe-media-url.mjs';
import { sanitizeShortcuts } from '../shared/shortcuts.mjs';
import { QUALITY_ORDER } from '../shared/qualities.mjs';
const CLOSE_BEHAVIORS = new Set(['quit', 'tray']);
const QUALITIES = new Set(QUALITY_ORDER);
const REPEAT_MODES = new Set(['off', 'all', 'one']);
const ACCENTS = new Set(['red', 'blue', 'green', 'amber', 'violet', 'custom']);
const FONT_CHOICES = new Set(['sans', 'serif', 'mono', 'custom']);
const HEX_COLOR = /^#[0-9a-f]{6}$/i;
// A background image is stored inline in settings.json. Only small, fixed-format image data URLs
// are accepted so a tampered settings file can never inject script or bloat the store.
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;
const MAX_IMAGE_DATA_URL = 4 * 1024 * 1024; // ~3 MB decoded image

function isSafeImageDataUrl(value) {
  return typeof value === 'string' && value.length <= MAX_IMAGE_DATA_URL && IMAGE_DATA_URL.test(value);
}

function clampNumber(value, min, max, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

/** @returns {import('../shared/types').AppearanceSettings} */
export function sanitizeAppearance(input, fallback = DEFAULT_SETTINGS.appearance) {
  const base = { ...DEFAULT_SETTINGS.appearance, ...(fallback ?? {}) };
  if (!input || typeof input !== 'object') return base;
  const raw = /** @type {Record<string, unknown>} */ (input);
  return {
    accent: ACCENTS.has(raw.accent) ? /** @type {import('../shared/types').AccentName} */ (raw.accent) : base.accent,
    panelOpacity: clampNumber(raw.panelOpacity, 0.55, 1, base.panelOpacity),
    cornerRadius: clampNumber(raw.cornerRadius, 0, 18, base.cornerRadius),
    fontScale: clampNumber(raw.fontScale, 0.85, 1.2, base.fontScale),
    fontFamily: FONT_CHOICES.has(raw.fontFamily) ? /** @type {import('../shared/types').FontChoice} */ (raw.fontFamily) : base.fontFamily,
    customAccent: typeof raw.customAccent === 'string' && HEX_COLOR.test(raw.customAccent) ? raw.customAccent.toLowerCase() : base.customAccent,
    // A font family name is only ever injected into a CSS font-family list, so strip anything that
    // could break out of the quoted string and cap the length.
    customFont: typeof raw.customFont === 'string'
      ? raw.customFont.replace(/["'\\;{}<>]/g, '').trim().slice(0, 80)
      : base.customFont,
  };
}

/** @returns {import('../shared/types').GlassSettings} */
export function sanitizeGlass(input, fallback = DEFAULT_SETTINGS.glass) {
  const base = { ...DEFAULT_SETTINGS.glass, ...(fallback ?? {}) };
  if (!input || typeof input !== 'object') return base;
  const raw = /** @type {Record<string, unknown>} */ (input);
  return {
    blur: clampNumber(raw.blur, 0, 40, base.blur),
    opacity: clampNumber(raw.opacity, 0, 1, base.opacity),
    saturate: clampNumber(raw.saturate, 0, 2, base.saturate),
    backgroundColor: typeof raw.backgroundColor === 'string' && HEX_COLOR.test(raw.backgroundColor)
      ? raw.backgroundColor.toLowerCase() : base.backgroundColor,
    radius: clampNumber(raw.radius, 0, 40, base.radius),
    borderWidth: clampNumber(raw.borderWidth, 0, 8, base.borderWidth),
    borderColor: typeof raw.borderColor === 'string' && HEX_COLOR.test(raw.borderColor)
      ? raw.borderColor.toLowerCase() : base.borderColor,
    borderOpacity: clampNumber(raw.borderOpacity, 0, 1, base.borderOpacity),
    shadowSize: clampNumber(raw.shadowSize, 0, 40, base.shadowSize),
    shadowOpacity: clampNumber(raw.shadowOpacity, 0, 1, base.shadowOpacity),
    backgroundImage: isSafeImageDataUrl(raw.backgroundImage) ? raw.backgroundImage : '',
  };
}

/**
 * @template {import('../shared/types').AppSettings} T
 * @param {unknown} input
 * @param {T} [fallback]
 * @returns {T}
 */
export function sanitizeSettings(input, fallback = DEFAULT_SETTINGS) {
  const base = { ...DEFAULT_SETTINGS, ...(fallback ?? {}) };
  if (!input || typeof input !== 'object') return base;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const next = { ...base };
  if (CLOSE_BEHAVIORS.has(raw.closeBehavior)) next.closeBehavior = /** @type {'quit' | 'tray'} */ (raw.closeBehavior);
  if (QUALITIES.has(raw.quality)) next.quality = /** @type {'standard' | 'lossless'} */ (raw.quality);
  if (REPEAT_MODES.has(raw.repeatMode)) next.repeatMode = /** @type {'off' | 'all' | 'one'} */ (raw.repeatMode);
  if (typeof raw.shuffle === 'boolean') next.shuffle = raw.shuffle;
  if (typeof raw.syncHistory === 'boolean') next.syncHistory = raw.syncHistory;
  if (typeof raw.thirdPartyLyrics === 'boolean') next.thirdPartyLyrics = raw.thirdPartyLyrics;
  if (typeof raw.volume === 'number' && Number.isFinite(raw.volume)) {
    next.volume = Math.min(1, Math.max(0, raw.volume));
  }
  if (raw.appearance && typeof raw.appearance === 'object') {
    next.appearance = sanitizeAppearance(raw.appearance, base.appearance);
  }
  if (raw.glass !== undefined) {
    next.glass = sanitizeGlass(raw.glass, base.glass);
  }
  if (raw.shortcuts !== undefined) {
    next.shortcuts = sanitizeShortcuts(raw.shortcuts, base.shortcuts);
  }
  if (raw.desktopLyrics !== undefined) {
    next.desktopLyrics = sanitizeDesktopLyrics(raw.desktopLyrics, base.desktopLyrics);
  }
  if (raw.miniPlayer !== undefined) {
    next.miniPlayer = sanitizeMiniPlayer(raw.miniPlayer, base.miniPlayer);
  }
  return next;
}

/** @returns {import('../shared/types').DesktopLyricsSettings} */
export function sanitizeDesktopLyrics(input, fallback = DEFAULT_SETTINGS.desktopLyrics) {
  // Defaults first: settings stored before a field existed must still yield a complete object.
  const base = { ...DEFAULT_SETTINGS.desktopLyrics, ...(fallback ?? {}) };
  if (!input || typeof input !== 'object') return base;
  const raw = /** @type {Record<string, unknown>} */ (input);
  // An omitted position must keep the stored one: style patches from the overlay carry only the
  // look-and-feel keys, and treating that as "no position" would drop the lyrics back to the
  // default spot on every slider drag. An explicit null still means "reset".
  const position = raw.position === undefined ? base.position
    : raw.position && typeof raw.position === 'object' && Number.isInteger(raw.position.x)
      && Number.isInteger(raw.position.y) && Math.abs(raw.position.x) <= 32768 && Math.abs(raw.position.y) <= 32768
      ? { x: raw.position.x, y: raw.position.y } : null;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    locked: typeof raw.locked === 'boolean' ? raw.locked : base.locked,
    position,
    fontColor: typeof raw.fontColor === 'string' && HEX_COLOR.test(raw.fontColor) ? raw.fontColor.toLowerCase() : base.fontColor,
    showBackground: typeof raw.showBackground === 'boolean' ? raw.showBackground : base.showBackground,
    backgroundOpacity: clampNumber(raw.backgroundOpacity, 0, 1, base.backgroundOpacity),
    // The window is sized from these two, so they are clamped to a range that stays readable on a
    // 1366-wide screen and never taller than a typical work area.
    fontSize: Math.round(clampNumber(raw.fontSize, 16, 96, base.fontSize)),
    width: Math.round(clampNumber(raw.width, 280, 2400, base.width)),
  };
}

/** @returns {import('../shared/types').MiniPlayerSettings} */
export function sanitizeMiniPlayer(input, fallback = DEFAULT_SETTINGS.miniPlayer) {
  const base = { ...DEFAULT_SETTINGS.miniPlayer, ...(fallback ?? {}) };
  if (!input || typeof input !== 'object') return base;
  const raw = /** @type {Record<string, unknown>} */ (input);
  const position = raw.position && typeof raw.position === 'object' && Number.isInteger(raw.position.x)
    && Number.isInteger(raw.position.y) && Math.abs(raw.position.x) <= 32768 && Math.abs(raw.position.y) <= 32768
    ? { x: raw.position.x, y: raw.position.y } : null;
  // The taskbar anchor is a single coordinate along the bar; anything outside a plausible
  // multi-monitor span is dropped so a stale value can never park the strip off-screen.
  const taskbarX = Number.isInteger(raw.taskbarX) && Math.abs(raw.taskbarX) <= 32768 ? raw.taskbarX : null;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : base.enabled,
    position,
    embedInTaskbar: typeof raw.embedInTaskbar === 'boolean' ? raw.embedInTaskbar : base.embedInTaskbar,
    taskbarX,
  };
}

const MAX_QUEUE_TRACKS = 10000;

function sanitizeQualities(value) {
  if (!Array.isArray(value)) return undefined;
  const byQuality = new Map();
  for (const item of value) {
    const quality = item && typeof item === 'object' ? item.quality : undefined;
    if (typeof quality !== 'string' || !QUALITIES.has(quality) || byQuality.has(quality)) continue;
    byQuality.set(quality, {
      quality,
      format: typeof item.format === 'string' && item.format ? item.format : undefined,
      fileSize: typeof item.fileSize === 'number' && Number.isFinite(item.fileSize) && item.fileSize >= 0 ? item.fileSize : undefined,
    });
  }
  if (!byQuality.size) return undefined;
  return QUALITY_ORDER.filter(quality => byQuality.has(quality)).map(quality => byQuality.get(quality));
}

function sanitizeTrack(value) {
  if (!value || typeof value !== 'object') return null;
  const id = typeof value.id === 'string' ? value.id : '';
  const title = typeof value.title === 'string' ? value.title : '';
  if (!id || !title || id.length > 200) return null;
  const artists = Array.isArray(value.artists)
    ? value.artists.map(artist => {
      const name = typeof artist?.name === 'string' ? artist.name : '';
      if (!name) return null;
      return typeof artist?.id === 'string' ? { id: artist.id, name } : { name };
    }).filter(artist => !!artist).slice(0, 10)
    : [];
  const album = value.album && typeof value.album.id === 'string' && typeof value.album.title === 'string'
    ? { id: value.album.id, title: value.album.title } : undefined;
  const track = {
    id, title, artists, album,
    coverUrl: typeof value.coverUrl === 'string' && isSafeResourceUrl(value.coverUrl) ? value.coverUrl : undefined,
    durationSeconds: typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds)
      ? value.durationSeconds : undefined,
    available: value.available !== false,
  };
  const qualities = sanitizeQualities(value.qualities);
  if (qualities) track.qualities = qualities;
  return track;
}

/** @returns {import('../shared/types').SavedQueue | null} */
export function sanitizeQueue(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.tracks)) return null;
  const tracks = input.tracks.map(sanitizeTrack).filter(track => !!track).slice(0, MAX_QUEUE_TRACKS);
  if (!tracks.length) return null;
  const index = Number.isInteger(input.index) && input.index >= 0 && input.index < tracks.length ? input.index : 0;
  const positionSeconds = typeof input.positionSeconds === 'number' && Number.isFinite(input.positionSeconds) && input.positionSeconds >= 0
    ? input.positionSeconds : 0;
  return { tracks, index, positionSeconds };
}
