// Local, offline recommender. The provider's documented "daily recommendation" endpoint
// rejects every known request shape (HTTP 400, see docs/feature-validation.md), so instead
// we derive taste from the user's own library and rank catalogue candidates we can actually
// fetch. All functions here are pure so they can be unit-tested without Electron.
//
// RECOMMENDATION MODEL (v3)
// 1. Every track gets an explainable 0-100 "song score" from content signals that really
//    exist in the data: language, version markers, duration habit, title theme words and
//    playlist co-occurrence. Artist/album identity is deliberately NOT part of that score.
// 2. The user's saved songs give a target score plus a tolerance band. Candidates are ranked
//    by how close their score is to that band ("推荐评分相近的歌"), not by artist identity.
// 3. Same artist/album as a saved song gets an explicit penalty, and a progressive per-artist
//    / per-album cap starts at 1. Together with the expanded candidate sources this breaks
//    the "same artist, same album" loop the previous two versions got stuck in.
//
// The provider exposes no genre/tag field on a track (docs/API_CONTRACT.md §5 lists every
// field the normalizer sees), so "曲风" is approximated with the signals above. Nothing here
// pretends to be a server-side genre model.

function idOf(value) {
  return typeof value === 'string' && value.length ? value : '';
}

/** Weights of the 0-100 song score. Sum = 1. Artist and album are intentionally absent. */
export const SCORE_WEIGHTS = Object.freeze({
  language: 0.32,
  version: 0.18,
  duration: 0.2,
  theme: 0.2,
  buzz: 0.1,
});

export const SCORE_LABELS = Object.freeze({
  language: '语种',
  version: '版本类型',
  duration: '时长习惯',
  theme: '主题用词',
  buzz: '歌单共现',
});

/** Kept as an alias so older callers/tests keep working. */
export const DIMENSION_LABELS = SCORE_LABELS;

/** How close a candidate's score must be to the user's target score. */
export const SIMILARITY = Object.freeze({
  minTolerance: 20,
  spreadFactor: 1.5,
});

/** Same-artist / same-album as a saved song is a demerit, not a merit. */
export const OVERLAP_PENALTY = Object.freeze({ artist: 0.1, album: 0.06 });

/** Progressive diversity caps: one per artist/album first, then relax only if needed. */
export const DIVERSITY_CAPS = Object.freeze([1, 2, 3, Number.POSITIVE_INFINITY]);

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
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g;
const LATIN_WORD = /[a-z]{3,}/g;

const VERSION_PATTERNS = [
  ['live', /live|演唱会|现场/i],
  ['remix', /remix|re-mix|\bdj\b|混音/i],
  ['acoustic', /acoustic|unplugged|不插电/i],
  ['instrumental', /instrumental|伴奏|纯音乐|piano|钢琴|guitar|吉他/i],
  ['cover', /cover|翻唱/i],
  ['demo', /\bdemo\b|小样/i],
];

// Generic bigrams tell us nothing about taste; drop them before building theme tokens.
const THEME_STOPWORDS = new Set([
  '我们', '你们', '他们', '一个', '一种', '没有', '什么', '怎么', '这样', '那样', '因为', '所以',
  '但是', '还是', '就是', '不是', '不要', '一直', '知道', '觉得', '时候', '现在', '只能', '真的',
  '那些', '这些', '这里', '那里', '为何', '可以', '自己', '让爱', '我和', '与你', '之间', '一次',
]);

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

/** Short content words from a title: CJK bigrams plus Latin words of 3+ letters. */
export function titleTokens(title) {
  const text = typeof title === 'string' ? title : '';
  const tokens = [];
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let index = 0; index + 2 <= run.length; index++) {
      const token = run.slice(index, index + 2);
      if (!THEME_STOPWORDS.has(token)) tokens.push(token);
    }
  }
  for (const word of text.toLowerCase().match(LATIN_WORD) ?? []) tokens.push(word);
  return tokens;
}

/**
 * Recurring title words across the taste seeds. This is the closest we can get to a "type"
 * of song without a genre field: if the library keeps saving songs with 「雨」/「爱」/「Live」,
 * other songs using the same words are likely to fit the same mood.
 */
export function buildThemeTokens(seeds, options = {}) {
  const counts = new Map();
  for (const entry of Array.isArray(seeds) ? seeds : []) {
    const seed = seedOf(entry);
    if (!seed) continue;
    for (const token of titleTokens(seed.track.title)) {
      counts.set(token, (counts.get(token) ?? 0) + seed.weight);
    }
  }
  const minimum = Number.isFinite(options.minCount) ? options.minCount : 2;
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 12;
  return [...counts.entries()]
    .filter(([, count]) => count >= minimum)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
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

/**
 * Model used by `scoreSong`. Besides the profile it carries playlist co-occurrence,
 * theme tokens and the sets of saved artists/albums needed for the overlap penalty.
 */
export function buildRecommendationModel(profile, options = {}) {
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
  const knownVersions = new Map();
  for (const entry of profile?.versions ?? []) {
    if (typeof entry?.key === 'string') knownVersions.set(entry.key, Number(entry.count) || 0);
  }
  const themeTokens = Array.isArray(options.themeTokens) ? options.themeTokens : [];
  const themeCounts = new Map(themeTokens.map(entry => [entry.key, Number(entry.count) || 0]));
  const seedArtists = new Set(
    (Array.isArray(options.seedArtists) ? options.seedArtists : (profile?.artists ?? []).map(entry => entry?.id))
      .filter(idOf),
  );
  const seedAlbums = new Set(
    (Array.isArray(options.seedAlbums) ? options.seedAlbums : (profile?.albums ?? []).map(entry => entry?.id))
      .filter(idOf),
  );

  return {
    artists: profile?.artists ?? [],
    albums: profile?.albums ?? [],
    languages: profile?.languages ?? [],
    versions: profile?.versions ?? [],
    duration: profile?.duration ?? null,
    total: profile?.total ?? 0,
    themeTokens,
    seedArtists,
    seedAlbums,
    playlistHitCount: id => Number(playlistHits.get(id) ?? 0),
    languageShare: key => (key === 'unknown' ? 0.25 : Number(languageShares.get(key) ?? 0)),
    versionFit: tags => {
      if (!tags.length) return knownVersions.size ? 0.8 : 1;
      if (!knownVersions.size) return 0.3;
      const good = tags.filter(tag => knownVersions.has(tag)).length;
      return clamp01(good / tags.length);
    },
    themeFit: title => {
      if (!themeCounts.size) return { value: 0.5, top: '' };
      const tokens = titleTokens(title);
      if (!tokens.length) return { value: 0.25, top: '' };
      let hits = 0;
      let top = '';
      for (const token of new Set(tokens)) {
        if (themeCounts.has(token)) {
          hits++;
          if (!top || themeCounts.get(token) > themeCounts.get(top)) top = token;
        }
      }
      return { value: clamp01(0.2 + 0.8 * hits / Math.min(3, tokens.length)), top };
    },
    buzz: id => (maxHits > 0 ? clamp01((playlistHits.get(id) ?? 0) / maxHits) : 0),
  };
}

function durationFit(durationSeconds, stats) {
  const duration = Number(durationSeconds);
  if (!stats || !Number.isFinite(duration) || duration <= 0) return 0.45;
  const distance = Math.abs(duration - stats.mean);
  return clamp01(1 - distance / (2 * (stats.spread || 60)));
}

/**
 * The 0-100 song score. No artist/album identity is consulted: a song by an unfamiliar
 * artist can score 90, and a song by a saved artist can score 40. This is what makes
 * "recommend songs with a similar score" possible instead of "more of the same singer".
 */
export function scoreSong(track, model) {
  const parts = { language: 0, version: 0, duration: 0, theme: 0, buzz: 0 };
  const reasons = [];
  if (!track || typeof track !== 'object' || !model) return { score: 0, parts, reasons };

  const language = detectLanguage(track);
  parts.language = model.languageShare(language);
  if (language !== 'unknown' && parts.language >= 0.3) reasons.push(`语种 ${LANGUAGE_LABELS[language]}`);

  const tags = versionTagsOf(track.title);
  parts.version = model.versionFit(tags);
  if (tags.length && parts.version >= 0.9) {
    reasons.push(`版本 ${VERSION_LABELS[tags[0]] ?? tags[0]}`);
  }

  parts.duration = durationFit(track.durationSeconds, model.duration);
  if (parts.duration >= 0.8) reasons.push('时长接近你的习惯');

  const theme = model.themeFit(track.title);
  parts.theme = theme.value;
  if (theme.top && parts.theme >= 0.45) reasons.push(`主题「${theme.top}」`);

  const hits = model.playlistHitCount(track.id);
  parts.buzz = model.buzz(track.id);
  if (hits > 0) reasons.push(`歌单共现 ×${hits}`);

  const raw = Object.entries(SCORE_WEIGHTS).reduce((sum, [key, weight]) => sum + weight * parts[key], 0);
  return { score: Math.round(raw * 1000) / 10, parts, reasons };
}

/** Backwards-compatible alias used by the previous scorer's callers. */
export function scoreCandidate(track, model) {
  const { score, reasons } = scoreSong(track, model);
  return { score: score / 100, reasons };
}

/**
 * Target score and tolerance learned from the user's saved songs. The tolerance is wide
 * enough for a small library but tightens as the library grows, so recommendations stay
 * near the score range the user actually keeps.
 */
export function buildScoreProfile(seeds, model) {
  const list = (Array.isArray(seeds) ? seeds : []).map(seedOf).filter(Boolean);
  let weightTotal = 0;
  let sum = 0;
  let sumSquares = 0;
  let min = Infinity;
  let max = 0;
  for (const { track, weight } of list) {
    const { score } = scoreSong(track, model);
    weightTotal += weight;
    sum += score * weight;
    sumSquares += score * score * weight;
    min = Math.min(min, score);
    max = Math.max(max, score);
  }
  if (!weightTotal) return { target: 60, tolerance: SIMILARITY.minTolerance, min: 0, max: 0, count: 0 };
  const target = sum / weightTotal;
  const variance = Math.max(0, sumSquares / weightTotal - target * target);
  return {
    target,
    tolerance: Math.max(SIMILARITY.minTolerance, Math.sqrt(variance) * SIMILARITY.spreadFactor),
    min: Number.isFinite(min) ? min : 0,
    max,
    count: weightTotal,
  };
}

/** 1 when a candidate's score sits exactly on the target, 0 at the edge of the band. */
export function scoreSimilarity(score, profile) {
  if (!profile || !profile.count) return 0;
  const value = Number(score);
  if (!Number.isFinite(value)) return 0;
  return clamp01(1 - Math.abs(value - profile.target) / profile.tolerance);
}

function artistKeysOf(track) {
  const keys = [];
  for (const artist of Array.isArray(track?.artists) ? track.artists : []) {
    const key = idOf(artist?.id) || (typeof artist?.name === 'string' ? artist.name : '');
    if (key) keys.push(key);
  }
  return keys;
}

function albumKeyOf(track) {
  return idOf(track?.album?.id) || (typeof track?.album?.title === 'string' ? track.album.title : '');
}

/**
 * Rank by closeness to the user's score band, with same-artist / same-album demerits and
 * progressive diversity caps. Without `scoreProfile` it falls back to plain score order,
 * which keeps the legacy unscored call path working.
 */
export function rankCandidates(candidates, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 120;
  const model = options.model ?? null;
  const profile = options.scoreProfile ?? null;
  const excluded = new Set((Array.isArray(options.excludeIds) ? options.excludeIds : []).filter(idOf));
  const seen = new Set(excluded);
  const scored = [];

  for (const track of Array.isArray(candidates) ? candidates : []) {
    if (!track || typeof track !== 'object') continue;
    const id = idOf(track.id);
    if (!id || seen.has(id) || track.available === false) continue;
    seen.add(id);
    const { score, parts, reasons } = model ? scoreSong(track, model) : { score: 0, parts: {}, reasons: [] };
    let match = profile ? scoreSimilarity(score, profile) : score / 100;
    if (profile && model) {
      if (artistKeysOf(track).some(key => model.seedArtists.has(key))) match -= OVERLAP_PENALTY.artist;
      const album = albumKeyOf(track);
      if (album && model.seedAlbums.has(album)) match -= OVERLAP_PENALTY.album;
    }
    scored.push({ track, score, parts, reasons, match, taken: false });
  }

  scored.sort((left, right) => right.match - left.match || right.score - left.score
    || left.track.id.localeCompare(right.track.id));

  const picked = [];
  const perArtist = new Map();
  const perAlbum = new Map();
  for (const cap of DIVERSITY_CAPS) {
    for (const item of scored) {
      if (picked.length >= limit) break;
      if (item.taken) continue;
      const artists = artistKeysOf(item.track);
      if (artists.length && artists.some(key => (perArtist.get(key) ?? 0) >= cap)) continue;
      const album = albumKeyOf(item.track);
      if (album && (perAlbum.get(album) ?? 0) >= cap) continue;
      item.taken = true;
      picked.push({ track: item.track, score: item.score, parts: item.parts, reasons: item.reasons });
      for (const key of artists) perArtist.set(key, (perArtist.get(key) ?? 0) + 1);
      if (album) perAlbum.set(album, (perAlbum.get(album) ?? 0) + 1);
    }
    if (picked.length >= limit) break;
  }
  return picked;
}

/**
 * Interleave candidate groups one track at a time (round-robin) so one dominant artist
 * cannot fill the whole list. Groups are visited in descending preference order.
 * When `options.model` is supplied the flat list is scored by the new model instead.
 */
export function buildRecommendationPool(groups, knownIds, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 120;
  const known = new Set((Array.isArray(knownIds) ? knownIds : []).filter(idOf));

  if (options.model) {
    const flat = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const track of Array.isArray(group?.tracks) ? group.tracks : []) flat.push(track);
    }
    return rankCandidates(flat, {
      limit, model: options.model, scoreProfile: options.scoreProfile, excludeIds: [...known],
    }).map(item => item.track);
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

/**
 * Second-hop sources: artists/albums that show up in collected playlists or play history
 * but not in the direct saves. Fetching these widens the pool beyond the saved artists —
 * without this, no scoring tweak can escape the same-artist loop.
 */
export function secondHopSeeds(tracks, exclude = {}) {
  const excludedArtists = new Set((exclude.artistIds ?? []).filter(idOf));
  const excludedAlbums = new Set((exclude.albumIds ?? []).filter(idOf));
  const artists = new Map();
  const albums = new Map();
  for (const entry of Array.isArray(tracks) ? tracks : []) {
    const track = seedOf(entry)?.track;
    if (!track) continue;
    for (const artist of Array.isArray(track.artists) ? track.artists : []) {
      const id = idOf(artist?.id);
      if (!id || excludedArtists.has(id)) continue;
      const found = artists.get(id);
      const name = typeof artist.name === 'string' ? artist.name : '';
      if (found) found.count += 1;
      else artists.set(id, { id, name, count: 1 });
    }
    const albumId = idOf(track.album?.id);
    if (albumId && !excludedAlbums.has(albumId)) {
      const found = albums.get(albumId);
      const title = typeof track.album.title === 'string' ? track.album.title : '';
      if (found) found.count += 1;
      else albums.set(albumId, { id: albumId, title, count: 1 });
    }
  }
  const ordered = (left, right) => right.count - left.count || left.id.localeCompare(right.id);
  return { artists: [...artists.values()].sort(ordered), albums: [...albums.values()].sort(ordered) };
}

const VERSION_QUERY = Object.freeze({
  live: 'Live', remix: 'Remix', acoustic: '不插电', instrumental: '伴奏', cover: '翻唱', demo: 'Demo',
});

/**
 * Search terms derived from the profile: version markers the library actually keeps plus
 * the strongest recurring title words. Search results are open-catalogue songs from many
 * different artists, which is exactly the diversity the artist/album endpoints lack.
 */
export function buildSearchKeywords(profile, themeTokens = [], options = {}) {
  const keywords = [];
  for (const entry of profile?.versions ?? []) {
    const query = VERSION_QUERY[entry?.key];
    if (query && entry.count >= (options.minVersionCount ?? 1)) keywords.push(query);
  }
  for (const entry of themeTokens.slice(0, options.themeLimit ?? 3)) {
    if (typeof entry?.key === 'string' && entry.key.length >= 2) keywords.push(entry.key);
  }
  return [...new Set(keywords)].slice(0, options.limit ?? 5);
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
