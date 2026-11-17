import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopLyricsAppearance, DesktopLyricsStylePatch, DesktopLyricsUpdate } from '../shared/types';

// Channel names are inlined on purpose: a sandboxed preload cannot require sibling chunks,
// so this entry must stay free of shared imports (keep names in sync with shared/channels.ts).
const RENDER_CHANNEL = 'desktop-lyrics:render';
const STATE_CHANNEL = 'desktop-lyrics:state';
const SET_LOCKED_CHANNEL = 'desktop-lyrics:set-locked';
const REQUEST_CLOSE_CHANNEL = 'desktop-lyrics:request-close';
const STYLE_CHANNEL = 'desktop-lyrics:style';
const PANEL_CHANNEL = 'desktop-lyrics:panel';
const DRAG_START_CHANNEL = 'desktop-lyrics:drag-start';
const DRAG_MOVE_CHANNEL = 'desktop-lyrics:drag-move';
const DRAG_END_CHANNEL = 'desktop-lyrics:drag-end';

// Minimal bridge for the lyrics overlay: subscribe to sanitized render payloads, adjust the look
// and request lock/close/panel. No auth, no music, no settings surface is reachable from here.
const api = {
  onUpdate: (listener: (payload: DesktopLyricsUpdate) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: DesktopLyricsUpdate) => listener(payload);
    ipcRenderer.on(RENDER_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(RENDER_CHANNEL, wrapped);
  },
  onState: (listener: (state: DesktopLyricsAppearance) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: DesktopLyricsAppearance) => listener(state);
    ipcRenderer.on(STATE_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(STATE_CHANNEL, wrapped);
  },
  setLocked: (locked: boolean) => { ipcRenderer.send(SET_LOCKED_CHANNEL, locked); },
  requestClose: () => { ipcRenderer.send(REQUEST_CLOSE_CHANNEL); },
  setStyle: (patch: DesktopLyricsStylePatch) => { ipcRenderer.send(STYLE_CHANNEL, patch); },
  setPanelOpen: (open: boolean) => { ipcRenderer.send(PANEL_CHANNEL, open); },
  dragStart: () => { ipcRenderer.send(DRAG_START_CHANNEL); },
  dragMove: () => { ipcRenderer.send(DRAG_MOVE_CHANNEL); },
  endDrag: () => { ipcRenderer.send(DRAG_END_CHANNEL); },
};

contextBridge.exposeInMainWorld('desktopLyricsWindow', api);
