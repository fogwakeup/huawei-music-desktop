// Desktop mini transport bar: a frameless, always-on-top window that mirrors the main
// player's state through one-way sanitized payloads and sends only whitelisted commands.
// It has no auth/settings/music bridge, so losing this window can never leak credentials.
import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { channels } from '../shared/channels';
import { sanitizeMiniPlayerState } from './mini-player-payload.mjs';
import { updateSettings } from './storage';
import { clampRectangle, dockPosition } from './mini-player-layout.mjs';
import type { AppSettings, MiniPlayerSettings, MiniPlayerState, PlayerCommand } from '../shared/types';

const WINDOW_SIZE = { width: 560, height: 66 };
const TASKBAR_GAP = 8;
const COMMANDS: PlayerCommand[] = [
  'play-pause', 'next', 'previous', 'volume-up', 'volume-down', 'mute', 'like', 'toggle-desktop-lyrics',
];

// Clamp a requested position into a display's work area (the region EXCLUDING the taskbar), so
// the bar can never be swallowed by an auto-hiding/bottom taskbar, and survives monitor unplug or
// a resolution change that would otherwise leave the saved coordinates off-screen.
function clampToWorkArea(x: number, y: number): { x: number; y: number } {
  const displays = screen.getAllDisplays();
  const nearest = screen.getDisplayNearestPoint({ x, y });
  const area = (displays.length ? nearest : screen.getPrimaryDisplay()).workArea;
  return clampRectangle(x, y, area, WINDOW_SIZE);
}

function dockedPosition(): { x: number; y: number } {
  return dockPosition(screen.getPrimaryDisplay().workArea, TASKBAR_GAP, WINDOW_SIZE);
}

export type MiniPlayerModule = {
  applySettings(settings: AppSettings): void;
  forwardState(payload: unknown): void;
  destroy(): void;
};

export function createMiniPlayerModule(hooks: {
  onCommand(command: PlayerCommand): void;
  onShowMain(): void;
}): MiniPlayerModule {
  let miniWindow: BrowserWindow | null = null;
  let latest: MiniPlayerSettings = { enabled: true, position: null };
  let pendingState: MiniPlayerState | null = null;
  let moveSaveTimer: NodeJS.Timeout | undefined;

  function isMiniSender(event: Electron.IpcMainEvent): boolean {
    return !!miniWindow && !miniWindow.isDestroyed() && event.sender === miniWindow.webContents;
  }

  function writeSettings(patch: Partial<MiniPlayerSettings>): void {
    void updateSettings({ miniPlayer: { ...latest, ...patch } }).then(next => apply(next.miniPlayer));
  }

  function sendState(payload: unknown): void {
    const sanitized = sanitizeMiniPlayerState(payload);
    if (!sanitized) return;
    pendingState = sanitized;
    if (miniWindow && !miniWindow.isDestroyed()) {
      try { miniWindow.webContents.send(channels.miniPlayerRender, sanitized); } catch { /* Window closing. */ }
    }
  }

  function apply(settings: MiniPlayerSettings): void {
    latest = settings;
    if (!settings.enabled) {
      if (miniWindow && !miniWindow.isDestroyed()) { clearTimeout(moveSaveTimer); miniWindow.destroy(); }
      miniWindow = null;
      return;
    }
    if (!miniWindow || miniWindow.isDestroyed()) { createWindow(settings); return; }
    if (pendingState) sendState(pendingState);
  }

  function createWindow(settings: MiniPlayerSettings): void {
    // Always derive the initial rectangle from a live work area. Saved coordinates are clamped,
    // never trusted verbatim, so a stale position cannot put the bar under the taskbar.
    const start = settings.position
      ? clampToWorkArea(settings.position.x, settings.position.y)
      : dockedPosition();
    miniWindow = new BrowserWindow({
      ...WINDOW_SIZE,
      x: start.x, y: start.y,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      title: '桌面播控条',
      webPreferences: {
        preload: join(__dirname, '../preload/mini.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      },
    });
    // 'screen-saver' is above normal topmost windows AND the taskbar, so the bar stays visible
    // instead of being painted over when the taskbar is set to always-on-top.
    miniWindow.setAlwaysOnTop(true, 'screen-saver');
    miniWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    miniWindow.once('closed', () => { miniWindow = null; });
    // Re-clamp after any move: dragging onto the taskbar snaps the bar back into the work area.
    miniWindow.on('moved', () => {
      if (!miniWindow || miniWindow.isDestroyed()) return;
      const window = miniWindow;
      const [px, py] = window.getPosition();
      const safe = clampToWorkArea(px, py);
      if (safe.x !== px || safe.y !== py) window.setPosition(safe.x, safe.y);
      clearTimeout(moveSaveTimer);
      moveSaveTimer = setTimeout(() => {
        if (!window || window.isDestroyed()) return;
        const [sx, sy] = window.getPosition();
        writeSettings({ position: { x: sx, y: sy } });
      }, 800);
    });
    // Display geometry changed (monitor unplug / resolution / taskbar resize): pull the bar back
    // into a valid work area instead of leaving it hidden off-screen.
    const onDisplayChange = () => {
      if (!miniWindow || miniWindow.isDestroyed()) return;
      const [px, py] = miniWindow.getPosition();
      const safe = clampToWorkArea(px, py);
      miniWindow.setPosition(safe.x, safe.y);
    };
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
    miniWindow.once('closed', () => {
      screen.removeListener('display-added', onDisplayChange);
      screen.removeListener('display-removed', onDisplayChange);
      screen.removeListener('display-metrics-changed', onDisplayChange);
    });
    void miniWindow.loadFile(join(__dirname, '../renderer/mini.html')).then(() => {
      if (!miniWindow || miniWindow.isDestroyed()) return;
      miniWindow.showInactive();
      if (pendingState) {
        miniWindow.webContents.send(channels.miniPlayerRender, pendingState);
        pendingState = null;
      }
    }).catch(() => { if (miniWindow && !miniWindow.isDestroyed()) miniWindow.close(); });
  }

  // Module-level one-way listeners: idempotent because the module is created once per process,
  // but registering here (not in registerIpc) keeps mini-window messages separate from the
  // trusted main renderer's IPC surface.
  for (const channel of [channels.miniPlayerCommand, channels.miniPlayerRequestClose, channels.miniPlayerSavePosition]) {
    ipcMain.removeAllListeners(channel);
  }
  ipcMain.on(channels.miniPlayerCommand, (event, command: unknown) => {
    if (!isMiniSender(event) || typeof command !== 'string') return;
    if (command === 'show-main') { hooks.onShowMain(); return; }
    if (COMMANDS.includes(command as PlayerCommand)) hooks.onCommand(command as PlayerCommand);
  });
  ipcMain.on(channels.miniPlayerRequestClose, event => {
    if (!isMiniSender(event)) return;
    writeSettings({ enabled: false });
  });
  ipcMain.on(channels.miniPlayerSavePosition, (event, position: unknown) => {
    if (!isMiniSender(event)) return;
    const value = position as { x?: unknown; y?: unknown };
    if (!Number.isInteger(value?.x) || !Number.isInteger(value?.y)) return;
    writeSettings({ position: { x: value.x as number, y: value.y as number } });
  });

  return {
    applySettings(settings: AppSettings): void { apply(settings.miniPlayer); },
    forwardState: sendState,
    destroy(): void {
      clearTimeout(moveSaveTimer);
      if (miniWindow && !miniWindow.isDestroyed()) miniWindow.destroy();
      miniWindow = null;
    },
  };
}
