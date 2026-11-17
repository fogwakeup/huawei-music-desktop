// Desktop mini transport bar: a frameless, always-on-top window that mirrors the main
// player's state through one-way sanitized payloads and sends only whitelisted commands.
// It has no auth/settings/music bridge, so losing this window can never leak credentials.
//
// Two presentations share one renderer:
//  - 'taskbar' (default): a slim strip drawn exactly on the taskbar band, the way Chinese music
//    clients offer the same feature. Windows 11 has no public taskbar-extension API any more, so
//    the strip is a topmost window aligned to the taskbar rectangle instead of a child window.
//  - 'float': the original draggable glass capsule docked above the taskbar.
import { BrowserWindow, ipcMain, screen } from 'electron';
import { join } from 'node:path';
import { channels } from '../shared/channels';
import { sanitizeMiniPlayerState } from './mini-player-payload.mjs';
import { updateSettings } from './storage';
import { clampRectangle, dockPosition, taskbarBarRect, taskbarStrip } from './mini-player-layout.mjs';
import type { AppSettings, MiniPlayerSettings, MiniPlayerState, PlayerCommand } from '../shared/types';

const FLOAT_SIZE = { width: 560, height: 66 };
const TASKBAR_SIZE = { width: 420, height: 40 };
const TASKBAR_MARGIN = 4;
// The Win11 clock/tray cluster is not measurable through any public API, so the first run keeps a
// proportional gap from the right edge (users usually have several tray icons) and the strip can
// be dragged anywhere along the taskbar afterwards.
const TASKBAR_TRAY_RESERVE_MIN = 340;
const TASKBAR_TRAY_RESERVE_RATIO = 0.24;
const FLOAT_GAP = 8;
// Windows repaints the taskbar whenever it is hovered or a flyout opens, which can put Explorer
// above a topmost window. Re-asserting the topmost flag keeps the strip visible without ever
// activating this window (no focus stealing).
const TOPMOST_HEARTBEAT_MS = 5000;
const COMMANDS: PlayerCommand[] = [
  'play-pause', 'next', 'previous', 'volume-up', 'volume-down', 'mute', 'like', 'toggle-desktop-lyrics',
];

type Rect = { x: number; y: number; width: number; height: number };
type Strip = { edge: 'bottom' | 'top' | 'left' | 'right'; rect: Rect };
type Mode = 'taskbar' | 'float';

function primaryDisplay(): Electron.Display {
  // The strip belongs to the taskbar of the display holding it; the primary display owns the
  // taskbar on Windows unless the user pinned it elsewhere.
  return screen.getPrimaryDisplay();
}

function currentStrip(): Strip {
  const display = primaryDisplay();
  return taskbarStrip(display.bounds, display.workArea) as Strip;
}

function taskbarRect(anchor: number | null): Rect {
  const strip = currentStrip();
  const trayReserve = Math.max(TASKBAR_TRAY_RESERVE_MIN, Math.round(strip.rect.width * TASKBAR_TRAY_RESERVE_RATIO));
  return taskbarBarRect(strip, TASKBAR_SIZE, anchor, {
    margin: TASKBAR_MARGIN,
    trayReserve,
  }) as Rect;
}

function floatRect(settings: MiniPlayerSettings): Rect {
  const saved = settings.position;
  if (!saved) return { ...dockPosition(primaryDisplay().workArea, FLOAT_GAP, FLOAT_SIZE), ...FLOAT_SIZE };
  const nearest = screen.getDisplayNearestPoint({ x: saved.x, y: saved.y });
  const area = nearest?.workArea ?? primaryDisplay().workArea;
  return { ...clampRectangle(saved.x, saved.y, area, FLOAT_SIZE), ...FLOAT_SIZE };
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
  let latest: MiniPlayerSettings = { enabled: true, position: null, embedInTaskbar: true, taskbarX: null };
  let mode: Mode | null = null;
  let pendingState: MiniPlayerState | null = null;
  let moveSaveTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let snapping = false;

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

  function stopHeartbeat(): void {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function keepOnTop(): void {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    try { miniWindow.setAlwaysOnTop(true, 'screen-saver'); } catch { /* Window closing. */ }
  }

  function apply(settings: MiniPlayerSettings): void {
    const nextMode: Mode = settings.embedInTaskbar ? 'taskbar' : 'float';
    const modeChanged = mode !== null && mode !== nextMode;
    latest = settings;
    if (!settings.enabled) {
      if (miniWindow && !miniWindow.isDestroyed()) { clearTimeout(moveSaveTimer); miniWindow.destroy(); }
      miniWindow = null;
      mode = null;
      stopHeartbeat();
      return;
    }
    if (!miniWindow || miniWindow.isDestroyed()) { createWindow(settings); return; }
    if (modeChanged) {
      // The two presentations use different window sizes and chrome; rebuild instead of
      // trying to morph a live window (which would flash a stale layout).
      miniWindow.destroy();
      miniWindow = null;
      stopHeartbeat();
      createWindow(settings);
      return;
    }
    syncBounds();
    keepOnTop();
    if (pendingState) sendState(pendingState);
  }

  // Recompute the rectangle from live display metrics. Cheap, idempotent, and the single source
  // of truth for both modes: saved anchors are clamped, never trusted verbatim.
  function syncBounds(): void {
    // Never yank the strip while the user is dragging it (a volume change can arrive mid-drag).
    if (!miniWindow || miniWindow.isDestroyed() || dragOrigin) return;
    const [px, py] = miniWindow.getPosition();
    const target = mode === 'taskbar'
      ? taskbarRect(latest.taskbarX)
      : clampRectangle(px, py, primaryDisplay().workArea, FLOAT_SIZE) as Rect;
    const rect: Rect = mode === 'taskbar' ? target : { ...target, ...FLOAT_SIZE };
    if (rect.x !== px || rect.y !== py || miniWindow.getBounds().width !== rect.width || miniWindow.getBounds().height !== rect.height) {
      miniWindow.setBounds(rect);
    }
  }

  function createWindow(settings: MiniPlayerSettings): void {
    const taskbarMode = settings.embedInTaskbar;
    const window = new BrowserWindow({
      ...(taskbarMode ? taskbarRect(settings.taskbarX) : floatRect(settings)),
      frame: false,
      transparent: true,
      // A native shadow would draw a halo across the taskbar; each presentation styles its own edge.
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      movable: true,
      skipTaskbar: true,
      // Never steal focus from the app the user is working in — this bar is a passive control.
      focusable: false,
      show: false,
      title: '任务栏播控条',
      webPreferences: {
        preload: join(__dirname, '../preload/mini.cjs'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      },
    });
    miniWindow = window;
    mode = taskbarMode ? 'taskbar' : 'float';
    // 'screen-saver' is above normal topmost windows AND the taskbar, so the strip stays visible
    // instead of being painted over when the taskbar is set to always-on-top.
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    // Identity-checked teardown: a rebuilt window must not be cleared by the old window's events.
    window.once('closed', () => {
      if (miniWindow !== window) return;
      miniWindow = null;
      mode = null;
    });
    // Dragging: in taskbar mode the strip slides along the taskbar only, so the vertical axis is
    // pinned continuously — 'move' fires while the native drag loop runs, 'moved' only once it
    // settles (and not at all for programmatic moves), so both are handled.
    window.on('move', () => {
      if (window.isDestroyed() || mode !== 'taskbar') return;
      const [px, py] = window.getPosition();
      const snapped = taskbarRect(px);
      if (snapped.x !== px || snapped.y !== py) {
        window.setBounds({ ...window.getBounds(), x: snapped.x, y: snapped.y });
      }
    });
    window.on('moved', () => {
      if (window.isDestroyed() || snapping) return;
      const [px, py] = window.getPosition();
      snapping = true;
      try {
        if (mode === 'taskbar') {
          const snapped = taskbarRect(px);
          if (snapped.x !== px || snapped.y !== py) window.setBounds(snapped);
          clearTimeout(moveSaveTimer);
          moveSaveTimer = setTimeout(() => {
            if (window.isDestroyed()) return;
            writeSettings({ taskbarX: window.getPosition()[0] });
          }, 800);
        } else {
          const safe = clampRectangle(px, py, primaryDisplay().workArea, FLOAT_SIZE);
          if (safe.x !== px || safe.y !== py) window.setPosition(safe.x, safe.y);
          clearTimeout(moveSaveTimer);
          moveSaveTimer = setTimeout(() => {
            if (window.isDestroyed()) return;
            const [sx, sy] = window.getPosition();
            writeSettings({ position: { x: sx, y: sy } });
          }, 800);
        }
      } finally {
        snapping = false;
      }
    });
    // Display geometry changed (monitor unplug / resolution / taskbar resize or move): re-derive
    // the rectangle instead of leaving the bar hidden off-screen or floating off the taskbar.
    const onDisplayChange = () => { syncBounds(); keepOnTop(); };
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
    // The taskbar is repainted (hover, flyouts, shell restart): stay above it.
    stopHeartbeat();
    heartbeat = setInterval(keepOnTop, TOPMOST_HEARTBEAT_MS);
    window.once('closed', () => {
      screen.removeListener('display-added', onDisplayChange);
      screen.removeListener('display-removed', onDisplayChange);
      screen.removeListener('display-metrics-changed', onDisplayChange);
      stopHeartbeat();
    });
    void window.loadFile(join(__dirname, '../renderer/mini.html'), { query: { mode } }).then(() => {
      if (window.isDestroyed()) return;
      window.showInactive();
      if (pendingState) {
        window.webContents.send(channels.miniPlayerRender, pendingState);
        pendingState = null;
      }
    }).catch(() => { if (!window.isDestroyed()) window.close(); });
  }

  // Module-level one-way listeners: idempotent because the module is created once per process,
  // but registering here (not in registerIpc) keeps mini-window messages separate from the
  // trusted main renderer's IPC surface.
  for (const channel of [channels.miniPlayerCommand, channels.miniPlayerRequestClose,
    channels.miniPlayerSavePosition, channels.miniPlayerDragStart, channels.miniPlayerDragMove,
    channels.miniPlayerDragEnd]) {
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
  // Pointer drag from the renderer. The bar is created with focusable:false (it must never steal
  // focus from the app in use), which rules out a native app-region drag, so the main process
  // follows the OS cursor instead: the grab offset is fixed at drag start, and every move event
  // re-reads the cursor. Deriving positions from the cursor (not from the window, which is the
  // thing being moved) keeps the gesture stable and impossible to feed back on itself.
  let dragOrigin: { cursorX: number; cursorY: number; windowX: number; windowY: number } | null = null;
  ipcMain.on(channels.miniPlayerDragStart, event => {
    if (!isMiniSender(event) || !miniWindow || miniWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    const [windowX, windowY] = miniWindow.getPosition();
    dragOrigin = { cursorX: cursor.x, cursorY: cursor.y, windowX, windowY };
  });
  ipcMain.on(channels.miniPlayerDragMove, event => {
    if (!isMiniSender(event) || !dragOrigin || !miniWindow || miniWindow.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    miniWindow.setPosition(
      dragOrigin.windowX + (cursor.x - dragOrigin.cursorX),
      dragOrigin.windowY + (cursor.y - dragOrigin.cursorY),
    );
  });
  ipcMain.on(channels.miniPlayerDragEnd, event => {
    dragOrigin = null;
    if (!isMiniSender(event) || !miniWindow || miniWindow.isDestroyed()) return;
    const [x, y] = miniWindow.getPosition();
    if (mode === 'taskbar') {
      const snapped = taskbarRect(x);
      miniWindow.setBounds(snapped);
      writeSettings({ taskbarX: snapped.x });
    } else {
      const safe = clampRectangle(x, y, primaryDisplay().workArea, FLOAT_SIZE);
      miniWindow.setPosition(safe.x, safe.y);
      writeSettings({ position: safe });
    }
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
      stopHeartbeat();
      if (miniWindow && !miniWindow.isDestroyed()) miniWindow.destroy();
      miniWindow = null;
      mode = null;
    },
  };
}
