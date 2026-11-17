import { contextBridge, ipcRenderer } from 'electron';
import { channels } from '../shared/channels';
import type { AppSettings, DesktopApi, DesktopLyricsUpdate, MiniPlayerState, PlayerCommand } from '../shared/types';

const api: DesktopApi = {
  auth: {
    status: () => ipcRenderer.invoke(channels.authStatus),
    login: () => ipcRenderer.invoke(channels.authLogin),
    logout: () => ipcRenderer.invoke(channels.authLogout),
    cancelLogin: () => ipcRenderer.invoke(channels.authCancelLogin),
    onProgress: listener => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
      ipcRenderer.on('auth:progress', wrapped);
      return () => ipcRenderer.removeListener('auth:progress', wrapped);
    },
  },
  music: {
    favorites: input => ipcRenderer.invoke(channels.musicFavorites, input),
    favoritesSummary: () => ipcRenderer.invoke(channels.musicFavoritesSummary),
    playlists: input => ipcRenderer.invoke(channels.musicPlaylists, input),
    playlistDetail: input => ipcRenderer.invoke(channels.musicPlaylistDetail, input),
    search: input => ipcRenderer.invoke(channels.musicSearch, input),
    history: () => ipcRenderer.invoke(channels.musicHistory),
    album: input => ipcRenderer.invoke(channels.musicAlbum, input),
    artist: input => ipcRenderer.invoke(channels.musicArtist, input),
    lyrics: input => ipcRenderer.invoke(channels.musicLyrics, input),
    resolvePlayback: input => ipcRenderer.invoke(channels.musicResolvePlayback, input),
    reportPlayback: input => ipcRenderer.invoke(channels.musicReportPlayback, input),
    favoriteState: input => ipcRenderer.invoke(channels.musicFavoriteState, input),
    setFavorite: input => ipcRenderer.invoke(channels.musicSetFavorite, input),
    createPlaylist: input => ipcRenderer.invoke(channels.musicCreatePlaylist, input),
    updatePlaylistDescription: input => ipcRenderer.invoke(channels.musicUpdatePlaylistDescription, input),
    deletePlaylist: input => ipcRenderer.invoke(channels.musicDeletePlaylist, input),
  },
  settings: {
    get: () => ipcRenderer.invoke(channels.settingsGet),
    update: input => ipcRenderer.invoke(channels.settingsUpdate, input),
    pickBackgroundImage: () => ipcRenderer.invoke(channels.settingsPickBackground),
  },
  queue: {
    load: () => ipcRenderer.invoke(channels.queueLoad),
    save: input => ipcRenderer.invoke(channels.queueSave, input),
  },
  fonts: {
    list: () => ipcRenderer.invoke(channels.fontsList),
  },
  lyrics: {
    importLocal: trackId => ipcRenderer.invoke(channels.lyricsImport, { trackId }),
    removeLocal: trackId => ipcRenderer.invoke(channels.lyricsRemoveLocal, { trackId }),
    cacheInfo: () => ipcRenderer.invoke(channels.lyricsCacheInfo),
    clearCache: input => ipcRenderer.invoke(channels.lyricsClearCache, input ?? {}),
  },
  window: {
    minimize: () => ipcRenderer.invoke(channels.windowMinimize),
    toggleMaximize: () => ipcRenderer.invoke(channels.windowToggleMaximize),
    close: () => ipcRenderer.invoke(channels.windowClose),
    hideToTray: () => ipcRenderer.invoke(channels.windowHideToTray),
    setCloseBehavior: input => ipcRenderer.invoke(channels.windowSetCloseBehavior, input),
  },
  app: { quit: () => ipcRenderer.invoke(channels.appQuit) },
  player: {
    onCommand: listener => {
      const wrapped = (_event: Electron.IpcRendererEvent, command: PlayerCommand) => listener(command);
      ipcRenderer.on(channels.playerCommand, wrapped);
      return () => ipcRenderer.removeListener(channels.playerCommand, wrapped);
    },
  },
  desktopLyrics: {
    update: (input: DesktopLyricsUpdate) => { ipcRenderer.send(channels.desktopLyricsUpdate, input); },
  },
  miniPlayer: {
    update: (input: MiniPlayerState) => { ipcRenderer.send(channels.miniPlayerUpdate, input); },
  },
  onNotice: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, message: string) => listener(message);
    ipcRenderer.on(channels.appNotice, wrapped);
    return () => ipcRenderer.removeListener(channels.appNotice, wrapped);
  },
  onSettingsChanged: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, settings: AppSettings) => listener(settings);
    ipcRenderer.on(channels.settingsChanged, wrapped);
    return () => ipcRenderer.removeListener(channels.settingsChanged, wrapped);
  },
};

contextBridge.exposeInMainWorld('desktop', api);
