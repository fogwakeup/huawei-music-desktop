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
import { clampRectangle, dockPosition, isFullscreenBand, taskbarBarRect, taskbarStrip } from './mini-player-layout.mjs';
import { clampDockedX, dockWidthDip, preferredDockRect } from './taskbar-dock.mjs';
import { adoptTaskbarWindow, raiseAboveTaskbar, readTaskbarLayout, readTaskbarTheme } from './win32-taskbar';
import type { AppSettings, MiniPlayerSettings, MiniPlayerState, PlayerCommand } from '../shared/types';

const FLOAT_SIZE = { width: 560, height: 66 };
const TASKBAR_SIZE = { width: 388, height: 40 };
const TASKBAR_MARGIN = 4;
// Fallback only: used when the Win32 layer cannot answer (non-Windows, koffi missing). The real
// placement comes from the measured blank band of the taskbar, exactly like the reference clients.
const TASKBAR_TRAY_RESERVE_MIN = 340;
const TASKBAR_TRAY_RESERVE_RATIO = 0.24;
const FLOAT_GAP = 8;
// The taskbar repaints (hover, flyouts, shell restart) and re-raises itself above anything that
// merely asked for always-on-top once, which is how the strip ended up *behind* the taskbar.
// Re-inserting it at the top of the top-most band costs one SetWindowPos, so it runs 4x/s; the
// same tick measures the taskbar, hides the strip when there is no free band any more, and yields
// to a full-screen foreground (borderless games never shrink the work area).
const TASKBAR_TICK_MS = 250;
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

/** A docked placement plus the free band it was fitted into (null for the heuristic fallback). */
type DockedPlacement = { rect: Rect; gap: Rect | null };

/**
 * Place the strip in the taskbar's *measured* free band: 388/248/108 DIP wide, 40 DIP tall,
 * vertically centred, 12 DIP off the docked edge, and never on top of the app buttons or the tray.
 * Returns null when the band cannot host even the nano strip — the caller hides instead of
 * squeezing the bar over the icons.
 */
function dockedPlacement(anchor: number | null, layout: ReturnType<typeof readTaskbarLayout>): DockedPlacement | null {
  if (!layout) return { rect: taskbarRect(anchor), gap: null };
  if (!layout.visible || !layout.gap) return null;
  const width = dockWidthDip(layout.gap.width);
  if (!width) return null;
  const docked = preferredDockRect(layout.gap, 'right', width);
  if (!docked) return null;
  const x = clampDockedX(layout.gap, docked.width, anchor);
  if (x === null) return null;
  return {
    rect: { x, y: docked.y, width: docked.width, height: docked.height },
    gap: layout.gap,
  };
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

  // Yield to a full-screen game instead of covering it. A top-most strip used to sit above
  // full-screen games and made them unplayable; now the strip hides whenever a full-screen window
  // owns the display (measured from the real foreground window, so borderless games count too),
  // and also hides when the taskbar has no free band left for it.
  function hideStrip(): void {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    if (miniWindow.isVisible()) miniWindow.hide();
  }

  // Last measured free band; the move handler and drag-end snap stay inside it.
  let lastGap: Rect | null = null;

  // The taskbar's own light/dark switch, polled once a second — the strip must blend with the band
  // it sits on, and that theme is not the app theme. Only a change is forwarded to the renderer.
  let lastTheme: 'light' | 'dark' | null = null;
  let lastThemeCheck = 0;
  const THEME_CHECK_MS = 1000;

  function pushTheme(force = false): void {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    const now = Date.now();
    if (!force && now - lastThemeCheck < THEME_CHECK_MS) return;
    lastThemeCheck = now;
    const theme = readTaskbarTheme();
    if (!force && theme === lastTheme) return;
    lastTheme = theme;
    try { miniWindow.webContents.send(channels.miniPlayerTheme, theme); } catch { /* Window closing. */ }
  }

  /**
   * One tick of taskbar maintenance. Runs 4x/s because the taskbar repaints and re-raises itself
   * far more often than the old 1.5 s heartbeat; the same tick re-measures the free band (so the
   * strip follows the taskbar when buttons come and go) and re-inserts the window at the top of
   * the top-most band, which is what actually keeps it from being painted over.
   */
  function maintainStrip(): void {
    if (!miniWindow || miniWindow.isDestroyed()) return;
    // A renderer drag owns the position until it ends; only keep the z-order correct meanwhile.
    if (dragOrigin) {
      raiseAboveTaskbar(miniWindow.getNativeWindowHandle());
      return;
    }
    const display = primaryDisplay();
    try {
      const layout = readTaskbarLayout(display);
      // The native layout also reports a full-screen foreground; the work-area fallback covers
      // platforms where the Win32 layer is unavailable.
      const fullscreen = layout ? layout.fullscreen : isFullscreenBand(display.bounds, display.workArea);
      if (fullscreen) { hideStrip(); return; }

      if (mode === 'float') {
        if (!miniWindow.isVisible()) miniWindow.showInactive();
        if (!miniWindow.isAlwaysOnTop()) miniWindow.setAlwaysOnTop(true, 'floating');
        return;
      }

      const placement = dockedPlacement(latest.taskbarX, layout);
      if (!placement) { hideStrip(); return; }
      lastGap = placement.gap;
      const current = miniWindow.getBounds();
      const { rect } = placement;
      if (current.x !== rect.x || current.y !== rect.y
        || current.width !== rect.width || current.height !== rect.height) {
        miniWindow.setBounds(rect);
      }
      if (!miniWindow.isVisible()) miniWindow.showInactive();
      if (!miniWindow.isAlwaysOnTop()) miniWindow.setAlwaysOnTop(true, 'floating');
      raiseAboveTaskbar(miniWindow.getNativeWindowHandle());
      pushTheme();
    } catch { /* Window closing. */ }
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
    maintainStrip();
    if (pendingState) sendState(pendingState);
  }

  // Recompute the rectangle from live display metrics. Cheap, idempotent, and the single source
  // of truth for both modes: saved anchors are clamped, never trusted verbatim.
  function syncBounds(): void {
    // Never yank the strip while the user is dragging it (a volume change can arrive mid-drag).
    if (!miniWindow || miniWindow.isDestroyed() || dragOrigin) return;
    if (mode === 'taskbar') { maintainStrip(); return; }
    const [px, py] = miniWindow.getPosition();
    const target = clampRectangle(px, py, primaryDisplay().workArea, FLOAT_SIZE) as Rect;
    if (target.x !== px || target.y !== py) miniWindow.setPosition(target.x, target.y);
  }

  function createWindow(settings: MiniPlayerSettings): void {
    const taskbarMode = settings.embedInTaskbar;
    const initial = taskbarMode
      ? (dockedPlacement(settings.taskbarX, readTaskbarLayout(primaryDisplay()))?.rect ?? taskbarRect(settings.taskbarX))
      : floatRect(settings);
    const window = new BrowserWindow({
      ...initial,
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
    // A tool window owned by no one: no taskbar button, never activated by a click, and the
    // Win32 layer also strips WS_EX_APPWINDOW so it cannot show up in Alt+Tab.
    if (taskbarMode) adoptTaskbarWindow(window.getNativeWindowHandle());
    // 'floating' keeps the strip above the taskbar (even when the taskbar is always-on-top) but
    // 'floating' keeps the strip in the top-most band. That alone is not enough — Explorer
    // re-raises the taskbar and paints over it — so maintainStrip() re-inserts the window at the
    // top of that band every tick, and hides it while a full-screen app owns the display.
    window.setAlwaysOnTop(true, 'floating');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    // Identity-checked teardown: a rebuilt window must not be cleared by the old window's events.
    window.once('closed', () => {
      if (miniWindow !== window) return;
      miniWindow = null;
      mode = null;
    });
    // Dragging: in taskbar mode the strip slides along the taskbar only. x stays where the user
    // dropped it (clamped into the measured free band so it can never cover the app buttons or the
    // clock), y is pinned to the band. 'move' fires while the native drag loop runs or while the
    // renderer streams cursor moves; 'moved' only fires for native drags.
    window.on('move', () => {
      if (window.isDestroyed() || mode !== 'taskbar' || snapping) return;
      const [px, py] = window.getPosition();
      const bounds = window.getBounds();
      const gap = lastGap;
      const clampedX = gap ? clampDockedX(gap, bounds.width, px) : null;
      const targetX = clampedX ?? taskbarRect(px).x;
      const targetY = gap
        ? Math.round(gap.y + (gap.height - Math.min(bounds.height, gap.height)) / 2)
        : taskbarRect(px).y;
      if (targetX !== px || targetY !== py) {
        window.setBounds({ ...bounds, x: targetX, y: targetY });
      }
    });
    window.on('moved', () => {
      if (window.isDestroyed() || snapping) return;
      const [px, py] = window.getPosition();
      snapping = true;
      try {
        if (mode === 'taskbar') {
          const bounds = window.getBounds();
          const gap = lastGap;
          const clampedX = gap ? clampDockedX(gap, bounds.width, px) : null;
          const targetX = clampedX ?? taskbarRect(px).x;
          const targetY = gap
            ? Math.round(gap.y + (gap.height - Math.min(bounds.height, gap.height)) / 2)
            : taskbarRect(px).y;
          if (targetX !== px || targetY !== py) {
            window.setBounds({ ...bounds, x: targetX, y: targetY });
          }
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
    const onDisplayChange = () => { syncBounds(); maintainStrip(); };
    screen.on('display-added', onDisplayChange);
    screen.on('display-removed', onDisplayChange);
    screen.on('display-metrics-changed', onDisplayChange);
    stopHeartbeat();
    heartbeat = setInterval(maintainStrip, TASKBAR_TICK_MS);
    window.once('closed', () => {
      screen.removeListener('display-added', onDisplayChange);
      screen.removeListener('display-removed', onDisplayChange);
      screen.removeListener('display-metrics-changed', onDisplayChange);
      stopHeartbeat();
    });
    void window.loadFile(join(__dirname, '../renderer/mini.html'), { query: { mode } }).then(() => {
      if (window.isDestroyed()) return;
      window.showInactive();
      maintainStrip();
      pushTheme(true);
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
      // Snap into the measured free band: never over the app buttons, never over the clock/tray.
      const bounds = miniWindow.getBounds();
      const gap = lastGap;
      const snappedX = gap ? clampDockedX(gap, bounds.width, x) : null;
      const target = snappedX === null
        ? taskbarRect(x)
        : {
          ...bounds,
          x: snappedX,
          y: Math.round(gap!.y + (gap!.height - Math.min(bounds.height, gap!.height)) / 2),
        };
      miniWindow.setBounds(target);
      writeSettings({ taskbarX: miniWindow.getPosition()[0] });
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
