import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Ban, ChevronUp, Heart, Headphones, ListMinus, ListMusic, Minimize2, Music2, Pause, Play, SkipBack, SkipForward, Trash2, Volume2, VolumeX, X,
} from 'lucide-react';
import { activeLyricIndex } from '../lyrics.mjs';
import { QUALITY_LABELS, QUALITY_ORDER } from '../shared/qualities.mjs';
import type { LyricsDoc, Playlist, Quality, Track } from '../shared/types';

export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '—';
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

export type TrackActions = {
  currentTrackId: string | null;
  playing: boolean;
  favoriteOf(trackId: string): boolean | undefined;
  play(tracks: Track[], index: number): void;
  playNext(track: Track): void;
  toggleFavorite(track: Track, favorite: boolean): void;
  openAlbum(id: string): void;
  openArtist(id: string): void;
  isInQueue?(trackId: string): boolean;
  removeFromQueue?(track: Track): void;
};

type TrackTableProps = {
  tracks: Track[];
  actions: TrackActions;
  onLoadMore?: () => void;
  hasMore?: boolean;
  busy?: boolean;
  loadMoreLabel?: string;
  emptyText?: string;
  /** Optional page-specific delete action, e.g. "从本机历史移除". */
  onRemoveFromList?: (track: Track) => void;
  listRemoveLabel?: string;
  /** Optional per-row note under the title, e.g. why this song was recommended. */
  subtitleOf?: (track: Track) => string | undefined;
};

type ContextMenuItem = {
  label: string;
  icon: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  danger?: boolean;
};

// Covers come from several CDN hosts (some legacy ones are plain http and get blocked by CSP).
// A failed image must fall back to the glyph instead of showing a broken-image icon.
export function Cover({ src, icon, className }: { src?: string; icon: ReactNode; className?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (!src || failed) return <>{icon}</>;
  return <img className={className} src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}

function TrackArt({ track, size = 20 }: { track: Track; size?: number }) {
  return <span className="track-art">
    <Cover src={track.coverUrl} icon={<Music2 size={size} />} />
  </span>;
}

export function TrackTable({ tracks, actions, onLoadMore, hasMore, busy, loadMoreLabel = '加载更多', emptyText, onRemoveFromList, listRemoveLabel, subtitleOf }: TrackTableProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  // Close on any outside click / Escape / layout change. A second right-click is handled by
  // the row itself (it replaces the menu), so no window-level contextmenu listener here.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const scrollRoot = document.querySelector('.main-content');
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    scrollRoot?.addEventListener('scroll', close, { passive: true });
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
      scrollRoot?.removeEventListener('scroll', close);
    };
  }, [menu]);

  function openMenu(event: ReactMouseEvent, track: Track, index: number, favorite: boolean | undefined, key: string) {
    event.preventDefault();
    event.stopPropagation();
    setSelected(key);
    const unavailable = !track.available;
    const items: ContextMenuItem[] = [
      { label: '播放', icon: <Play size={13} fill="currentColor" />, disabled: unavailable, onSelect: () => actions.play(tracks, index) },
      { label: '下一首播放', icon: <SkipForward size={13} fill="currentColor" />, disabled: unavailable, onSelect: () => actions.playNext(track) },
      {
        label: favorite ? '取消收藏' : '收藏',
        icon: <Heart size={13} fill={favorite ? 'currentColor' : 'none'} />,
        onSelect: () => { actions.toggleFavorite(track, !favorite); },
      },
    ];
    if (actions.removeFromQueue) items.push({
      label: '从播放队列移除',
      icon: <ListMinus size={13} />,
      disabled: actions.isInQueue ? !actions.isInQueue(track.id) : false,
      onSelect: () => { actions.removeFromQueue?.(track); },
    });
    if (onRemoveFromList && listRemoveLabel) items.push({
      label: listRemoveLabel,
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: () => { onRemoveFromList(track); },
    });
    const menuWidth = 208;
    const menuHeight = items.length * 34 + 12;
    setMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      items,
    });
  }

  const menuNode = menu
    ? createPortal(
      <div className="track-context-menu" role="menu" aria-label="歌曲操作" style={{ left: menu.x, top: menu.y }}
        onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
        {menu.items.map(item => <button key={item.label} role="menuitem" className={item.danger ? 'danger' : ''}
          disabled={item.disabled} onClick={() => { item.onSelect(); setMenu(null); }}>
          {item.icon}<span>{item.label}</span>
        </button>)}
      </div>,
      document.body,
    )
    : null;

  if (!tracks.length) return <div className="list-empty"><p>{emptyText ?? '这里还没有内容。'}</p></div>;
  return <>
    <div className="track-list">
      {tracks.map((track, index) => {
        const favorite = actions.favoriteOf(track.id);
        const current = actions.currentTrackId === track.id;
        const key = `${track.id}-${index}`;
        const unavailable = !track.available;
        const subtitle = subtitleOf?.(track);
        return <div
          key={key}
          className={`track-row ${current ? 'is-current' : ''} ${selected === key ? 'is-selected' : ''} ${unavailable ? 'is-unavailable' : ''}`}
          role="button"
          tabIndex={0}
          aria-label={`${track.title}，${track.artists.map(artist => artist.name).join('、') || '未知艺人'}${unavailable ? '，无版权' : ''}`}
          onClick={() => setSelected(key)}
          onContextMenu={event => openMenu(event, track, index, favorite, key)}
          onDoubleClick={() => { if (!unavailable) actions.play(tracks, index); }}
          onKeyDown={event => {
            if (event.target === event.currentTarget && !unavailable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); actions.play(tracks, index); }
          }}
        >
          <span className="track-index">
            <span className="num">{String(index + 1).padStart(2, '0')}</span>
            <button
              className="track-play"
              aria-label={unavailable ? `无版权：${track.title}` : `播放 ${track.title}`}
              disabled={unavailable}
              onClick={event => { event.stopPropagation(); if (!unavailable) actions.play(tracks, index); }}
            >
              {unavailable ? <Ban size={11} /> : current && actions.playing ? <Pause size={11} fill="currentColor" /> : <Play size={11} fill="currentColor" />}
            </button>
          </span>
          <TrackArt track={track} />
          <span className="track-title" title={track.title}>
            <span className="track-name">{track.title}</span>
            <small>
              {track.artists.map(artist => artist.id
                ? <button key={artist.id} className="link" onClick={event => { event.stopPropagation(); actions.openArtist(artist.id!); }}>{artist.name}</button>
                : <span key={artist.name}>{artist.name}</span>)
                .reduce<ReactNode[]>((nodes, node, at) => (at === 0 ? [node] : [...nodes, ' / ', node]), [])}
              {!track.artists.length && '未知艺人'}
            </small>
            {subtitle && <em className="track-why">{subtitle}</em>}
          </span>
          <span className="track-album">
            {track.album?.id
              ? <button className="link" onClick={event => { event.stopPropagation(); actions.openAlbum(track.album!.id); }}>{track.album.title}</button>
              : track.album?.title ?? '—'}
          </span>
          <span className="track-duration">{formatDuration(track.durationSeconds)}</span>
          <button
            className="play-next-toggle"
            aria-label={`下一首播放 ${track.title}`}
            title="下一首播放"
            disabled={unavailable}
            onClick={event => { event.stopPropagation(); if (!unavailable) actions.playNext(track); }}
          >
            <SkipForward size={14} fill="currentColor" />
          </button>
          <button
            className={`favorite-toggle ${favorite ? 'on' : ''}`}
            aria-label={favorite === undefined ? `切换收藏 ${track.title}` : favorite ? `取消收藏 ${track.title}` : `收藏 ${track.title}`}
            aria-pressed={!!favorite}
            title={favorite === undefined ? '先核对服务端收藏状态，再切换' : undefined}
            onClick={event => { event.stopPropagation(); actions.toggleFavorite(track, !favorite); }}
          >
            <Heart size={14} fill={favorite ? 'currentColor' : 'none'} />
          </button>
        </div>;
      })}
    </div>
    {hasMore && onLoadMore && <button className="ghost load-more" onClick={onLoadMore} disabled={busy}>{busy ? '正在读取…' : loadMoreLabel}</button>}
    {menuNode}
  </>;
}

type PlaylistsProps = { playlists: Playlist[]; onOpen(playlist: Playlist): void };

export function PlaylistGrid({ playlists, onOpen }: PlaylistsProps) {
  if (!playlists.length) return <div className="list-empty"><p>没有找到歌单。收藏歌单、自建歌单和榜单会显示在这里。</p></div>;
  return <div className="playlist-grid">
    {playlists.map(playlist => <button key={`${playlist.kind}-${playlist.id}`} className="playlist-card" onClick={() => onOpen(playlist)}>
      <span className="playlist-art"><Cover src={playlist.coverUrl} icon={<ListMusic size={22} />} /></span>
      <strong>{playlist.title}</strong>
      <small>{playlist.kind === 'owned' ? '自建歌单' : playlist.kind === 'collected' ? '收藏歌单' : playlist.kind === 'chart' ? '榜单' : '未知类型'}{playlist.count !== undefined ? ` · ${playlist.count} 首` : ''}</small>
    </button>)}
  </div>;
}

type PlayerBarProps = {
  track?: Track;
  playing: boolean;
  buffering: boolean;
  position: number;
  duration: number;
  volume: number;
  quality: Quality;
  actualQuality: Quality | 'unknown';
  qualityMenuOpen: boolean;
  repeatMode: 'off' | 'all' | 'one';
  shuffle: boolean;
  disabled: boolean;
  onToggle(): void;
  onPrevious(): void;
  onNext(): void;
  onSeekPreview(value: number): void;
  onSeekCommit(): void;
  onVolume(value: number): void;
  onToggleMute(): void;
  onToggleQualityMenu(): void;
  onChangeQuality(quality: Quality): void;
  onToggleRepeat(): void;
  onToggleShuffle(): void;
  onToggleLyrics(): void;
  onToggleDesktopLyrics(): void;
  onToggleMiniPlayer(): void;
  onToggleQueue(): void;
  onOpenStage(): void;
  lyricsOpen: boolean;
  desktopLyricsEnabled: boolean;
  miniPlayerEnabled: boolean;
  queueOpen: boolean;
  queueCount: number;
  favorite: boolean | undefined;
  onToggleFavorite(): void;
};

function percent(value: number, max: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return '0%';
  return `${Math.min(100, Math.max(0, (value / max) * 100))}%`;
}

// Menu entries for the quality picker: the track's own tiers when known, else all supported
// tiers without format hints (old cached queues carry no qualities data).
function qualityMenuOptions(track?: Track): { quality: Quality; format?: string }[] {
  const fromTrack = (track?.qualities ?? [])
    .map(item => ({ quality: item.quality, format: item.format }))
    .sort((a, b) => QUALITY_ORDER.indexOf(a.quality) - QUALITY_ORDER.indexOf(b.quality));
  if (fromTrack.length) return fromTrack;
  return QUALITY_ORDER.map(quality => ({ quality }));
}

export function PlayerBar(props: PlayerBarProps) {
  const { track, playing, buffering, position, duration, volume } = props;
  const repeatLabel = props.repeatMode === 'one' ? '单曲循环' : props.repeatMode === 'all' ? '列表循环' : '顺序播放';
  const seekMax = duration || 1;
  const shownQuality = props.actualQuality !== 'unknown' ? props.actualQuality : props.quality;
  const activeQuality = props.actualQuality !== 'unknown' ? props.actualQuality : props.quality;
  return <footer className="player">
    <div className="now-playing">
      <button className="cover" aria-label={track ? '打开播放详情页' : '尚未选择歌曲'} disabled={!track}
        onClick={props.onOpenStage} title={track ? '打开播放详情页' : undefined}>
        <Cover src={track?.coverUrl} icon={<Headphones size={18} />} />
      </button>
      <div className="now-playing-text">
        <strong>{track?.title ?? '尚未选择歌曲'}</strong>
        <span>
          {buffering ? '正在缓冲…' : playing ? '正在播放' : track ? track.artists.map(artist => artist.name).join(' / ') || '未知艺人' : '选择一首歌开始播放'}
          {props.actualQuality !== 'unknown' ? ` · ${QUALITY_LABELS[props.actualQuality]}` : ''}
        </span>
      </div>
      <button className={`favorite-toggle ${props.favorite ? 'on' : ''}`} aria-label="收藏当前歌曲" aria-pressed={!!props.favorite}
        disabled={!track} onClick={props.onToggleFavorite}>
        <Heart size={15} fill={props.favorite ? 'currentColor' : 'none'} />
      </button>
    </div>
    <div className="player-controls">
      <div className="buttons">
        <button aria-label="随机播放" aria-pressed={props.shuffle} className={props.shuffle ? 'active' : ''} onClick={props.onToggleShuffle} disabled={props.disabled} title="随机播放">
          <ListMusic size={15} />
        </button>
        <button aria-label="上一首" onClick={props.onPrevious} disabled={props.disabled}><SkipBack size={16} fill="currentColor" /></button>
        <button className="play-button" aria-label={playing ? '暂停' : '播放'} onClick={props.onToggle} disabled={props.disabled}>
          {playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
        </button>
        <button aria-label="下一首" onClick={props.onNext} disabled={props.disabled}><SkipForward size={16} fill="currentColor" /></button>
        <button aria-label={repeatLabel} aria-pressed={props.repeatMode !== 'off'} className={props.repeatMode !== 'off' ? 'active' : ''} onClick={props.onToggleRepeat} disabled={props.disabled}>
          {props.repeatMode === 'one' ? '①' : '↻'}
        </button>
      </div>
      <div className="progress">
        <span>{formatDuration(position)}</span>
        <input aria-label="播放进度" type="range" min="0" max={seekMax} step="0.1" value={Math.min(position, seekMax)}
          style={percentStyle(position, seekMax)}
          disabled={!duration} onChange={event => props.onSeekPreview(Number(event.target.value))}
          onPointerUp={props.onSeekCommit} onKeyUp={props.onSeekCommit} onBlur={props.onSeekCommit} />
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
    <div className="volume">
      <div className="quality-wrap">
        <button className="quality-button" onClick={props.onToggleQualityMenu} disabled={!track} title="选择音质（立即以当前进度换流）">{QUALITY_LABELS[shownQuality]}</button>
        {props.qualityMenuOpen && <>
          <div className="menu-backdrop" onClick={props.onToggleQualityMenu} />
          <div className="quality-menu" role="menu" aria-label="音质选择">
            {qualityMenuOptions(track).map(option => (
              <button key={option.quality} role="menuitem" aria-pressed={option.quality === activeQuality}
                className={`quality-item ${option.quality === activeQuality ? 'active' : ''}`}
                onClick={() => props.onChangeQuality(option.quality)}>
                <span>{QUALITY_LABELS[option.quality]}</span>
                <small>{option.format ?? ''}</small>
              </button>
            ))}
          </div>
        </>}
      </div>
      <button className="pill-button" aria-label="歌词" aria-pressed={props.lyricsOpen} onClick={props.onToggleLyrics} disabled={!track}>
        <ChevronUp size={13} />词
      </button>
      <button className="pill-button" aria-label="桌面歌词" aria-pressed={props.desktopLyricsEnabled} onClick={props.onToggleDesktopLyrics}
        title="显示 / 隐藏桌面悬浮歌词">
        桌面词
      </button>
      <button className="pill-button" aria-label="桌面播控条" aria-pressed={props.miniPlayerEnabled} onClick={props.onToggleMiniPlayer}
        title="显示 / 隐藏桌面状态栏播控条">
        <Music2 size={13} />状态栏
      </button>
      <button className="pill-button" aria-label="播放队列" aria-pressed={props.queueOpen} onClick={props.onToggleQueue} disabled={!props.queueCount}>
        队列 {props.queueCount}
      </button>
      <button className="icon-button" aria-label={volume > 0 ? '静音' : '取消静音'} onClick={props.onToggleMute}>
        {volume > 0 ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </button>
      <input aria-label="音量" type="range" min="0" max="1" step="0.01" value={volume}
        style={percentStyle(volume, 1)}
        onChange={event => props.onVolume(Number(event.target.value))} />
    </div>
  </footer>;
}

const LYRIC_SOURCES: Record<string, string> = { huawei: '华为音乐', kugou: '酷狗音乐', lrclib: 'LRCLIB', local: '本地文件' };

type LyricsViewProps = {
  doc: LyricsDoc | null;
  loading?: boolean;
  positionSeconds: number;
  offsetSeconds: number;
  onSeekTo(timeMs: number): void;
};

function percentStyle(value: number, max: number): CSSProperties {
  return { '--pct': percent(value, max) } as CSSProperties;
}

function useActiveLyric(doc: LyricsDoc | null, positionSeconds: number, offsetSeconds: number) {
  const lines = doc?.lines ?? [];
  return doc?.synced ? activeLyricIndex(lines, (positionSeconds + offsetSeconds) * 1000) : -1;
}

export function LyricsPanel({ doc, loading, positionSeconds, offsetSeconds, onSeekTo, onOpenStage, onImport, onRemoveLocal, onClose }: LyricsViewProps & {
  onOpenStage(): void;
  onImport(): void;
  onRemoveLocal(): void;
  onClose(): void;
}) {
  const [following, setFollowing] = useState(true);
  const container = useRef<HTMLDivElement | null>(null);
  const lines = doc?.lines ?? [];
  const activeIndex = useActiveLyric(doc, positionSeconds, offsetSeconds);
  useEffect(() => { setFollowing(true); }, [doc]);
  useEffect(() => {
    if (following && activeIndex >= 0) container.current?.querySelector('.active')?.scrollIntoView({ block: 'center', behavior: 'instant' });
  }, [activeIndex, following]);
  return <aside className="side-panel" aria-label="歌词">
    <div className="panel-head">
      <strong>歌词</strong>
      <button className="text-button" onClick={onClose}>关闭</button>
    </div>
    {doc?.source && doc.source !== 'huawei' && <p className="lyric-source">
      歌词来自 {LYRIC_SOURCES[doc.source] ?? doc.source}
      {doc.matchedTitle ? ` · 匹配「${doc.matchedTitle}${doc.matchedArtist ? ` - ${doc.matchedArtist}` : ''}」` : ''}
    </p>}
    {!doc || !lines.length
      ? <p className="panel-empty">{loading ? '正在读取歌词…' : '暂无歌词。可以换一首，或稍后重试。'}</p>
      : <><div ref={container} className={`lyrics ${doc.synced ? 'synced' : ''}`}
          onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)} tabIndex={0}
          onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) setFollowing(false); }}>
        {lines.map((line, index) => <p key={`${index}-${line.text}`}
          className={`${index === activeIndex ? 'active' : ''} ${line.translation ? 'has-translation' : ''}`}
          onClick={() => { if (line.timeMs !== null) onSeekTo(line.timeMs); }}>
          {line.text || '♪'}
          {line.translation && <span className="translation">{line.translation}</span>}
        </p>)}
      </div></>}
    <div className="panel-actions">
      {doc?.synced && !following && <button className="ghost" onClick={() => setFollowing(true)}>跟随播放</button>}
      <button className="ghost" onClick={onOpenStage}>沉浸歌词</button>
      <button className="ghost" onClick={onImport}>{doc?.source === 'local' ? '重新导入' : '导入本地歌词'}</button>
      {doc?.source === 'local' && <button className="ghost danger" onClick={onRemoveLocal}>移除本地</button>}
    </div>
  </aside>;
}

export function LyricsStage({
  track, doc, loading, positionSeconds, offsetSeconds, playing, duration, disabled,
  onSeekTo, onSeekSeconds, onToggle, onPrevious, onNext, onOffset, onImport, onRemoveLocal, onClose,
}: LyricsViewProps & {
  track?: Track;
  onImport(): void;
  onRemoveLocal(): void;
  playing: boolean;
  duration: number;
  disabled: boolean;
  onSeekSeconds(seconds: number): void;
  onToggle(): void;
  onPrevious(): void;
  onNext(): void;
  onOffset(deltaSeconds: number): void;
  onClose(): void;
}) {
  const [following, setFollowing] = useState(true);
  const container = useRef<HTMLDivElement | null>(null);
  const lines = doc?.lines ?? [];
  const activeIndex = useActiveLyric(doc, positionSeconds, offsetSeconds);
  const seekMax = duration || 1;
  useEffect(() => { setFollowing(true); }, [doc, track?.id]);
  useEffect(() => {
    if (following && activeIndex >= 0) container.current?.querySelector('.stage-line.active')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIndex, following]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return <section className="lyrics-stage" aria-label="沉浸歌词" style={{ '--stage-art': track?.coverUrl ? `url("${track.coverUrl}")` : 'none' } as CSSProperties}>
    <button className="stage-close" aria-label="退出歌词页" onClick={onClose}><X size={17} /></button>
    <div className="stage-body">
      <aside className="stage-cover-panel">
        <div className="stage-cover">
          <Cover src={track?.coverUrl} icon={<Music2 size={44} />} />
        </div>
        <h2 className="stage-title">{track?.title ?? '尚未选择歌曲'}</h2>
        <p className="stage-artist">{track?.artists.map(artist => artist.name).join(' / ') || '未知艺人'}</p>
        {track?.album?.title && <p className="stage-album">{track.album.title}</p>}
        {doc?.source && doc.source !== 'huawei' && <p className="stage-source">
          歌词来自 {LYRIC_SOURCES[doc.source] ?? doc.source}
          {doc.matchedTitle ? ` · 匹配「${doc.matchedTitle}」` : ''}
        </p>}
      </aside>
      <div className="stage-lyrics-column">
        <div ref={container} className="stage-scroll"
          onWheel={() => setFollowing(false)} onTouchMove={() => setFollowing(false)}
          onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(event.key)) setFollowing(false); }}>
          {!lines.length
            ? <p className="stage-empty">{loading ? '正在读取歌词…' : doc ? '这首暂时没有歌词。' : '暂时无法读取歌词。'}</p>
            : <div className="stage-lines">
              {lines.map((line, index) => <button key={`${index}-${line.text}`}
                className={`stage-line ${index === activeIndex ? 'active' : ''} ${line.timeMs === null ? 'no-time' : ''}`}
                aria-label={line.text || '间奏'}
                onClick={() => { if (line.timeMs !== null) onSeekTo(line.timeMs); }}>
                <span>
                  {line.segments?.length
                    ? line.segments.map((segment, at) => {
                      const passed = activeIndex === index && typeof segment.timeMs === 'number' && (positionSeconds + offsetSeconds) * 1000 >= segment.timeMs;
                      return <span key={at} className={`seg ${passed ? 'passed' : ''}`}>{segment.text}</span>;
                    })
                    : line.text || '♪'}
                </span>
                {line.translation && <span className="translation">{line.translation}</span>}
              </button>)}
            </div>}
        </div>
      </div>
    </div>
    <footer className="stage-foot">
      <div className="stage-transport">
        <button aria-label="上一首" onClick={onPrevious} disabled={disabled}><SkipBack size={17} fill="currentColor" /></button>
        <button className="stage-play" aria-label={playing ? '暂停' : '播放'} onClick={onToggle} disabled={disabled}>
          {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
        </button>
        <button aria-label="下一首" onClick={onNext} disabled={disabled}><SkipForward size={17} fill="currentColor" /></button>
      </div>
      <div className="stage-progress">
        <span>{formatDuration(positionSeconds)}</span>
        <input aria-label="播放进度" type="range" min="0" max={seekMax} step="0.1" value={Math.min(positionSeconds, seekMax)}
          style={percentStyle(positionSeconds, seekMax)}
          disabled={!duration}
          onChange={event => onSeekSeconds(Number(event.target.value))} />
        <span>{formatDuration(duration)}</span>
      </div>
      <div className="stage-tools">
        <button className={`stage-tool ${following ? 'on' : ''}`} aria-pressed={following} onClick={() => setFollowing(value => !value)}>
          <Minimize2 size={13} />{following ? '跟随中' : '已暂停'}
        </button>
        <div className="stage-tool" style={{ gap: 2 }}>
          <button aria-label="歌词提前" onClick={() => onOffset(-0.5)} disabled={!doc?.synced}>−</button>
          <span className="offset">{(offsetSeconds > 0 ? '+' : '') + offsetSeconds.toFixed(1)}s</span>
          <button aria-label="歌词延后" onClick={() => onOffset(0.5)} disabled={!doc?.synced}>+</button>
        </div>
      </div>
    </footer>
  </section>;
}

export function QueuePanel({ tracks, currentId, onSelect, onClose }: { tracks: Track[]; currentId: string | null; onSelect(index: number): void; onClose(): void }) {
  return <aside className="side-panel" aria-label="播放队列">
    <div className="panel-head"><strong>播放队列</strong><button className="text-button" onClick={onClose}>关闭</button></div>
    {!tracks.length
      ? <p className="panel-empty">队列为空。</p>
      : <ol className="queue-list">
        {tracks.map((track, index) => <li key={`${track.id}-${index}`}>
          <button className={`queue-item ${track.id === currentId ? 'active' : ''}`} onClick={() => onSelect(index)}>
            <span>{track.title}</span><small>{track.artists.map(artist => artist.name).join(' / ') || '未知艺人'}</small>
          </button>
        </li>)}
      </ol>}
  </aside>;
}
