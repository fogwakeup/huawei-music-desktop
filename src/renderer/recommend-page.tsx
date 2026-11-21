import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { TrackTable } from './components';
import {
  LANGUAGE_LABELS, VERSION_LABELS,
  batchOf, buildRecommendationModel, buildScoreProfile, buildSearchKeywords, buildTasteProfile,
  buildThemeTokens, formatClock, isAccompaniment, rankCandidates, secondHopSeeds,
} from './recommend.mjs';
import type { LibraryContext } from './pages';
import type { Result, Track } from '../shared/types';

const PAGE = 50;
// Bounded so opening the page stays fast even for very large libraries.
const MAX_SEED_FAVORITE_PAGES = 2;
const MAX_SEED_PLAYLISTS = 3;
const MAX_ARTIST_SEEDS = 4;
const MAX_ALBUM_SEEDS = 3;
// New sources that actually break out of the saved artist/album bubble.
const MAX_SECOND_HOP_ARTISTS = 3;
const MAX_SECOND_HOP_ALBUMS = 2;
const MAX_SEARCH_KEYWORDS = 3;
const MAX_CHART_PLAYLISTS = 2;
const POOL_LIMIT = 120;
const BATCH_SIZE = 20;
// Seeds carry different confidence: a saved song says more than a playlist entry, which in
// turn says more than something that merely showed up in the play history.
const FAVORITE_WEIGHT = 1;
const PLAYLIST_WEIGHT = 0.7;
const HISTORY_WEIGHT = 0.5;

type TasteSeed = { id: string; name: string; count: number };
type CandidateGroup = { key: string; weight: number; tracks: Track[] };
type Recommendation = { track: Track; score: number; reasons: string[] };

async function readResult<T>(action: Promise<Result<T>>): Promise<T | null> {
  try {
    const result = await action;
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * A local recommender page. The provider has no usable recommendation endpoint, so taste is
 * derived from what the user actually keeps. Every song is scored on artist / album / language /
 * version / duration / recurring title words / playlist co-occurrence, ranked by fit, and held to
 * a learned acceptance floor. Accompaniment renditions (伴奏 / 纯音乐) are filtered out before
 * scoring, second-hop artists/albums, profile-driven search results and chart playlists widen the
 * pool, and a per-artist cap keeps one discography from taking over the list.
 */
export function RecommendPage({ ctx }: { ctx: LibraryContext }) {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pool, setPool] = useState<Recommendation[]>([]);
  const [batch, setBatch] = useState(0);
  const [reasons, setReasons] = useState<TasteSeed[]>([]);
  const [dimensions, setDimensions] = useState<TasteSeed[]>([]);
  const [summary, setSummary] = useState('');
  const [error, setError] = useState('');
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(() => new Set());
  const requestId = useRef(0);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  async function build(refresh = false) {
    const epoch = ++requestId.current;
    const context = ctxRef.current;
    setLoading(true);
    setError('');
    context.setBusy(true);
    try {
      const seeds: { track: Track; weight: number }[] = [];
      const favoriteTracks: Track[] = [];
      const favoriteIds = new Set<string>();
      const seenSeeds = new Set<string>();
      const addSeeds = (tracks: Track[], weight: number) => {
        for (const track of tracks ?? []) {
          if (!track?.id || seenSeeds.has(track.id)) continue;
          seenSeeds.add(track.id);
          seeds.push({ track, weight });
        }
      };

      // Saved songs are the strongest and most reliable preference signal.
      let start = 0;
      let hasMore = true;
      for (let page = 0; page < MAX_SEED_FAVORITE_PAGES && hasMore; page++) {
        const result = await readResult(window.desktop.music.favorites({ start, limit: PAGE, refresh }));
        if (epoch !== requestId.current) return;
        if (!result) break;
        for (const track of result.tracks) {
          context.setFavoriteState(track.id, true);
          favoriteIds.add(track.id);
          favoriteTracks.push(track);
        }
        addSeeds(result.tracks, FAVORITE_WEIGHT);
        start = result.nextStart;
        hasMore = result.hasMore;
      }

      // Collected playlists broaden the taste profile and double as a candidate source:
      // a song that sits in several of them is a real signal, favourited or not.
      // Chart playlists are candidates only — popularity is not the user's taste profile.
      const list = await readResult(window.desktop.music.playlists({ refresh }));
      if (epoch !== requestId.current) return;
      const allPlaylists = list?.playlists ?? [];
      const collected = allPlaylists.filter(item => item.kind === 'collected').slice(0, MAX_SEED_PLAYLISTS);
      const charts = allPlaylists.filter(item => item.kind === 'chart').slice(0, MAX_CHART_PLAYLISTS);
      const playlistTracks: Track[] = [];
      const playlistHits = new Map<string, number>();
      const seenInPlaylists = new Set<string>();
      for (const playlist of collected) {
        const detail = await readResult(window.desktop.music.playlistDetail({
          id: playlist.id, kind: 'collected', start: 0, limit: PAGE, refresh,
        }));
        if (epoch !== requestId.current) return;
        if (!detail) continue;
        for (const track of detail.tracks ?? []) {
          if (!track?.id) continue;
          playlistHits.set(track.id, (playlistHits.get(track.id) ?? 0) + 1);
          if (seenInPlaylists.has(track.id)) continue;
          seenInPlaylists.add(track.id);
          playlistTracks.push(track);
        }
        addSeeds(detail.tracks ?? [], PLAYLIST_WEIGHT);
      }
      const chartDetails = await Promise.all(charts.map(async playlist => ({
        playlist,
        detail: await readResult(window.desktop.music.playlistDetail({
          id: playlist.id, kind: 'chart', start: 0, limit: PAGE, refresh,
        })),
      })));
      if (epoch !== requestId.current) return;

      // Play history is the weakest but freshest signal — it only feeds the profile.
      const history = await readResult(window.desktop.music.history());
      if (epoch !== requestId.current) return;
      const historyTracks = history?.tracks ?? [];
      addSeeds(historyTracks, HISTORY_WEIGHT);

      const profile = buildTasteProfile(seeds);
      const themeTokens = buildThemeTokens(seeds, { minCount: 2, limit: 12 });
      const model = buildRecommendationModel(profile, {
        playlistHits,
        themeTokens,
        seedArtists: profile.artists.map(entry => entry.id),
        seedAlbums: profile.albums.map(entry => entry.id),
      });
      const scoreProfile = buildScoreProfile(seeds, model);
      const artistSeeds = profile.artists.slice(0, MAX_ARTIST_SEEDS);
      const albumSeeds = profile.albums.slice(0, MAX_ALBUM_SEEDS);
      setReasons(artistSeeds.slice(0, 6));
      setDimensions([
        { id: 'score', name: `口味契合线 ${Math.round(scoreProfile.floor)}+`, count: Math.round(scoreProfile.count) },
        ...themeTokens.slice(0, 3).map(entry => ({ id: `theme:${entry.key}`, name: `主题「${entry.key}」`, count: entry.count })),
        ...profile.languages
          .filter(entry => entry.key !== 'unknown' && entry.share >= 0.05)
          .slice(0, 3)
          .map(entry => ({ id: `lang:${entry.key}`, name: `${LANGUAGE_LABELS[entry.key as keyof typeof LANGUAGE_LABELS]} ${Math.round(entry.share * 100)}%`, count: entry.count })),
        ...(profile.duration
          ? [{ id: 'duration', name: `平均时长 ${formatClock(profile.duration.mean)}`, count: profile.duration.count }]
          : []),
        ...profile.versions.slice(0, 2).map(entry => ({
          id: `ver:${entry.key}`,
          name: `${VERSION_LABELS[entry.key as keyof typeof VERSION_LABELS] ?? entry.key} ${Math.round(entry.share * 100)}%`,
          count: entry.count,
        })),
      ]);

      if (!seeds.length) {
        setError('还没有读到收藏歌曲，先收藏几首喜欢的歌再来吧。');
        setPool([]); setSummary(''); setDimensions([]); setLoaded(true);
        return;
      }

      // Second-hop sources: artists/albums from playlists and history that are NOT already
      // direct saves. This is what supplies songs outside the user's usual discographies.
      // Exclude only *direct saves* here. Playlist/history artists are exactly the second
      // hop we want; excluding the whole profile would make this source permanently empty.
      const directlySavedArtists = favoriteTracks.flatMap(track =>
        (track.artists ?? []).map(artist => artist.id).filter((id): id is string => !!id));
      const second = secondHopSeeds([...playlistTracks, ...historyTracks], {
        artistIds: directlySavedArtists,
        albumIds: favoriteTracks.map(track => track.album?.id).filter((id): id is string => !!id),
      });
      const keywords = buildSearchKeywords(profile, themeTokens, { limit: MAX_SEARCH_KEYWORDS });

      const [artistDetails, albumDetails, secondArtists, secondAlbums, searchPages] = await Promise.all([
        Promise.all(artistSeeds.map(async seed => ({
          seed,
          detail: await readResult(window.desktop.music.artist({ id: seed.id })),
        }))),
        Promise.all(albumSeeds.map(async seed => ({
          seed,
          detail: await readResult(window.desktop.music.album({ id: seed.id, start: 0, limit: PAGE })),
        }))),
        Promise.all(second.artists.slice(0, MAX_SECOND_HOP_ARTISTS).map(async seed => ({
          seed,
          detail: await readResult(window.desktop.music.artist({ id: seed.id })),
        }))),
        Promise.all(second.albums.slice(0, MAX_SECOND_HOP_ALBUMS).map(async seed => ({
          seed,
          detail: await readResult(window.desktop.music.album({ id: seed.id, start: 0, limit: PAGE })),
        }))),
        Promise.all(keywords.map(async query => ({
          query,
          page: await readResult(window.desktop.music.search({ query, start: 0, limit: PAGE })),
        }))),
      ]);
      if (epoch !== requestId.current) return;

      const groups: CandidateGroup[] = [
        ...artistDetails
          .filter(item => item.detail?.tracks?.length)
          .map(item => ({ key: `artist:${item.seed.id}`, weight: item.seed.count, tracks: item.detail!.tracks })),
        ...albumDetails
          .filter(item => item.detail?.tracks?.length)
          .map(item => ({ key: `album:${item.seed.id}`, weight: item.seed.count, tracks: item.detail!.tracks })),
        ...secondArtists
          .filter(item => item.detail?.tracks?.length)
          .map(item => ({ key: `second-artist:${item.seed.id}`, weight: item.seed.count * 0.6, tracks: item.detail!.tracks })),
        ...secondAlbums
          .filter(item => item.detail?.tracks?.length)
          .map(item => ({ key: `second-album:${item.seed.id}`, weight: item.seed.count * 0.6, tracks: item.detail!.tracks })),
        ...searchPages
          .filter(item => item.page?.tracks?.length)
          .map(item => ({ key: `search:${item.query}`, weight: 2, tracks: item.page!.tracks })),
        ...chartDetails
          .filter(item => item.detail?.tracks?.length)
          .map(item => ({ key: `chart:${item.playlist.id}`, weight: 1, tracks: item.detail!.tracks })),
      ];
      const playlistCandidates = playlistTracks.filter(track => !favoriteIds.has(track.id));
      if (playlistCandidates.length) {
        groups.push({ key: 'playlist:cooccurrence', weight: playlistCandidates.length, tracks: playlistCandidates });
      }

      // Score every candidate, then rank by closeness to the target score band. Same-artist
      // and same-album rows are demoted and capped at one per artist/album in the first pass.
      // Accompaniment renditions are dropped before scoring (伴奏 is not a song); count the
      // unique ones so the header can say how much noise was filtered out.
      const candidates = groups.flatMap(group => group.tracks);
      const accompanimentIds = new Set<string>();
      if (!model.accompanimentAllowed) {
        for (const track of candidates) {
          if (!track?.id || favoriteIds.has(track.id) || hiddenIds.has(track.id)) continue;
          if (isAccompaniment(track)) accompanimentIds.add(track.id);
        }
      }
      const ranked = rankCandidates(candidates, {
        limit: POOL_LIMIT,
        model,
        scoreProfile,
        excludeIds: [...favoriteIds, ...hiddenIds],
      });
      setPool(ranked);
      setBatch(0);

      const sourceParts = [
        `${favoriteIds.size} 首收藏歌曲`,
        collected.length ? `${collected.length} 个收藏歌单` : '',
        historyTracks.length ? `${historyTracks.length} 条最近播放` : '',
      ].filter(Boolean).join('、');
      const candidateParts = [
        artistSeeds.length ? `${artistSeeds.length} 位歌手` : '',
        albumSeeds.length ? `${albumSeeds.length} 张专辑` : '',
        second.artists.length || second.albums.length
          ? `${secondArtists.length + secondAlbums.length} 个二跳来源` : '',
        keywords.length ? `${keywords.length} 组主题搜索` : '',
        charts.length ? `${charts.length} 个榜单` : '',
        playlistCandidates.length ? `${playlistCandidates.length} 首歌单曲目` : '',
      ].filter(Boolean).join('、');
      const scoreText = scoreProfile.count
        ? `契合线 ${Math.round(scoreProfile.floor)}+，收藏歌手/专辑优先`
        : '默认排序';
      const accompanimentText = accompanimentIds.size ? `，已过滤 ${accompanimentIds.size} 首伴奏/纯音乐` : '';
      setSummary(`基于 ${sourceParts}，从 ${candidateParts}中精选 ${ranked.length} 首，按口味契合度从高到低（${scoreText}，每位歌手限量避免刷屏）${accompanimentText}`);
      setLoaded(true);
      if (!ranked.length) {
        setSummary('');
        setError('暂时没有找到新的推荐歌曲，试试多收藏几首不同风格的歌。');
      }
    } finally {
      if (epoch === requestId.current) {
        setLoading(false);
        ctxRef.current.setBusy(false);
      }
    }
  }

  useEffect(() => {
    void build();
    return () => { requestId.current++; ctxRef.current.setBusy(false); };
  }, []);

  // A song favourited from this page should drop out of the recommendation list immediately.
  useEffect(() => {
    const change = ctx.favoriteChange;
    if (!change?.favorite) return;
    setHiddenIds(previous => previous.has(change.trackId)
      ? previous
      : new Set(previous).add(change.trackId));
  }, [ctx.favoriteChange]);

  const reasonById = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of pool) {
      map.set(item.track.id, [`评分 ${Math.round(item.score)}`, ...item.reasons.slice(0, 2)].join(' · '));
    }
    return map;
  }, [pool]);

  const currentBatch = batchOf(pool, BATCH_SIZE, batch);
  const visible = currentBatch
    .filter(item => !hiddenIds.has(item.track.id))
    .map(item => item.track);
  const totalBatches = Math.max(1, Math.ceil(pool.length / BATCH_SIZE));

  return <section className="library recommend-library">
    <header className="recommend-hero">
      <span className="recommend-icon"><Sparkles size={21} /></span>
      <div className="recommend-heading">
        <h2>猜你喜欢</h2>
        <p>{loading ? '正在分析你的收藏、歌单与最近播放…' : (summary || error || '根据你的收藏口味，精选契合度最高的新歌。')}</p>
        {!!dimensions.length && !loading && <p className="recommend-dims">
          <span>评分画像</span>
          {dimensions.map(item => <span key={item.id} className="recommend-dim">{item.name}</span>)}
        </p>}
        {!!reasons.length && !loading && <p className="recommend-reasons">
          <span>灵感来自</span>
          {reasons.map(seed => <button key={seed.id} className="recommend-chip"
            title={`查看 ${seed.name} 的歌曲`} onClick={() => ctx.openArtist(seed.id)}>{seed.name}</button>)}
        </p>}
      </div>
      <div className="recommend-controls">
        <button className="ghost" title="显示下一批候选歌曲" onClick={() => setBatch(index => index + 1)}
          disabled={loading || pool.length <= BATCH_SIZE}><RefreshCw size={14} />换一批</button>
        <button className="ghost" title="重新读取收藏并分析" onClick={() => void build(true)} disabled={loading}>
          <Sparkles size={14} />重新分析
        </button>
      </div>
    </header>
    {!!visible.length && <div className="library-head">
      <span>推荐歌曲</span>
      <span className="hint">第 {(batch % totalBatches) + 1} / {totalBatches} 批 · 共 {pool.length} 首候选</span>
    </div>}
    <TrackTable tracks={visible} actions={ctx} busy={loading}
      subtitleOf={track => reasonById.get(track.id)}
      emptyText={loading ? '正在寻找推荐…' : error || (loaded ? '暂时没有推荐，先收藏一些歌曲吧。' : '读取中…')} />
  </section>;
}
