// Desktop lyrics overlay: plain DOM (no React) so the floating window stays tiny.
// Locked mode is click-through and paints nothing but the text; unlocked mode adds a small control
// strip (style panel, lock, close) that also acts as the drag handle.
import type { DesktopLyricsAppearance, DesktopLyricsStylePatch, DesktopLyricsUpdate } from '../shared/types';

declare global {
  interface Window {
    desktopLyricsWindow: {
      onUpdate(listener: (payload: DesktopLyricsUpdate) => void): () => void;
      onState(listener: (state: DesktopLyricsAppearance) => void): () => void;
      setLocked(locked: boolean): void;
      requestClose(): void;
      setStyle(patch: DesktopLyricsStylePatch): void;
      setPanelOpen(open: boolean): void;
      dragStart(): void;
      dragMove(): void;
      endDrag(): void;
    };
  }
}

const PALETTE = ['#ffffff', '#ffe680', '#a8d8ff', '#ffb3c8', '#b8f2c9'];
const FONT_DEFAULTS = { fontColor: '#ffffff', showBackground: false, backgroundOpacity: 0.55, fontSize: 34, width: 760 };

const root = document.getElementById('lyrics')!;
const body = document.getElementById('lyrics-body')!;
const trackLabel = document.getElementById('lyrics-track')!;
const currentLine = document.getElementById('lyrics-current')!;
const nextLine = document.getElementById('lyrics-next')!;
const lockButton = document.getElementById('lyrics-lock')!;
const closeButton = document.getElementById('lyrics-close')!;
const styleButton = document.getElementById('lyrics-style')!;
const panel = document.getElementById('lyrics-panel')!;
const sizeInput = document.getElementById('opt-size') as HTMLInputElement;
const sizeValue = document.getElementById('opt-size-value')!;
const widthInput = document.getElementById('opt-width') as HTMLInputElement;
const widthValue = document.getElementById('opt-width-value')!;
const colorRow = document.getElementById('opt-colors')!;
const bgToggle = document.getElementById('opt-bg') as HTMLInputElement;
const opacityInput = document.getElementById('opt-opacity') as HTMLInputElement;
const resetButton = document.getElementById('opt-reset')!;
const doneButton = document.getElementById('opt-done')!;

let state: DesktopLyricsAppearance = { locked: true, ...FONT_DEFAULTS };
let panelOpen = false;
let dragging = false;
// Style edits are coalesced: dragging a slider fires continuously, and each value would otherwise
// become a settings write plus a window resize round trip.
let styleTimer: number | undefined;
let queued: DesktopLyricsStylePatch = {};

function sendStyle(patch: DesktopLyricsStylePatch): void {
  Object.assign(queued, patch);
  window.clearTimeout(styleTimer);
  styleTimer = window.setTimeout(() => {
    const payload = queued;
    queued = {};
    window.desktopLyricsWindow.setStyle(payload);
  }, 120);
}

function paint(): void {
  root.classList.toggle('locked', state.locked);
  root.classList.toggle('has-bg', state.showBackground);
  const style = document.documentElement.style;
  style.setProperty('--lyrics-font-size', `${state.fontSize}px`);
  style.setProperty('--lyrics-next-size', `${Math.max(11, Math.round(state.fontSize * 0.5))}px`);
  style.setProperty('--lyrics-font-color', state.fontColor);
  style.setProperty('--lyrics-bg-opacity', String(state.backgroundOpacity));
}

function syncPanel(): void {
  sizeInput.value = String(state.fontSize);
  sizeValue.textContent = `${state.fontSize}px`;
  widthInput.value = String(state.width);
  widthValue.textContent = `${state.width}px`;
  bgToggle.checked = state.showBackground;
  opacityInput.value = String(state.backgroundOpacity);
  opacityInput.disabled = !state.showBackground;
  for (const button of Array.from(colorRow.querySelectorAll<HTMLButtonElement>('button'))) {
    button.setAttribute('aria-pressed', String(button.dataset.color === state.fontColor.toLowerCase()));
  }
}

function setPanel(open: boolean): void {
  if (open && state.locked) return;
  panelOpen = open;
  panel.hidden = !open;
  root.classList.toggle('panel-open', open);
  styleButton.classList.toggle('active', open);
  window.desktopLyricsWindow.setPanelOpen(open);
}

function setLockedClass(next: boolean): void {
  state.locked = next;
  root.classList.toggle('locked', next);
  lockButton.textContent = next ? '🔒' : '🔓';
  lockButton.title = next ? '已锁定：鼠标穿透下面的窗口' : '解锁：可拖动、可调样式';
  if (next) setPanel(false);
}

function buildSwatches(): void {
  for (const color of PALETTE) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.color = color;
    button.style.background = color;
    button.title = color;
    button.setAttribute('aria-label', `歌词颜色 ${color}`);
    button.addEventListener('click', () => applyLocal({ fontColor: color }));
    colorRow.appendChild(button);
  }
  const custom = document.createElement('label');
  custom.title = '自定义颜色';
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.setAttribute('aria-label', '自定义歌词颜色');
  picker.addEventListener('input', () => applyLocal({ fontColor: picker.value }));
  custom.appendChild(picker);
  colorRow.appendChild(custom);
}

function applyLocal(patch: DesktopLyricsStylePatch): void {
  state = { ...state, ...patch };
  paint();
  syncPanel();
  sendStyle(patch);
}

lockButton.addEventListener('click', () => {
  const next = !state.locked;
  setLockedClass(next);
  window.desktopLyricsWindow.setLocked(next);
});

closeButton.addEventListener('click', () => { window.desktopLyricsWindow.requestClose(); });
styleButton.addEventListener('click', () => { setPanel(!panelOpen); });
doneButton.addEventListener('click', () => { setPanel(false); });

sizeInput.addEventListener('input', () => {
  const fontSize = Number(sizeInput.value);
  sizeValue.textContent = `${fontSize}px`;
  applyLocal({ fontSize });
});
widthInput.addEventListener('input', () => {
  const width = Number(widthInput.value);
  widthValue.textContent = `${width}px`;
  applyLocal({ width });
});
bgToggle.addEventListener('change', () => { applyLocal({ showBackground: bgToggle.checked }); });
opacityInput.addEventListener('input', () => { applyLocal({ backgroundOpacity: Number(opacityInput.value) }); });
resetButton.addEventListener('click', () => { applyLocal({ ...FONT_DEFAULTS }); });

// Ctrl + wheel resizes the lyrics in place, the quickest way to fit a busy wallpaper.
window.addEventListener('wheel', event => {
  if (!event.ctrlKey || state.locked) return;
  event.preventDefault();
  const next = Math.min(96, Math.max(16, state.fontSize + (event.deltaY < 0 ? 2 : -2)));
  if (next === state.fontSize) return;
  applyLocal({ fontSize: next });
}, { passive: false });

// Pointer dragging: the overlay is a frameless transparent window, so the main process follows
// the OS cursor instead of relying on a native title-bar drag. Only the text block and the track
// label start a drag; the control strip and panel keep their normal click behaviour.
function attachDrag(handle: HTMLElement): void {
  handle.addEventListener('pointerdown', event => {
    if (state.locked || event.button !== 0) return;
    dragging = true;
    handle.setPointerCapture(event.pointerId);
    root.classList.add('dragging');
    window.desktopLyricsWindow.dragStart();
  });
  handle.addEventListener('pointermove', () => {
    if (!dragging) return;
    window.desktopLyricsWindow.dragMove();
  });
  const stop = (): void => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove('dragging');
    window.desktopLyricsWindow.endDrag();
  };
  handle.addEventListener('pointerup', stop);
  handle.addEventListener('pointercancel', stop);
}

attachDrag(body);
attachDrag(trackLabel);

// Double-click the lyrics for the style panel when the control strip is out of the way.
body.addEventListener('dblclick', () => { if (!state.locked) setPanel(!panelOpen); });

window.desktopLyricsWindow.onUpdate(payload => {
  const label = [payload.title, payload.artist].filter(Boolean).join(' · ');
  trackLabel.textContent = label || '桌面歌词';
  if (!payload.current && !payload.next) {
    currentLine.textContent = payload.synced ? '♪' : (payload.title ? `${payload.title}（纯文本歌词）` : '暂无歌词');
    currentLine.classList.add('empty');
    nextLine.textContent = '';
    return;
  }
  currentLine.classList.remove('empty');
  if (payload.current) {
    currentLine.textContent = payload.current.text || '♪';
    nextLine.textContent = payload.current.translation
      ? `${payload.current.translation}${payload.next?.text ? ' · ' + payload.next.text : ''}`
      : (payload.next?.text ?? '');
  } else {
    // Between tracks or before the first line: show what is coming.
    currentLine.textContent = payload.next?.text || '♪';
    nextLine.textContent = payload.next?.translation ?? '';
  }
});

window.desktopLyricsWindow.onState(next => {
  state = { ...next };
  paint();
  syncPanel();
  lockButton.textContent = next.locked ? '🔒' : '🔓';
  lockButton.title = next.locked ? '已锁定：鼠标穿透下面的窗口' : '解锁：可拖动、可调样式';
  if (next.locked) setPanel(false);
});

buildSwatches();
// Start locked-looking; the main process pushes the real state right after load.
paint();
syncPanel();
