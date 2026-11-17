// Floating always-on-top desktop lyrics window. Security mirrors the main window: sandboxed,
// context-isolated, no node integration, its own minimal preload with only the lyrics bridge.
// The window itself carries no credentials and renders only sanitized text payloads.
import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { channels } from '../shared/channels';
import { sanitizeDesktopLyricsUpdate } from './desktop-lyrics-payload.mjs';
import { updateSettings } from './storage';
import { dragOriginTo, lyricsWindowSize, panelOffset, placeLyrics, resizeFromBottom, withPanel } from './lyrics-layout.mjs';
import type { AppSettings, DesktopLyricsAppearance, DesktopLyricsSettings, DesktopLyricsUpdate } from '../shared/types';

type Rect = { x: number; y: number; width: number; height: number };

// Only the look-and-feel keys may be changed from inside the overlay; enabling/disabling the
// window and its lock state stay in the main settings surface.
const STYLE_KEYS = ['fontColor', 'showBackground', 'backgroundOpacity', 'fontSize', 'width'] as const;

export type DesktopLyricsModuleOptions = {
  /** Called after a write made inside the overlay, so the main window can refresh its copy. */
  onSettingsChanged?: (settings: AppSettings) => void;
};

export type DesktopLyricsModule = {
  applySettings(settings: AppSettings): void;
  forwardUpdate(payload: unknown): void;
  destroy(): void;
};

const DEFAULT_SETTINGS: DesktopLyricsSettings = {
  enabled: false, locked: false, position: null,
  fontColor: '#ffffff', showBackground: false, backgroundOpacity: 0.55,
  fontSize: 34, width: 760,
};

function appearanceOf(settings: DesktopLyricsSettings): DesktopLyricsAppearance {
  return {
    locked: settings.locked,
    fontColor: settings.fontColor,
    showBackground: settings.showBackground,
    backgroundOpacity: settings.backgroundOpacity,
    fontSize: settings.fontSize,
    width: settings.width,
  };
}

function workAreaOf(rect: Rect | null): Rect {
  if (rect) {
    const display = screen.getDisplayMatching(rect as Electron.Rectangle);
    if (display) return display.workArea;
  }
  return screen.getPrimaryDisplay().workArea;
}

export function createDesktopLyricsModule(options: DesktopLyricsModuleOptions = {}): DesktopLyricsModule {
  let lyricsWindow: BrowserWindow | null = null;
  let latest: DesktopLyricsSettings = { ...DEFAULT_SETTINGS };
  // The text block's own rectangle (the style panel is added on top of it), which is what gets
  // clamped and persisted. Keeping it separate stops a panel opening from drifting the lyrics.
  let base: Rect | null = null;
  let panelOpen = false;
  // Cached height the panel adds above the text block, so a drag can invert the window position.
  let panelShift = 0;
  let dragOrigin: { cursorX: number; cursorY: number; windowX: number; windowY: number } | null = null;
  let pendingPayload: DesktopLyricsUpdate | null = null;

  function isLyricsSender(event: Electron.IpcMainEvent): boolean {
    return !!lyricsWindow && !lyricsWindow.isDestroyed() && event.sender === lyricsWindow.webContents;
  }

  // Settings written from inside this module do not pass the IPC hooks, so the apply step runs
  // right after the write to keep the window in sync.
  function writeSettings(patch: Partial<DesktopLyricsSettings>): void {
    void updateSettings({ desktopLyrics: { ...latest, ...patch } }).then(next => {
      apply(next.desktopLyrics);
      // The overlay's own edits never pass the settings IPC handler; without this push the
      // settings page would keep showing stale values.
      options.onSettingsChanged?.(next);
    });
  }

  function pushState(): void {
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
    try { lyricsWindow.webContents.send(channels.desktopLyricsState, appearanceOf(latest)); } catch { /* closing */ }
  }

  function sizeOf(settings: DesktopLyricsSettings): { width: number; height: number } {
    return lyricsWindowSize({ fontSize: settings.fontSize, width: settings.width });
  }

  function closeWindow(): void {
    dragOrigin = null;
    panelOpen = false;
    base = null;
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.destroy();
    lyricsWindow = null;
  }

  /** Re-derive the window rectangle after a size, position or panel change. */
  function syncGeometry(previous: DesktopLyricsSettings, force = false): void {
    if (!lyricsWindow || lyricsWindow.isDestroyed() || dragOrigin) return;
    const size = sizeOf(latest);
    if (!base) {
      base = placeLyrics(size, workAreaOf(null), latest.position);
    } else if (force || previous.fontSize !== latest.fontSize || previous.width !== latest.width) {
      base = resizeFromBottom(base, size, workAreaOf(base));
    } else if (latest.position && (latest.position.x !== base.x || latest.position.y !== base.y)) {
      base = placeLyrics(size, workAreaOf(base), latest.position);
    } else if (!latest.position) {
      // "Reset position" in the settings surface clears the stored spot.
      base = placeLyrics(size, workAreaOf(base), null);
    }
    panelShift = panelOffset(base, workAreaOf(base), panelOpen);
    const target = withPanel(base, workAreaOf(base), panelOpen);
    const current = lyricsWindow.getBounds();
    if (current.x !== target.x || current.y !== target.y
      || current.width !== target.width || current.height !== target.height) {
      lyricsWindow.setBounds(target);
    }
  }

  function apply(settings: DesktopLyricsSettings): void {
    const previous = latest;
    latest = settings;
    if (!settings.enabled) { closeWindow(); return; }
    if (!lyricsWindow || lyricsWindow.isDestroyed()) { createWindow(); return; }
    // A locked overlay is click-through, so its style panel can never be reached anyway.
    if (settings.locked && panelOpen) panelOpen = false;
    syncGeometry(previous);
    lyricsWindow.setIgnoreMouseEvents(settings.locked, { forward: true });
    if (settings.locked && lyricsWindow.isFocused()) lyricsWindow.blur();
    pushState();
  }

  function createWindow(): void {
    const size = sizeOf(latest);
    base = placeLyrics(size, workAreaOf(null), latest.position);
    panelShift = panelOffset(base, workAreaOf(base), panelOpen);
    const bounds = withPanel(base, workAreaOf(base), panelOpen);
    const window = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      // The frameless window must not paint its own frame: no title bar, no OS rounded-corner
      // clip, no native shadow — otherwise the overlay shows up as a dark box over the desktop.
      roundedCorners: false,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // Locked means click-through; unlocking has to accept focus so the style panel works.
      focusable: !latest.locked,
      show: false,
      title: '桌面歌词',
      webPreferences: {
        preload: join(__dirname, '../preload/lyrics.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      },
    });
    lyricsWindow = window;
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    window.setIgnoreMouseEvents(latest.locked, { forward: true });
    window.once('closed', () => { if (lyricsWindow === window) lyricsWindow = null; });
    void window.loadFile(join(__dirname, '../renderer/lyrics.html')).then(() => {
      if (window.isDestroyed()) return;
      window.showInactive();
      window.webContents.send(channels.desktopLyricsState, appearanceOf(latest));
      if (pendingPayload) {
        window.webContents.send(channels.desktopLyricsRender, pendingPayload);
        pendingPayload = null;
      }
    }).catch(() => { if (!window.isDestroyed()) window.close(); });
  }

  // Module-level one-way listeners: idempotent registration so a second module instance (or
  // repeated init) can never stack duplicate handlers.
  for (const channel of [channels.desktopLyricsSetLocked, channels.desktopLyricsRequestClose,
    channels.desktopLyricsSavePosition, channels.desktopLyricsStyle, channels.desktopLyricsPanel,
    channels.desktopLyricsDragStart, channels.desktopLyricsDragMove, channels.desktopLyricsDragEnd]) {
    ipcMain.removeAllListeners(channel);
  }
  ipcMain.on(channels.desktopLyricsSetLocked, (event, locked: unknown) => {
    if (!isLyricsSender(event) || typeof locked !== 'boolean') return;
    writeSettings({ locked });
  });
  ipcMain.on(channels.desktopLyricsRequestClose, event => {
    if (!isLyricsSender(event)) return;
    writeSettings({ enabled: false });
  });
  ipcMain.on(channels.desktopLyricsSavePosition, (event, position: unknown) => {
    if (!isLyricsSender(event)) return;
    const value = position as { x?: unknown; y?: unknown };
    if (!Number.isInteger(value?.x) || !Number.isInteger(value?.y)) return;
    writeSettings({ position: { x: value.x as number, y: value.y as number } });
  });
  // Style edits from the in-window panel. Only known appearance keys are forwarded; the settings
  // sanitizer still validates and clamps every value before it reaches the stylesheet.
  ipcMain.on(channels.desktopLyricsStyle, (event, patch: unknown) => {
    if (!isLyricsSender(event) || !patch || typeof patch !== 'object') return;
    const source = patch as Record<string, unknown>;
    const picked: Record<string, unknown> = {};
    for (const key of STYLE_KEYS) if (source[key] !== undefined) picked[key] = source[key];
    if (!Object.keys(picked).length) return;
    writeSettings(picked as Partial<DesktopLyricsSettings>);
  });
  ipcMain.on(channels.desktopLyricsPanel, (event, open: unknown) => {
    if (!isLyricsSender(event) || typeof open !== 'boolean') return;
    if (latest.locked) return;
    panelOpen = open;
    const previous = latest;
    syncGeometry(previous, true);
  });
  // Pointer drag: the overlay is a frameless transparent window, and a native app-region drag is
  // unreliable on such windows, so the main process follows the OS cursor instead. The grab offset
  // is fixed at drag start, which keeps the gesture stable while the window slides underneath.
  ipcMain.on(channels.desktopLyricsDragStart, event => {
    if (!isLyricsSender(event) || !lyricsWindow || lyricsWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const [windowX, windowY] = lyricsWindow.getPosition();
    dragOrigin = { cursorX: cursor.x, cursorY: cursor.y, windowX, windowY };
  });
  ipcMain.on(channels.desktopLyricsDragMove, event => {
    if (!isLyricsSender(event) || !dragOrigin || !lyricsWindow || lyricsWindow.isDestroyed()) return;
    const target = dragOriginTo(dragOrigin, screen.getCursorScreenPoint());
    lyricsWindow.setPosition(target.x, target.y);
  });
  ipcMain.on(channels.desktopLyricsDragEnd, event => {
    if (!isLyricsSender(event) || !dragOrigin) { dragOrigin = null; return; }
    dragOrigin = null;
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return;
    const [windowX, windowY] = lyricsWindow.getPosition();
    const size = sizeOf(latest);
    // The panel may sit above the text block; the saved spot always refers to the text itself.
    const baseY = windowY + panelShift;
    const rect: Rect = { x: windowX, y: baseY, width: size.width, height: size.height };
    const clamped = placeLyrics(size, workAreaOf(rect), { x: rect.x, y: rect.y });
    base = clamped;
    lyricsWindow.setBounds(withPanel(clamped, workAreaOf(clamped), panelOpen));
    writeSettings({ position: { x: clamped.x, y: clamped.y } });
  });

  return {
    applySettings(settings: AppSettings): void { apply(settings.desktopLyrics); },
    forwardUpdate(payload: unknown): void {
      const sanitized = sanitizeDesktopLyricsUpdate(payload);
      if (!sanitized) return;
      if (lyricsWindow && !lyricsWindow.isDestroyed()) {
        try { lyricsWindow.webContents.send(channels.desktopLyricsRender, sanitized); } catch { /* closing */ }
      } else pendingPayload = sanitized;
    },
    destroy(): void { closeWindow(); },
  };
}
