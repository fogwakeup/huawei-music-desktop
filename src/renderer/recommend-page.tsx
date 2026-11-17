import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { TrackTable } from './components';
import { batchOf, buildRecommendationPool, buildTasteProfile } from './recommend.mjs';
import type { LibraryContext } from './pages';
import type { Result, Track } from '../shared/types';

const PAGE = 50;
// Bounded so opening the page stays fast even for very large libraries.
const MAX_SEED_FAVORITE_PAGES = 2;
const MAX_SEED_PLAYLISTS = 4;
const MAX_ARTIST_SEEDS = 6;
const MAX_ALBUM_SEEDS = 4;
const POOL_LIMIT = 120;
const BATCH_SIZE = 20;

type TasteSeed = { id: string; name: string; count: number };
type CandidateGroup = { key: string; weight: number; tracks: Track[] };

async function readResult<T>(action: Promise<Result<T>>): Promise<T | null> {
  try {
    const result = await action;
    return result.ok ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * A local recommender page: saved songs (plus collected playlists) are the taste seeds,
 * and candidates are the other tracks by those artists / from those albums. The provider
 * has no usable recommendation endpoint, so nothing here pretends to be a server feed.
 */
export function RecommendPage({ ctx }: { ctx: LibraryContext }) {
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [pool, setPool] = useState<Track[]>([]);
  const [batch, setBatch] = useState(0);
  const [reasons, setReasons] = useState<TasteSeed[]>([]);
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
      const seedTracks: Track[] = [];
      const seedIds = new Set<string>();
      const addSeeds = (tracks: Track[]) => {
        for (const track of tracks ?? []) {
          if (!track?.id || seedIds.has(track.id)) continue;
          seedIds.add(track.id);
          seedTracks.push(track);
        }
      };

      // Saved songs are the strongest and most reliable preference signal.
      let start = 0;
      let hasMore = true;
      for (let page = 0; page < MAX_SEED_FAVORITE_PAGES && hasMore; page++) {
        const result = await readResult(window.desktop.music.favorites({ start, limit: PAGE, refresh }));
        if (epoch !== requestId.current) return;
        if (!result) break;
        for (const track of result.tracks) context.setFavoriteState(track.id, true);
        addSeeds(result.tracks);
        start = result.nextStart;
        hasMore = result.hasMore;
      }

      // Collected playlists broaden the taste profile. This is best effort: a single
      // unreadable playlist must not prevent recommendations from the saved songs.
      const list = await readResult(window.desktop.music.playlists({ refresh }));
      if (epoch !== requestId.current) return;
      const collected = (list?.playlists ?? []).filter(item => item.kind === 'collected').slice(0, MAX_SEED_PLAYLISTS);
      for (const playlist of collected) {
        const detail = await readResult(window.desktop.music.playlistDetail({
          id: playlist.id, kind: 'collected', start: 0, limit: PAGE, refresh,
        }));
        if (epoch !== requestId.current) return;
        if (detail) addSeeds(detail.tracks);
      }

      const profile = buildTasteProfile(seedTracks);
      const artistSeeds = profile.artists.slice(0, MAX_ARTIST_SEEDS);
      const albumSeeds = profile.albums.slice(0, MAX_ALBUM_SEEDS);
      setReasons(artistSeeds.slice(0, 6));

      if (!seedIds.size) {
        setError('还没有读到收藏歌曲，先收藏几首喜欢的歌再来吧。');
        setPool([]); setSummary(''); setLoaded(true);
        return;
      }
      if (!artistSeeds.length && !albumSeeds.length) {
        setError('收藏歌曲里缺少歌手或专辑信息，暂时无法生成推荐。');
        setPool([]); setSummary(''); setLoaded(true);
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
      const nextPool = buildRecommendationPool(groups, [...seedIds, ...hiddenIds], { limit: POOL_LIMIT });
      setPool(nextPool);
      setBatch(0);
      setSummary(`基于 ${seedTracks.length} 首收藏歌曲${collected.length ? `、${collected.length} 个收藏歌单` : ''}，从 ${artistSeeds.length} 位歌手和 ${albumSeeds.length} 张专辑中挑出 ${nextPool.length} 首候选`);
      setLoaded(true);
      if (!nextPool.length) setError('暂时没有找到新的推荐歌曲，试试多收藏几位歌手的作品。');
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

  const visible = batchOf(pool, BATCH_SIZE, batch).filter(track => !hiddenIds.has(track.id));
  const totalBatches = Math.max(1, Math.ceil(pool.length / BATCH_SIZE));

  return <section className="library recommend-library">
    <header className="recommend-hero">
      <span className="recommend-icon"><Sparkles size={21} /></span>
      <div className="recommend-heading">
        <h2>猜你喜欢</h2>
        <p>{loading ? '正在分析你的收藏并寻找相似歌曲…' : (summary || error || '根据你的收藏歌单，发现你可能喜欢的歌曲。')}</p>
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
      emptyText={loading ? '正在寻找推荐…' : error || (loaded ? '暂时没有推荐，先收藏一些歌曲吧。' : '读取中…')} />
  </section>;
}
