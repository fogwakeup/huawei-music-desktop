import { contextBridge, ipcRenderer } from 'electron';
import type { MiniPlayerCommand, MiniPlayerState } from '../shared/types';

// Channel names are inlined: a sandboxed preload cannot require sibling chunks. Keep these
// in sync with shared/channels.ts. The mini window gets state + transport commands only —
// no auth, no music library, no settings and no generic invoke.
const RENDER_CHANNEL = 'mini-player:render';
const THEME_CHANNEL = 'mini-player:theme';
const COMMAND_CHANNEL = 'mini-player:command';
const REQUEST_CLOSE_CHANNEL = 'mini-player:request-close';
const SAVE_POSITION_CHANNEL = 'mini-player:save-position';
const DRAG_START_CHANNEL = 'mini-player:drag-start';
const DRAG_MOVE_CHANNEL = 'mini-player:drag-move';
const DRAG_END_CHANNEL = 'mini-player:drag-end';

const api = {
  onState: (listener: (state: MiniPlayerState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: MiniPlayerState) => listener(state);
    ipcRenderer.on(RENDER_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(RENDER_CHANNEL, wrapped);
  },
  // The taskbar theme is not the app theme: it comes from `SystemUsesLightTheme`, which only the
  // main process can read. The strip follows it so it blends with the band it is drawn on.
  onTheme: (listener: (theme: 'light' | 'dark' | null) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, theme: 'light' | 'dark' | null) => listener(theme);
    ipcRenderer.on(THEME_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(THEME_CHANNEL, wrapped);
  },
  command: (command: MiniPlayerCommand) => { ipcRenderer.send(COMMAND_CHANNEL, command); },
  requestClose: () => { ipcRenderer.send(REQUEST_CLOSE_CHANNEL); },
  savePosition: (position: { x: number; y: number }) => { ipcRenderer.send(SAVE_POSITION_CHANNEL, position); },
  // Pointer dragging is driven from the renderer because the bar never takes focus
  // (WS_EX_NOACTIVATE), which a native app-region drag needs.
  dragStart: () => { ipcRenderer.send(DRAG_START_CHANNEL); },
  dragMove: () => { ipcRenderer.send(DRAG_MOVE_CHANNEL); },
  endDrag: () => { ipcRenderer.send(DRAG_END_CHANNEL); },
};

contextBridge.exposeInMainWorld('desktopMiniPlayer', api);
