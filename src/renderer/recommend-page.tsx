import { useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { TrackTable } from './components';
import {
  DIMENSION_LABELS, LANGUAGE_LABELS, VERSION_LABELS,
  batchOf, buildRecommendationModel, buildTasteProfile, formatClock, rankCandidates,
} from './recommend.mjs';
import type { LibraryContext } from './pages';
import type { Result, Track } from '../shared/types';

const PAGE = 50;
// Bounded so opening the page stays fast even for very large libraries.
const MAX_SEED_FAVORITE_PAGES = 2;
const MAX_SEED_PLAYLISTS = 4;
const MAX_ARTIST_SEEDS = 8;
const MAX_ALBUM_SEEDS = 5;
const POOL_LIMIT = 120;
const BATCH_SIZE = 20;
// Seeds carry different confidence: a saved song says more than a playlist entry, which in
// turn says more than something that merely showed up in the play history.
const FAVORITE_WEIGHT = 1;
const PLAYLIST_WEIGHT = 0.7;
const HISTORY_WEIGHT = 0.5;
const DIMENSION_SUMMARY = [DIMENSION_LABELS.artist, DIMENSION_LABELS.album, DIMENSION_LABELS.playlist,
  DIMENSION_LABELS.language, DIMENSION_LABELS.duration].join(' / ');

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
 * derived from what the user actually keeps (saved songs, collected playlists, play history)
 * and candidates are the catalogue rows we can really fetch: same artist, same album, and the
 * songs sitting in the collected playlists. Every candidate is then ranked on five explainable
 * dimensions — artist / album / playlist co-occurrence / language / duration habits — instead
 * of a single "more of the same artist" pass.
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
        }
        addSeeds(result.tracks, FAVORITE_WEIGHT);
        start = result.nextStart;
        hasMore = result.hasMore;
      }

      // Collected playlists broaden the taste profile and double as a candidate source:
      // a song that sits in several of them is a real signal, favourited or not.
      const list = await readResult(window.desktop.music.playlists({ refresh }));
      if (epoch !== requestId.current) return;
      const collected = (list?.playlists ?? []).filter(item => item.kind === 'collected').slice(0, MAX_SEED_PLAYLISTS);
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

      // Play history is the weakest but freshest signal — it only feeds the profile.
      const history = await readResult(window.desktop.music.history());
      if (epoch !== requestId.current) return;
      const historyTracks = history?.tracks ?? [];
      addSeeds(historyTracks, HISTORY_WEIGHT);

      const profile = buildTasteProfile(seeds);
      const model = buildRecommendationModel(profile, { playlistHits });
      const artistSeeds = profile.artists.slice(0, MAX_ARTIST_SEEDS);
      const albumSeeds = profile.albums.slice(0, MAX_ALBUM_SEEDS);
      setReasons(artistSeeds.slice(0, 6));
      setDimensions([
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
      if (!artistSeeds.length && !albumSeeds.length && !playlistTracks.length) {
        setError('收藏歌曲里缺少歌手或专辑信息，暂时无法生成推荐。');
        setPool([]); setSummary(''); setDimensions([]); setLoaded(true);
        return;
      }

      const [artistDetails, albumDetails] = await Promise.all([
        Promise.all(artistSeeds.map(async seed => ({
          seed,
          detail: await readResult(window.desktop.music.artist({ id: seed.id })),
        }))),
        Promise.all(albumSeeds.map(async seed => ({
          seed,
          detail: await readResult(window.desktop.music.album({ id: seed.id, start: 0, limit: PAGE })),
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
      ];
      const playlistCandidates = playlistTracks.filter(track => !favoriteIds.has(track.id));
      if (playlistCandidates.length) {
        groups.push({ key: 'playlist:cooccurrence', weight: playlistCandidates.length, tracks: playlistCandidates });
      }

      // Score every candidate on all dimensions, then diversify per artist.
      const ranked = rankCandidates(groups.flatMap(group => group.tracks), {
        limit: POOL_LIMIT,
        model,
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
        playlistCandidates.length ? `${playlistCandidates.length} 首歌单曲目` : '',
      ].filter(Boolean).join('、');
      setSummary(`基于 ${sourceParts}，从 ${candidateParts}中挑出 ${ranked.length} 首候选，按 ${DIMENSION_SUMMARY} 排序`);
      setLoaded(true);
      if (!ranked.length) {
        setSummary('');
        setError('暂时没有找到新的推荐歌曲，试试多收藏几位歌手的作品。');
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
      if (item.reasons.length) map.set(item.track.id, item.reasons.slice(0, 2).join(' · '));
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
        <p>{loading ? '正在分析你的收藏、歌单与最近播放…' : (summary || error || '根据你的收藏歌单，发现你可能喜欢的歌曲。')}</p>
        {!!dimensions.length && !loading && <p className="recommend-dims">
          <span>画像</span>
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
