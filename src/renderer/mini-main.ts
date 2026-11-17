// Desktop mini bar renderer: plain DOM, only text and booleans from the sanitized state.
import type { MiniPlayerCommand, MiniPlayerState } from '../shared/types';

declare global {
  interface Window {
    desktopMiniPlayer: {
      onState(listener: (state: MiniPlayerState) => void): () => void;
      command(command: MiniPlayerCommand): void;
      requestClose(): void;
      savePosition(position: { x: number; y: number }): void;
      dragStart(): void;
      dragMove(): void;
      endDrag(): void;
    };
  }
}

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

// The main process loads this page with ?mode=taskbar|float; the same markup serves both
// presentations, and CSS owns the difference (slim taskbar strip vs floating capsule).
const mode = new URLSearchParams(window.location.search).get('mode') === 'float' ? 'float' : 'taskbar';
document.body.classList.add(`mode-${mode}`);

const title = byId('mini-title');
const artist = byId('mini-artist');
const cover = byId<HTMLImageElement>('mini-cover');
const coverIcon = byId('mini-cover-icon');
const playButton = byId('mini-play');
const likeButton = byId('mini-like');
const lyricsButton = byId('mini-lyrics');
const transport = document.querySelector<HTMLDivElement>('.mini-controls')!;

const PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3v14H7zm7 0h3v14h-3z"/></svg>';

function setIcon(button: HTMLElement, svg: string): void {
  const existing = button.querySelector('svg');
  if (existing) existing.outerHTML = svg;
}

// Track the URL that last failed so a broken cover falls back to the glyph exactly like the
// in-app Cover component, and a new track with a different URL gets a fresh attempt.
let failedCoverUrl: string | null = null;

function showCover(url: string | null): void {
  if (!url || url === failedCoverUrl) {
    cover.removeAttribute('src');
    cover.hidden = true;
    coverIcon.hidden = false;
    return;
  }
  if (cover.getAttribute('src') !== url) cover.src = url;
  cover.hidden = false;
  coverIcon.hidden = true;
}

function applyState(state: MiniPlayerState): void {
  title.textContent = state.hasTrack ? state.title || '未命名歌曲' : '尚未播放';
  artist.textContent = state.hasTrack ? (state.artist || '未知艺人') : '选择一首歌开始播放';
  showCover(state.coverUrl);
  setIcon(playButton, state.playing ? PAUSE_ICON : PLAY_ICON);
  playButton.setAttribute('aria-label', state.playing ? '暂停' : '播放');
  playButton.title = state.playing ? '暂停' : '播放';
  transport.querySelectorAll<HTMLButtonElement>('button[data-action]').forEach(button => {
    const action = button.dataset.action;
    button.disabled = !state.hasTrack && action !== 'close' && action !== 'toggle-desktop-lyrics' && action !== 'show-main';
  });
  likeButton.setAttribute('aria-pressed', String(state.favorite));
  likeButton.classList.toggle('on', state.favorite);
  const likeSvg = likeButton.querySelector('svg');
  if (likeSvg) likeSvg.setAttribute('fill', state.favorite ? 'currentColor' : 'none');
  lyricsButton.setAttribute('aria-pressed', String(state.desktopLyrics));
  lyricsButton.classList.toggle('on', state.desktopLyrics);
  document.body.classList.toggle('has-track', state.hasTrack);
}

cover.addEventListener('error', () => {
  failedCoverUrl = cover.getAttribute('src');
  cover.removeAttribute('src');
  cover.hidden = true;
  coverIcon.hidden = false;
});
// Dragging is handled in the renderer: the bar is deliberately non-focusable so it never steals
// focus from the app in use, and such a window cannot start a native title-bar drag. The renderer
// only reports the gesture; the main process follows the OS cursor, so a window sliding under a
// stationary pointer cannot feed bogus offsets back into the movement.
const handle = byId('mini-info');
let dragging = false;
handle.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  dragging = true;
  handle.setPointerCapture(event.pointerId);
  document.body.classList.add('dragging');
  window.desktopMiniPlayer.dragStart();
});
handle.addEventListener('pointermove', () => {
  if (!dragging) return;
  window.desktopMiniPlayer.dragMove();
});
const stopDragging = (): void => {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  window.desktopMiniPlayer.endDrag();
};
handle.addEventListener('pointerup', stopDragging);
handle.addEventListener('pointercancel', stopDragging);
handle.addEventListener('dblclick', () => window.desktopMiniPlayer.command('show-main'));
transport.addEventListener('click', event => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-action]');
  const action = button?.dataset.action;
  if (!action || button?.disabled) return;
  if (action === 'close') window.desktopMiniPlayer.requestClose();
  else window.desktopMiniPlayer.command(action as MiniPlayerCommand);
});

window.desktopMiniPlayer.onState(applyState);
