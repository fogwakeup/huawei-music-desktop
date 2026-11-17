// The mini bar is a frameless window with a deliberately tiny preload: it receives only
// rendered text, a sanitized cover URL and booleans. Nothing here can carry credentials,
// playback URLs or IPC handles into that window.
import { isSafeResourceUrl } from '../safe-media-url.mjs';

const text = (value, max) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : '';

/** @returns {import('../shared/types').MiniPlayerState | null} */
export function sanitizeMiniPlayerState(input) {
  if (!input || typeof input !== 'object') return null;
  const raw = input;
  const coverUrl = typeof raw.coverUrl === 'string' && isSafeResourceUrl(raw.coverUrl) ? raw.coverUrl : null;
  return {
    hasTrack: raw.hasTrack === true,
    title: text(raw.title, 200),
    artist: text(raw.artist, 200),
    coverUrl,
    playing: raw.playing === true,
    favorite: raw.favorite === true,
    desktopLyrics: raw.desktopLyrics === true,
  };
}
