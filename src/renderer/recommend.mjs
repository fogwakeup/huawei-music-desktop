// Local, offline recommender. The provider's documented "daily recommendation" endpoint
// rejects every known request shape (HTTP 400, see docs/feature-validation.md), so instead
// we derive taste from the user's own library and rank catalogue candidates we can actually
// fetch (artist detail, album detail, collected playlists). All functions here are pure so
// they can be unit-tested without Electron.
//
// The provider exposes no genre/tag field on a track (docs/API_CONTRACT.md §5 lists every
// field the normalizer sees), so "曲风" is approximated with the three signals that are really
// there: language/script of the title+artist, version markers in the title (live/remix/伴奏…),
// and the duration habits of the library. Every dimension is explainable and shown in the UI;
// nothing here pretends to be a server-side genre model.

function idOf(value) {
  return typeof value === 'string' && value.length ? value : '';
}

/** Dimension weights; they sum to 1 so a candidate's score is directly comparable. */
export const DIMENSION_WEIGHTS = Object.freeze({
  artist: 0.34,
  album: 0.14,
  playlist: 0.2,
  language: 0.16,
  duration: 0.1,
  version: 0.06,
});

export const DIMENSION_LABELS = Object.freeze({
  artist: '歌手',
  album: '专辑',
  playlist: '收藏歌单共现',
  language: '语种',
  duration: '时长习惯',
  version: '版本类型',
});

export const LANGUAGE_LABELS = Object.freeze({
  zh: '华语', ja: '日语', ko: '韩语', en: '英语', unknown: '其他',
});

export const VERSION_LABELS = Object.freeze({
  live: '现场', remix: '混音', acoustic: '不插电', instrumental: '纯音乐/伴奏', cover: '翻唱', demo: '小样',
});

const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]{2}/;

const VERSION_PATTERNS = [
  ['live', /live|演唱会|现场/i],
  ['remix', /remix|re-mix|\bdj\b|混音/i],
  ['acoustic', /acoustic|unplugged|不插电/i],
  ['instrumental', /instrumental|伴奏|纯音乐|piano|钢琴|guitar|吉他/i],
  ['cover', /cover|翻唱/i],
  ['demo', /\bdemo\b|小样/i],
];

function seedOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.track && typeof entry.track === 'object') {
    const weight = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
    return { track: entry.track, weight };
  }
  return { track: entry, weight: 1 };
}

/**
 * Coarse language/script of a track, from its title and artist names. Deliberately simple:
 * kana → 日语, hangul → 韩语, Han without kana → 华语, Latin → 英语. Cantonese and Mandarin
 * cannot be told apart from text, so both stay 华语.
 */
export function detectLanguage(track) {
  const text = [track?.title, ...(Array.isArray(track?.artists) ? track.artists.map(artist => artist?.name) : [])]
    .filter(value => typeof value === 'string' && value)
    .join(' ');
  if (!text) return 'unknown';
  if (KANA.test(text)) return 'ja';
  if (HANGUL.test(text)) return 'ko';
  if (CJK.test(text)) return 'zh';
  if (LATIN.test(text)) return 'en';
  return 'unknown';
}

/** Version/style markers carried by the title itself (live, remix, 伴奏, 翻唱…). */
export function versionTagsOf(title) {
  const text = typeof title === 'string' ? title : '';
  const tags = [];
  for (const [tag, pattern] of VERSION_PATTERNS) {
    if (pattern.test(text)) tags.push(tag);
  }
  return tags;
}

/**
 * Taste profile over every dimension we can compute. Seeds may be plain tracks or
 * `{ track, weight }` entries so favourites can outweigh playlist/history samples.
 * Ordering is count desc, key asc — stable across runs.
 */
export function buildTasteProfile(seeds) {
  const artists = new Map();
  const albums = new Map();
  const languages = new Map();
  const versions = new Map();
  let weightTotal = 0;
  let durationWeight = 0;
  let durationSum = 0;
  let durationSumSquares = 0;
  let durationMin = Infinity;
  let durationMax = 0;

  for (const entry of Array.isArray(seeds) ? seeds : []) {
    const seed = seedOf(entry);
    if (!seed) continue;
    const { track, weight } = seed;
    weightTotal += weight;

    for (const artist of Array.isArray(track.artists) ? track.artists : []) {
      const id = idOf(artist?.id);
      if (!id) continue;
      const found = artists.get(id);
      const name = typeof artist.name === 'string' ? artist.name : '';
      if (found) { found.count += weight; if (!found.name && name) found.name = name; }
      else artists.set(id, { id, name, count: weight });
    }

    const albumId = idOf(track.album?.id);
    if (albumId) {
      const title = typeof track.album.title === 'string' ? track.album.title : '';
      const found = albums.get(albumId);
      if (found) { found.count += weight; if (!found.title && title) found.title = title; }
      else albums.set(albumId, { id: albumId, title, count: weight });
    }

    const language = detectLanguage(track);
    const languageEntry = languages.get(language);
    if (languageEntry) languageEntry.count += weight;
    else languages.set(language, { key: language, count: weight });

    for (const tag of versionTagsOf(track.title)) {
      const versionEntry = versions.get(tag);
      if (versionEntry) versionEntry.count += weight;
      else versions.set(tag, { key: tag, count: weight });
    }

    const duration = Number(track.durationSeconds);
    if (Number.isFinite(duration) && duration > 0) {
      durationWeight += weight;
      durationSum += duration * weight;
      durationSumSquares += duration * duration * weight;
      durationMin = Math.min(durationMin, duration);
      durationMax = Math.max(durationMax, duration);
    }
  }

  const byFrequency = (left, right) => right.count - left.count || left.id.localeCompare(right.id);
  const byFrequencyKeyed = (left, right) => right.count - left.count || left.key.localeCompare(right.key);
  const withShare = entry => ({ ...entry, share: weightTotal > 0 ? entry.count / weightTotal : 0 });

  let duration = null;
  if (durationWeight > 0) {
    const mean = durationSum / durationWeight;
    const variance = Math.max(0, durationSumSquares / durationWeight - mean * mean);
    duration = {
      count: durationWeight,
      mean,
      min: Number.isFinite(durationMin) ? durationMin : 0,
      max: durationMax,
      // Standard deviation, floored so a library of identical lengths still discriminates a bit.
      spread: Math.max(Math.sqrt(variance), 30),
    };
  }

  return {
    artists: [...artists.values()].sort(byFrequency),
    albums: [...albums.values()].sort(byFrequency),
    languages: [...languages.values()].map(withShare).sort(byFrequencyKeyed),
    versions: [...versions.values()].map(withShare).sort(byFrequencyKeyed),
    duration,
    total: weightTotal,
  };
}

const clamp01 = value => (value < 0 ? 0 : value > 1 ? 1 : value);

function normalizer(map) {
  let max = 0;
  for (const value of map.values()) if (value > max) max = value;
  return id => (max > 0 ? clamp01((map.get(id) ?? 0) / max) : 0);
}

/**
 * Turns a profile plus playlist co-occurrence counts into the scorer used by
 * `rankCandidates`. Exported separately so tests can score one track at a time.
 */
export function buildRecommendationModel(profile, options = {}) {
  const artistWeights = new Map();
  for (const artist of profile?.artists ?? []) {
    if (!idOf(artist?.id)) continue;
    artistWeights.set(artist.id, Number(artist.count) || 0);
  }
  const albumWeights = new Map();
  for (const album of profile?.albums ?? []) {
    if (!idOf(album?.id)) continue;
    albumWeights.set(album.id, Number(album.count) || 0);
  }

  const rawHits = options.playlistHits;
  const playlistHits = rawHits instanceof Map ? rawHits : new Map(
    rawHits && typeof rawHits === 'object'
      ? Object.entries(rawHits).filter(([, count]) => Number.isFinite(Number(count)))
      : [],
  );
  let maxHits = 0;
  for (const value of playlistHits.values()) maxHits = Math.max(maxHits, Number(value) || 0);

  const languageShares = new Map();
  for (const entry of profile?.languages ?? []) {
    if (typeof entry?.key === 'string') languageShares.set(entry.key, Number(entry.share) || 0);
  }
  const knownVersions = new Set((profile?.versions ?? []).map(entry => entry?.key).filter(Boolean));

  const artistAffinity = normalizer(artistWeights);
  const albumAffinity = normalizer(albumWeights);

  return {
    artists: profile?.artists ?? [],
    albums: profile?.albums ?? [],
    languages: profile?.languages ?? [],
    duration: profile?.duration ?? null,
    total: profile?.total ?? 0,
    artistAffinity,
    albumAffinity,
    playlistHits: id => (maxHits > 0 ? clamp01((playlistHits.get(id) ?? 0) / maxHits) : 0),
    playlistHitCount: id => Number(playlistHits.get(id) ?? 0),
    languageShare: key => (key === 'unknown' ? 0 : Number(languageShares.get(key) ?? 0)),
    versionFit: tags => {
      if (!tags.length) return 1;
      if (!knownVersions.size) return 0.6;
      return tags.every(tag => knownVersions.has(tag)) ? 1 : 0.25;
    },
  };
}

function durationFit(durationSeconds, stats) {
  const duration = Number(durationSeconds);
  if (!stats || !Number.isFinite(duration) || duration <= 0) return 0.5;
  const distance = Math.abs(duration - stats.mean);
  return clamp01(1 - distance / (2 * (stats.spread || 60)));
}

/**
 * Score one candidate against the model. Returns the weighted score plus the human-readable
 * reasons the UI shows under the row, so a recommendation is never a black box.
 */
export function scoreCandidate(track, model) {
  const reasons = [];
  if (!track || typeof track !== 'object' || !model) return { score: 0, reasons };

  // 1) 歌手亲和度 — best matching artist among the candidate's credits.
  let artistValue = 0;
  let artistName = '';
  for (const artist of Array.isArray(track.artists) ? track.artists : []) {
    const value = model.artistAffinity(idOf(artist?.id));
    if (value > artistValue) { artistValue = value; artistName = typeof artist.name === 'string' ? artist.name : ''; }
  }
  if (artistValue > 0) {
    reasons.push(artistName ? `常听歌手 ${artistName}` : '常听歌手');
  }

  // 2) 专辑亲和度
  const albumId = idOf(track.album?.id);
  const albumValue = albumId ? model.albumAffinity(albumId) : 0;
  if (albumValue >= 0.5 && track.album?.title) reasons.push(`同专辑《${track.album.title}》`);

  // 3) 收藏歌单共现 — the same song appearing in several collected playlists is a strong signal.
  const hits = model.playlistHitCount(track.id);
  if (hits > 0) reasons.push(`收藏歌单共现 ×${hits}`);

  // 4) 语种画像
  const language = detectLanguage(track);
  const languageValue = language === 'unknown' ? 0.35 : model.languageShare(language);
  if (language !== 'unknown' && languageValue >= 0.4) reasons.push(`语种 ${LANGUAGE_LABELS[language]}`);

  // 5) 时长习惯
  const durationValue = durationFit(track.durationSeconds, model.duration);

  // 6) 版本类型 — a live/remix/伴奏 title the library never contains is a mild penalty.
  const tags = versionTagsOf(track.title);
  const versionValue = model.versionFit(tags);

  const score =
    DIMENSION_WEIGHTS.artist * artistValue +
    DIMENSION_WEIGHTS.album * albumValue +
    DIMENSION_WEIGHTS.playlist * model.playlistHits(track.id) +
    DIMENSION_WEIGHTS.language * languageValue +
    DIMENSION_WEIGHTS.duration * durationValue +
    DIMENSION_WEIGHTS.version * versionValue;

  return { score, reasons };
}

function artistKeysOf(track) {
  const keys = [];
  for (const artist of Array.isArray(track?.artists) ? track.artists : []) {
    const key = idOf(artist?.id) || (typeof artist?.name === 'string' ? artist.name : '');
    if (key) keys.push(key);
  }
  return keys;
}

/**
 * Rank candidates by the multi-dimension score, then apply a progressive per-artist cap so
 * the first page does not turn into one artist's discography. Passes run with caps 2 → 3 → 5
 * → unlimited; a smaller cap always wins, so the top of the list stays diverse.
 */
export function rankCandidates(candidates, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 120;
  const model = options.model ?? null;
  const excluded = new Set((Array.isArray(options.excludeIds) ? options.excludeIds : []).filter(idOf));
  const seen = new Set(excluded);
  const scored = [];

  for (const track of Array.isArray(candidates) ? candidates : []) {
    if (!track || typeof track !== 'object') continue;
    const id = idOf(track.id);
    if (!id || seen.has(id) || track.available === false) continue;
    seen.add(id);
    const { score, reasons } = model ? scoreCandidate(track, model) : { score: 0, reasons: [] };
    scored.push({ track, score, reasons, taken: false });
  }

  scored.sort((left, right) => right.score - left.score || left.track.id.localeCompare(right.track.id));

  const picked = [];
  const perArtist = new Map();
  for (const cap of [2, 3, 5, Number.POSITIVE_INFINITY]) {
    for (const item of scored) {
      if (picked.length >= limit) break;
      if (item.taken) continue;
      const keys = artistKeysOf(item.track);
      if (keys.length && keys.some(key => (perArtist.get(key) ?? 0) >= cap)) continue;
      item.taken = true;
      picked.push({ track: item.track, score: item.score, reasons: item.reasons });
      for (const key of keys) perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
    }
    if (picked.length >= limit) break;
  }
  return picked.map(item => ({ track: item.track, score: item.score, reasons: item.reasons }));
}

/**
 * Interleave candidate groups one track at a time (round-robin) so one dominant artist
 * cannot fill the whole list. Groups are visited in descending preference order.
 * Tracks already in the library (seed ids) and unavailable tracks are dropped, as are
 * duplicates across groups.
 *
 * When `options.model` is supplied the flat candidate list is scored and diversified instead
 * (see `rankCandidates`); the legacy round-robin stays for the un-scored path.
 */
export function buildRecommendationPool(groups, knownIds, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 120;
  const known = new Set((Array.isArray(knownIds) ? knownIds : []).filter(idOf));

  if (options.model) {
    const flat = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const track of Array.isArray(group?.tracks) ? group.tracks : []) flat.push(track);
    }
    return rankCandidates(flat, { limit, model: options.model, excludeIds: [...known] })
      .map(item => item.track);
  }

  const seen = new Set(known);
  const ordered = (Array.isArray(groups) ? groups : [])
    .map(group => ({
      key: idOf(group?.key),
      weight: Number.isFinite(group?.weight) ? group.weight : 0,
      tracks: (Array.isArray(group?.tracks) ? group.tracks : []).filter(track =>
        track && typeof track === 'object' && idOf(track.id) && track.available !== false),
    }))
    .filter(group => group.tracks.length)
    .sort((left, right) => right.weight - left.weight || left.key.localeCompare(right.key));
  const cursors = ordered.map(() => 0);
  const pool = [];
  while (pool.length < limit) {
    let progressed = false;
    for (let index = 0; index < ordered.length && pool.length < limit; index++) {
      const group = ordered[index];
      while (cursors[index] < group.tracks.length && pool.length < limit) {
        const track = group.tracks[cursors[index]++];
        progressed = true; // The cursor moved even when this track is skipped.
        if (seen.has(track.id)) continue;
        seen.add(track.id);
        pool.push(track);
        break;
      }
    }
    if (!progressed) break;
  }
  return pool;
}

/** A stable window into the pool; the index wraps around for the "换一批" button. */
export function batchOf(pool, size = 20, index = 0) {
  const list = Array.isArray(pool) ? pool : [];
  const pageSize = Number.isFinite(size) && size > 0 ? Math.floor(size) : 20;
  if (!list.length || !pageSize) return [];
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const normalized = ((Math.floor(index) % pages) + pages) % pages;
  return list.slice(normalized * pageSize, normalized * pageSize + pageSize);
}

/** m:ss for the dimension summary; separate from the table formatter to keep this module pure. */
export function formatClock(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
