import { app, safeStorage } from 'electron';
import * as fs from 'node:fs/promises';
import { clearSession, loadSession, persistenceMode as getPersistenceMode, saveSession } from './session-store.cjs';
import { clearJson, loadJson, saveJson } from './json-store.cjs';
import { DEFAULT_SETTINGS, MAX_BACKGROUND_IMAGE_DATA_URL, sanitizeQueue, sanitizeSettings } from './settings.mjs';
import { shrinkBackgroundImageDataUrl } from './image-shrink';
import { cachedLibraryData, updateLibraryCache } from './library-cache.mjs';
import type { AppSettings, SavedQueue } from '../shared/types';

export type StoredMusicSession = {
  version: 1;
  music: { token: string; snsUserID?: string; expireTime?: string };
  // Refresh credential from the offline OAuth grant, kept next to the music session so a
  // future renewal path can mint fresh sessions without re-scanning. Never logged; the
  // public-client refresh grant itself was rejected by the provider (see
  // docs/token-lifetimes-and-renewal.md), so today this is only collected, not used.
  oauth?: { refreshToken: string };
};

export function persistenceMode(): 'secure' | 'memory-only' {
  return getPersistenceMode(safeStorage);
}

export async function saveMusicSession(session: StoredMusicSession): Promise<boolean> {
  return saveSession(app.getPath('userData'), session, safeStorage, fs);
}

export async function loadMusicSession(): Promise<StoredMusicSession | null> {
  return loadSession(app.getPath('userData'), safeStorage, fs) as Promise<StoredMusicSession | null>;
}

export async function clearMusicSession(): Promise<void> {
  return clearSession(app.getPath('userData'), fs);
}

/**
 * Chromium drops CSS values of 2^21 characters, so a legacy settings.json can hold a background
 * that is stored but never painted. Squeeze anything over budget before it reaches the renderer:
 * without this, someone upgrading from an older build would still see a blank background until
 * they manually picked the picture again.
 */
function fitBackgroundImage(input: unknown): { data: unknown; changed: boolean } {
  if (!input || typeof input !== 'object') return { data: input, changed: false };
  const record = input as Record<string, unknown>;
  const glass = record.glass;
  if (!glass || typeof glass !== 'object') return { data: input, changed: false };
  const image = (glass as Record<string, unknown>).backgroundImage;
  if (typeof image !== 'string' || image.length <= MAX_BACKGROUND_IMAGE_DATA_URL) {
    return { data: input, changed: false };
  }
  const shrunk = shrinkBackgroundImageDataUrl(image, MAX_BACKGROUND_IMAGE_DATA_URL);
  return {
    data: { ...record, glass: { ...(glass as Record<string, unknown>), backgroundImage: shrunk ?? '' } },
    changed: true,
  };
}

export async function loadSettings(): Promise<AppSettings> {
  const stored = await loadJson(app.getPath('userData'), 'settings', DEFAULT_SETTINGS, fs);
  const fitted = fitBackgroundImage(stored);
  const settings = sanitizeSettings(fitted.data) as AppSettings;
  // Write the smaller image back so the oversized legacy data URL stops bloating settings.json.
  if (fitted.changed) await saveJson(app.getPath('userData'), 'settings', settings, fs).catch(() => undefined);
  return settings;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await saveJson(app.getPath('userData'), 'settings', sanitizeSettings(settings), fs);
}

// One-time upgrade for profiles created by older builds whose close button really quit the app.
// A user who later picks "退出程序" is never migrated again.
const TRAY_CLOSE_MIGRATION = 'tray-close-default-v1';
const DESKTOP_LYRICS_MIGRATION = 'desktop-lyrics-on-v1';
export async function migrateCloseBehaviorToTray(): Promise<AppSettings> {
  const settings = await loadSettings();
  if (settings.closeBehavior !== 'quit') return settings;
  const userData = app.getPath('userData');
  const migrated = await loadJson(userData, TRAY_CLOSE_MIGRATION, null, fs) as { v?: number } | null;
  if (migrated?.v === 1) return settings;
  const next = await updateSettings({ closeBehavior: 'tray' });
  await saveJson(userData, TRAY_CLOSE_MIGRATION, { v: 1 }, fs);
  return next;
}

// Older releases shipped desktop lyrics with a hidden, default-off switch. Turn it on once for
// profiles upgrading to this build; a user who later disables it is never migrated again.
export async function migrateDesktopLyricsOn(): Promise<AppSettings> {
  const settings = await loadSettings();
  if (settings.desktopLyrics.enabled) return settings;
  const userData = app.getPath('userData');
  const migrated = await loadJson(userData, DESKTOP_LYRICS_MIGRATION, null, fs) as { v?: number } | null;
  if (migrated?.v === 1) return settings;
  const next = await updateSettings({ desktopLyrics: { ...settings.desktopLyrics, enabled: true } });
  await saveJson(userData, DESKTOP_LYRICS_MIGRATION, { v: 1 }, fs);
  return next;
}

let settingsWrite: Promise<unknown> = Promise.resolve();
export function updateSettings(patch: unknown): Promise<AppSettings> {
  const update = settingsWrite.catch(() => undefined).then(async () => {
    // Legacy or hand-edited patches may still carry an unpaintable image; fit it first so a
    // successful save is always a background the renderer can actually show.
    const fitted = fitBackgroundImage(patch);
    const next = sanitizeSettings(fitted.data, await loadSettings()) as AppSettings;
    await saveSettings(next);
    return next;
  });
  settingsWrite = update;
  return update;
}

export async function loadWriteIntent(): Promise<unknown> {
  return loadJson(app.getPath('userData'), 'write-intent', null, fs);
}
export async function saveWriteIntent(intent: unknown): Promise<void> {
  if (intent === null) await clearJson(app.getPath('userData'), 'write-intent', fs);
  else await saveJson(app.getPath('userData'), 'write-intent', intent, fs);
}

export async function loadQueue(): Promise<SavedQueue | null> {
  const stored = await loadJson(app.getPath('userData'), 'queue', null, fs);
  return sanitizeQueue(stored) as SavedQueue | null;
}

export async function saveQueue(queue: SavedQueue): Promise<void> {
  const sanitized = sanitizeQueue(queue);
  if (!sanitized) { await clearJson(app.getPath('userData'), 'queue', fs); return; }
  await saveJson(app.getPath('userData'), 'queue', sanitized, fs);
}

let cacheWrite = Promise.resolve();
export function cacheLibraryPage(key: string, data: unknown, stillCurrent: () => boolean): Promise<void> {
  cacheWrite = cacheWrite.catch(() => undefined).then(async () => {
    const directory = app.getPath('userData');
    const stored = await loadJson(directory, 'cache', {}, fs);
    // No await between the epoch check and queuing the write: account cleanup is ordered after it.
    if (!stillCurrent()) return;
    await saveJson(directory, 'cache', updateLibraryCache(stored, key, data), fs);
  });
  return cacheWrite;
}

export async function loadCachedLibraryPage(key: string): Promise<unknown> {
  const stored = await loadJson(app.getPath('userData'), 'cache', {}, fs);
  return cachedLibraryData(stored, key);
}

export async function clearPersonalData(): Promise<void> {
  for (const name of ['queue', 'cache', 'history', 'write-intent']) await clearJson(app.getPath('userData'), name, fs);
}
