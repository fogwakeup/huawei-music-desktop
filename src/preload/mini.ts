import { contextBridge, ipcRenderer } from 'electron';
import type { MiniPlayerCommand, MiniPlayerState } from '../shared/types';

// Channel names are inlined: a sandboxed preload cannot require sibling chunks. Keep these
// in sync with shared/channels.ts. The mini window gets state + transport commands only —
// no auth, no music library, no settings and no generic invoke.
const RENDER_CHANNEL = 'mini-player:render';
const COMMAND_CHANNEL = 'mini-player:command';
const REQUEST_CLOSE_CHANNEL = 'mini-player:request-close';
const SAVE_POSITION_CHANNEL = 'mini-player:save-position';

const api = {
  onState: (listener: (state: MiniPlayerState) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, state: MiniPlayerState) => listener(state);
    ipcRenderer.on(RENDER_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(RENDER_CHANNEL, wrapped);
  },
  command: (command: MiniPlayerCommand) => { ipcRenderer.send(COMMAND_CHANNEL, command); },
  requestClose: () => { ipcRenderer.send(REQUEST_CLOSE_CHANNEL); },
  savePosition: (position: { x: number; y: number }) => { ipcRenderer.send(SAVE_POSITION_CHANNEL, position); },
};

contextBridge.exposeInMainWorld('desktopMiniPlayer', api);
