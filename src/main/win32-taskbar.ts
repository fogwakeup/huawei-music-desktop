// Win32 taskbar access through koffi (prebuilt N-API FFI) instead of a compiled addon: no
// toolchain is needed at build time and the same binary works in the packaged app.
//
// Why this exists at all: Windows 11 removed the public taskbar-extension API, so a third-party
// strip can only be a normal top-most window. Two things made the old strip misbehave and both
// need real Win32 answers:
//   - position: `workArea` only tells us how thick the taskbar is, never where its free band
//     actually starts/ends. `readTaskbarLayout()` measures it (ReBarWindow32 → TrayNotifyWnd).
//   - z-order: setting `alwaysOnTop` once puts the strip in the top-most band, but the taskbar
//     repaints and re-raises itself, so it ends up covering the strip. `raiseAboveTaskbar()`
//     re-issues SetWindowPos(HWND_TOPMOST) — a call Chromium skips when the flag is unchanged.
//
// Every export degrades to null/no-op off Windows or when koffi cannot load, so the caller keeps
// its old heuristic instead of crashing.

import { createRequire } from 'node:module';
import { screen } from 'electron';
import { isFullscreenForeground, taskbarGap } from './taskbar-dock.mjs';

export type Rect = { x: number; y: number; width: number; height: number };

export type TaskbarLayout = {
  /** Taskbar band of the primary display, in DIP. */
  taskbar: Rect;
  /** Free band between the app buttons and the tray, in DIP, or null when there is none. */
  gap: Rect | null;
  /** The taskbar is on screen (not hidden or parked off-screen for a full-screen app). */
  visible: boolean;
  /** A full-screen window owns the display, so the strip must yield. */
  fullscreen: boolean;
};

type NativeApi = {
  findTaskbar(): bigint | null;
  rect(hwnd: bigint): Rect | null;
  childRect(parent: bigint, className: string): Rect | null;
  isVisible(hwnd: bigint): boolean;
  foreground(): bigint | null;
  setToolWindow(hwnd: bigint): void;
  raiseTopmost(hwnd: bigint): void;
  systemUsesLightTheme(): boolean | null;
};

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOACTIVATE = 0x0010;
const HWND_TOPMOST = -1n;
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_NOACTIVATE = 0x08000000;
const WS_EX_APPWINDOW = 0x00040000;
// The taskbar follows `SystemUsesLightTheme`, which is a *different* switch from the
// `AppsUseLightTheme` that drives nativeTheme — a user can run dark apps on a light taskbar.
// Reading it is the only way to theme the strip the way the reference client does.
const HKEY_CURRENT_USER = 0x80000001n;
const RRF_RT_REG_DWORD = 0x10;
const PERSONALIZE_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';

let cached: NativeApi | null | undefined;

function loadNative(): NativeApi | null {
  if (cached !== undefined) return cached;
  cached = null;
  if (process.platform !== 'win32') return cached;
  try {
    const require = createRequire(import.meta.url);
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('HUAWEI_MUSIC_RECT', {
      left: 'long', top: 'long', right: 'long', bottom: 'long',
    });
    const FindWindowW = user32.func('void * __stdcall FindWindowW(const char16_t *cls, const char16_t *title)');
    const FindWindowExW = user32.func('void * __stdcall FindWindowExW(void *parent, void *after, const char16_t *cls, const char16_t *title)');
    const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ HUAWEI_MUSIC_RECT *rect)');
    const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
    const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
    const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)');
    const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr_t value)');
    const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *hwnd, intptr_t after, int x, int y, int cx, int cy, unsigned int flags)');

    const advapi32 = koffi.load('advapi32.dll');
    const RegGetValueW = advapi32.func('long __stdcall RegGetValueW(intptr_t hkey, const char16_t *subkey, const char16_t *value, unsigned int flags, void *type, void *data, void *cbData)');

    const toRect = (out: { left: number; top: number; right: number; bottom: number }): Rect => ({
      x: out.left,
      y: out.top,
      width: out.right - out.left,
      height: out.bottom - out.top,
    });

    const api: NativeApi = {
      findTaskbar: () => (FindWindowW('Shell_TrayWnd', null) as bigint | null) ?? null,
      rect: (hwnd) => {
        const out = {} as { left: number; top: number; right: number; bottom: number };
        return GetWindowRect(hwnd, out) ? toRect(out) : null;
      },
      childRect: (parent, className) => {
        const child = FindWindowExW(parent, null, className, null) as bigint | null;
        if (!child) return null;
        const out = {} as { left: number; top: number; right: number; bottom: number };
        return GetWindowRect(child, out) ? toRect(out) : null;
      },
      isVisible: hwnd => Boolean(IsWindowVisible(hwnd)),
      foreground: () => (GetForegroundWindow() as bigint | null) ?? null,
      setToolWindow: (hwnd) => {
        const current = Number(BigInt.asIntN(32, GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as bigint)) | 0;
        const next = (current | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & ~WS_EX_APPWINDOW;
        if (next !== current) SetWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt(next));
      },
      raiseTopmost: (hwnd) => {
        // NOMOVE|NOSIZE|NOACTIVATE: raise only, never activate and never resize. Chromium skips the
        // equivalent call when the top-most flag is already set, which is why the taskbar won.
        SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
      },
      systemUsesLightTheme: () => {
        // Buffers instead of `_Out_` scalars: raw memory is unambiguous for koffi, and the DWORD
        // write lands straight in the buffer we then read back.
        const data = Buffer.alloc(4);
        const size = Buffer.alloc(4);
        size.writeUInt32LE(4, 0);
        const status = RegGetValueW(HKEY_CURRENT_USER, PERSONALIZE_KEY, 'SystemUsesLightTheme', RRF_RT_REG_DWORD, null, data, size);
        return status === 0 ? data.readUInt32LE(0) === 1 : null;
      },
    };
    cached = api;
  } catch {
    cached = null;
  }
  return cached;
}

function toDip(rect: Rect): Rect {
  try {
    const converted = screen.screenToDipRect(null as unknown as Electron.BrowserWindow, rect) as Rect;
    if (converted && Number.isFinite(converted.x) && Number.isFinite(converted.width)) return converted;
  } catch { /* Older Electron builds without screenToDipRect. */ }
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  return { x: rect.x / scale, y: rect.y / scale, width: rect.width / scale, height: rect.height / scale };
}

export function hwndOf(handle: Buffer): bigint | null {
  if (!Buffer.isBuffer(handle) || handle.length < 4) return null;
  return handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
}

/**
 * Measure the primary taskbar: its band, the free gap and whether a full-screen window owns the
 * display. Null when the platform cannot answer (non-Windows, koffi missing), so callers fall
 * back to their work-area heuristic.
 */
export function readTaskbarLayout(display: Electron.Display = screen.getPrimaryDisplay()): TaskbarLayout | null {
  const native = loadNative();
  if (!native) return null;
  const taskbarHwnd = native.findTaskbar();
  if (!taskbarHwnd) return null;
  const physical = native.rect(taskbarHwnd);
  if (!physical) return null;

  const taskbar = toDip(physical);
  // Windows 11 only ships horizontal taskbars; a vertical one has no band this strip can use.
  const horizontal = taskbar.width >= taskbar.height;
  const buttons = native.childRect(taskbarHwnd, 'ReBarWindow32') ?? native.childRect(taskbarHwnd, 'MSTaskSwWClass');
  const start = native.childRect(taskbarHwnd, 'Start');
  const tray = native.childRect(taskbarHwnd, 'TrayNotifyWnd');

  const gap = horizontal
    ? taskbarGap({
      taskbar,
      start: start ? toDip(start) : null,
      buttons: buttons ? toDip(buttons) : null,
      tray: tray ? toDip(tray) : null,
    })
    : null;

  const displayBottom = display.bounds.y + display.bounds.height;
  const onScreen = native.isVisible(taskbarHwnd)
    && taskbar.y + taskbar.height > display.bounds.y + 8
    && taskbar.y < displayBottom - 8;

  const foregroundHwnd = native.foreground();
  const own = foregroundHwnd === taskbarHwnd;
  const foregroundRect = !own && foregroundHwnd ? native.rect(foregroundHwnd) : null;
  const fullscreen = foregroundRect
    ? isFullscreenForeground(toDip(foregroundRect), display.bounds)
    : false;

  return { taskbar, gap, visible: onScreen, fullscreen };
}

/** Mark the strip as a tool window: no taskbar button, never activated by a click. */
export function adoptTaskbarWindow(handle: Buffer): void {
  const native = loadNative();
  const hwnd = hwndOf(handle);
  if (!native || !hwnd) return;
  try { native.setToolWindow(hwnd); } catch { /* Explorer/OS refused; the window still works. */ }
}

/** Re-insert the strip at the top of the top-most band so the taskbar cannot paint over it. */
export function raiseAboveTaskbar(handle: Buffer): void {
  const native = loadNative();
  const hwnd = hwndOf(handle);
  if (!native || !hwnd) return;
  try { native.raiseTopmost(hwnd); } catch { /* Window closing. */ }
}

/**
 * Which theme the taskbar is drawn in: `'light'` when `SystemUsesLightTheme` is 1, `'dark'` when
 * 0, null when the registry read is unavailable (non-Windows, koffi missing, key absent) so the
 * renderer can fall back to the OS colour scheme.
 */
export function readTaskbarTheme(): 'light' | 'dark' | null {
  const native = loadNative();
  if (!native) return null;
  try {
    const light = native.systemUsesLightTheme();
    return light === null ? null : (light ? 'light' : 'dark');
  } catch {
    return null;
  }
}

export function isWin32TaskbarAvailable(): boolean {
  return loadNative() !== null;
}
