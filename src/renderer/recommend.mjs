// Local, offline recommender. The provider's documented "daily recommendation" endpoint
// rejects every known request shape (HTTP 400, see docs/feature-validation.md), so instead
// we derive taste from the user's own library and rank catalogue candidates we can actually
// fetch. All functions here are pure so they can be unit-tested without Electron.
//
// RECOMMENDATION MODEL (v5, precision-oriented)
// 1. Every track gets an explainable 0-100 "taste fit" score. The strongest signals are the
//    ones that actually define taste: the artist and album a user keeps, then language, recurring
//    title words, playlist co-occurrence, duration habit and version markers. Artist/album are
//    back in the score — dropping them in v3 made high scores possible for songs the user simply
//    does not listen to, which read as "scores don't match my taste".
// 2. Ranking is plain score-descending (highest fit first) and LOW-fit songs below a learned
//    floor are dropped. v3 ranked by |score - target|, which perversely buried a 99-fit song
//    under a 78-fit one just because the target was 85. Precision means "more fit wins".
// 3. Diversity is enforced by a progressive per-artist / per-album cap, NOT by penalising saved
//    artists/albums. So a favourite artist's genuinely fitting songs can still appear (one or two
//    per batch) without one discography taking over the list.
// 4. Accompaniment (伴奏 / 纯音乐 / karaoke / Instrumental) is NOT a song recommendation. v4 gave
//    it a positive version bonus: as soon as one 伴奏 sat in the library, every other 伴奏 scored
//    version = 1.0 while a studio original only got 0.8, so 伴奏 systematically outranked the real
//    track — and "伴奏" itself became a search keyword that pulled in a whole page of 伴奏. v5
//    drops accompaniment candidates outright, keeps them out of the theme/album profile, and never
//    searches for them. Only a library that is genuinely accompaniment-heavy keeps them.
//
// The provider exposes no genre/tag field on a track (docs/API_CONTRACT.md §5 lists every
// field the normalizer sees), so "曲风" is approximated with the signals above. Nothing here
// pretends to be a server-side genre model.

function idOf(value) {
  return typeof value === 'string' && value.length ? value : '';
}

/** Weights of the 0-100 taste-fit score. Sum = 1. Artist/album are the primary taste signals. */
export const SCORE_WEIGHTS = Object.freeze({
  artist: 0.34,
  album: 0.12,
  language: 0.16,
  theme: 0.14,
  buzz: 0.12,
  duration: 0.08,
  version: 0.04,
});

export const SCORE_LABELS = Object.freeze({
  artist: '歌手',
  album: '专辑',
  language: '语种',
  theme: '主题用词',
  buzz: '歌单共现',
  duration: '时长习惯',
  version: '版本类型',
});

/** Kept as an alias so older callers/tests keep working. */
export const DIMENSION_LABELS = SCORE_LABELS;

/** How the lower acceptance floor is derived from the saved-song score distribution. */
export const SIMILARITY = Object.freeze({
  minTolerance: 18,
  spreadFactor: 1.2,
});

/**
 * Minor same-artist/album demerit. Kept small and exported for callers that still reference it;
 * diversity is primarily enforced by DIVERSITY_CAPS, so a favourite artist's best songs survive.
 */
export const OVERLAP_PENALTY = Object.freeze({ artist: 0.02, album: 0.01 });

/** Progressive diversity caps: one per artist/album first, then relax only if needed. */
export const DIVERSITY_CAPS = Object.freeze([1, 2, 3, Number.POSITIVE_INFINITY]);

export const LANGUAGE_LABELS = Object.freeze({
  zh: '华语', ja: '日语', ko: '韩语', en: '英语', unknown: '其他',
});

export const VERSION_LABELS = Object.freeze({
  live: '现场', remix: '混音', acoustic: '不插电', instrumental: '伴奏/纯音乐', cover: '翻唱', demo: '小样',
});

/**
 * A version form only counts as a real habit when it makes up this much of the library.
 * Below it, a tagged candidate is clearly behind a plain studio original instead of ahead.
 */
export const VERSION_HABIT_SHARE = 0.25;

/**
 * Accompaniment is dropped unless the library itself is mostly accompaniment/instrumental.
 * The bar is high on purpose: a couple of stray 伴奏 must never steer the page, and a tiny
 * library (two songs, one of them 伴奏) must not look like an instrumental-only taste either.
 */
export const ACCOMPANIMENT_TOLERANCE_SHARE = 0.34;
export const ACCOMPANIMENT_MIN_COUNT = 3;

const KANA = /[\u3040-\u30ff\u31f0-\u31ff]/;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;
const LATIN = /[A-Za-z]{2}/;
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff]{2,}/g;
const LATIN_WORD = /[a-z]{3,}/g;

// localeCompare's order depends on the host ICU data: the same profile ranked `live` above
// `雨夜` on macOS but below it on Windows, silently changing search keywords and batches.
// Code-unit comparison is identical everywhere, which is what a pure function needs.
const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

const VERSION_PATTERNS = [
  ['live', /\blive\b|演唱会|现场/i],
  ['remix', /remix|re-mix|\bdj\b|混音/i],
  ['acoustic', /acoustic|unplugged|不插电/i],
  // Accompaniment markers only. Bare words like piano/guitar are NOT enough: "Piano Man" is a
  // real song, 「钢琴版」 is not. Latin markers work in both directions here.
  ['instrumental', /instrumental|\binst\b\.?|karaoke|off\s*vocal|backing\s*track|伴奏|纯音乐|纯伴奏|消音|无人声|无和声|(?:钢琴|吉他|小提琴|古筝|二胡|八音盒|音乐盒|口琴|手风琴|萨克斯)\s*(?:版|曲|演奏)|(?:piano|guitar|violin|music\s*box)\s*(?:version|ver\b|cover|instrumental)/i],
  ['cover', /cover|翻唱/i],
  ['demo', /\bdemo\b|小样/i],
];

// Generic bigrams tell us nothing about taste; drop them before building theme tokens.
const THEME_STOPWORDS = new Set([
  '我们', '你们', '他们', '一个', '一种', '没有', '什么', '怎么', '这样', '那样', '因为', '所以',
  '但是', '还是', '就是', '不是', '不要', '一直', '知道', '觉得', '时候', '现在', '只能', '真的',
  '那些', '这些', '这里', '那里', '为何', '可以', '自己', '让爱', '我和', '与你', '之间', '一次',
]);

// Version markers are a separate scoring/search dimension (VERSION_QUERY), so letting them
// also become theme words produces duplicate query terms like both "Live" and "live".
const THEME_VERSION_WORDS = new Set(['live', 'remix', 'acoustic', 'cover', 'demo', 'instrumental', 'karaoke']);

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
 * Is this an accompaniment / instrumental rendition rather than a song? The album title counts
 * too: platforms ship whole 「XX（伴奏）」 albums whose track titles look perfectly normal.
 */
export function isAccompaniment(track) {
  if (!track || typeof track !== 'object') return false;
  return versionTagsOf(track.title).includes('instrumental')
    || versionTagsOf(track.album?.title).includes('instrumental');
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
    // An accompaniment title would otherwise teach the profile 「伴奏」 as a theme word.
    if (isAccompaniment(seed.track)) continue;
    for (const token of titleTokens(seed.track.title)) {
      if (THEME_VERSION_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + seed.weight);
    }
  }
  const minimum = Number.isFinite(options.minCount) ? options.minCount : 2;
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : 12;
  return [...counts.entries()]
    .filter(([, count]) => count >= minimum)
    .sort((left, right) => right[1] - left[1] || byCodeUnit(left[0], right[0]))
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
    const accompaniment = isAccompaniment(track);

    for (const artist of Array.isArray(track.artists) ? track.artists : []) {
      const id = idOf(artist?.id);
      if (!id) continue;
      const found = artists.get(id);
      const name = typeof artist.name === 'string' ? artist.name : '';
      if (found) { found.count += weight; if (!found.name && name) found.name = name; }
      else artists.set(id, { id, name, count: weight });
    }

    // A 「XX（伴奏）」 album is a companion release, not an album the user actually chose.
    const albumId = idOf(track.album?.id);
    if (albumId && !accompaniment) {
      const title = typeof track.album.title === 'string' ? track.album.title : '';
      const found = albums.get(albumId);
      if (found) { found.count += weight; if (!found.title && title) found.title = title; }
      else albums.set(albumId, { id: albumId, title, count: weight });
    }

    const language = detectLanguage(track);
    const languageEntry = languages.get(language);
    if (languageEntry) languageEntry.count += weight;
    else languages.set(language, { key: language, count: weight });

    const versionTags = versionTagsOf(track.title);
    // The album title can be the only accompaniment marker, so fold it into the version share.
    if (accompaniment && !versionTags.includes('instrumental')) versionTags.push('instrumental');

    for (const tag of versionTags) {
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

  const byFrequency = (left, right) => right.count - left.count || byCodeUnit(left.id, right.id);
  const byFrequencyKeyed = (left, right) => right.count - left.count || byCodeUnit(left.key, right.key);
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
    if (typeof entry?.key !== 'string') continue;
    const share = Number.isFinite(entry.share)
      ? Number(entry.share)
      : (Number(entry.count) || 0) / Math.max(1, Number(profile?.total) || 0);
    knownVersions.set(entry.key, Math.max(0, share));
  }
  // Accompaniment only stays recommendable when the library itself is accompaniment-heavy.
  const instrumentalEntry = (profile?.versions ?? [])
    .find(entry => entry?.key === 'instrumental');
  const accompanimentShare = Number.isFinite(instrumentalEntry?.share)
    ? Number(instrumentalEntry.share)
    : 0;
  const accompanimentCount = Number(instrumentalEntry?.count) || 0;
  const accompanimentAllowed = accompanimentShare >= ACCOMPANIMENT_TOLERANCE_SHARE
    && accompanimentCount >= ACCOMPANIMENT_MIN_COUNT;
  // Artist/album affinity is the strongest taste signal. Normalise by the top entry so a
  // favourite artist scores 1 and a never-seen one scores 0; counts come straight from the
  // weighted profile (saved 1.0, playlist 0.7, history 0.5).
  const artistWeights = new Map();
  for (const artist of profile?.artists ?? []) {
    if (idOf(artist?.id)) artistWeights.set(artist.id, Number(artist.count) || 0);
  }
  const albumWeights = new Map();
  for (const album of profile?.albums ?? []) {
    if (idOf(album?.id)) albumWeights.set(album.id, Number(album.count) || 0);
  }
  const normalise = map => {
    let max = 0;
    for (const value of map.values()) if (value > max) max = value;
    return id => (max > 0 ? clamp01((map.get(id) ?? 0) / max) : 0);
  };
  const artistAffinity = normalise(artistWeights);
  const albumAffinity = normalise(albumWeights);
  const artistName = new Map(
    (profile?.artists ?? []).filter(entry => idOf(entry?.id)).map(entry => [entry.id, entry.name ?? '']),
  );

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
    accompanimentShare,
    accompanimentAllowed,
    artistAffinity,
    albumAffinity,
    artistName: id => artistName.get(id) ?? '',
    playlistHitCount: id => Number(playlistHits.get(id) ?? 0),
    languageShare: key => (key === 'unknown' ? 0.25 : Number(languageShares.get(key) ?? 0)),
    // A plain studio track is the neutral best (1). A tagged version only closes the gap when the
    // library genuinely keeps that form; otherwise it sits clearly below an original. Nothing a
    // tagged candidate can score beats an untagged one, which is what v4 got wrong. 伴奏 is scored
    // at the bottom regardless of the library, unless accompaniment is tolerated at all.
    versionFit: tags => {
      if (!tags.length) return 1;
      if (tags.includes('instrumental')) return accompanimentAllowed ? 0.9 : 0.1;
      let share = 0;
      for (const tag of tags) share = Math.max(share, knownVersions.get(tag) ?? 0);
      return share >= VERSION_HABIT_SHARE ? 0.9 : 0.25;
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
 * The 0-100 taste-fit score. Artist and album are the primary signals again: a song by a
 * frequently-saved artist scores high because that is the strongest evidence of taste. The
 * score is used for plain descending ranking, so a higher fit is always better — no "too close
 * to the target" paradox. Diversity comes from the per-artist cap, not from this score.
 */
export function scoreSong(track, model) {
  const parts = { artist: 0, album: 0, language: 0, version: 0, duration: 0, theme: 0, buzz: 0 };
  const reasons = [];
  if (!track || typeof track !== 'object' || !model) return { score: 0, parts, reasons };

  // 1) Artist affinity — best credit among the candidate's artists.
  let artistValue = 0;
  let artistName = '';
  for (const artist of Array.isArray(track.artists) ? track.artists : []) {
    const id = idOf(artist?.id);
    const value = id ? model.artistAffinity(id) : 0;
    if (value > artistValue) {
      artistValue = value;
      artistName = (typeof artist.name === 'string' && artist.name) || model.artistName(id);
    }
  }
  parts.artist = artistValue;
  if (artistValue >= 0.5 && artistName) reasons.push(`常听歌手 ${artistName}`);

  // 2) Album affinity.
  const albumId = idOf(track.album?.id);
  parts.album = albumId ? model.albumAffinity(albumId) : 0;
  if (parts.album >= 0.5 && track.album?.title) reasons.push(`同专辑《${track.album.title}》`);

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
 * Acceptance floor learned from the user's saved songs: candidates scoring below
 * `floor` are too far from the user's taste and are dropped. `target`/`tolerance` stay for the
 * UI readout, but ranking is plain score-descending (higher fit = better), never |score-target|.
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
  if (!weightTotal) return { target: 60, tolerance: SIMILARITY.minTolerance, floor: 0, min: 0, max: 0, count: 0 };
  const target = sum / weightTotal;
  const variance = Math.max(0, sumSquares / weightTotal - target * target);
  const tolerance = Math.max(SIMILARITY.minTolerance, Math.sqrt(variance) * SIMILARITY.spreadFactor);
  return {
    target,
    tolerance,
    // Drop songs that fit materially worse than the weakest saved song. Clamped into [0, 100]
    // and never above the target, so a tiny library still yields candidates.
    floor: clamp01((min - tolerance * 0.35) / 100) * 100,
    min: Number.isFinite(min) ? min : 0,
    max,
    count: weightTotal,
  };
}

/** 1 at/above the target fit, tapering to 0 at the acceptance floor (used for the UI meter). */
export function scoreSimilarity(score, profile) {
  if (!profile || !profile.count) return 0;
  const value = Number(score);
  if (!Number.isFinite(value)) return 0;
  if (value >= profile.target) return 1;
  const span = Math.max(1, profile.target - profile.floor);
  return clamp01(1 - (profile.target - value) / span);
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
 * Precision ranking: highest taste-fit first. Candidates scoring below the learned floor are
 * discarded (too far from the user's taste). A progressive per-artist / per-album cap supplies
 * diversity instead of penalising saved artists, so a favourite artist's best songs still appear
 * — just not ten in a row. Accompaniment renditions are removed here (before scoring) unless the
 * library itself is accompaniment-heavy. Without `model` the legacy unscored path is preserved.
 */
export function rankCandidates(candidates, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 120;
  const model = options.model ?? null;
  const profile = options.scoreProfile ?? null;
  const floor = profile && profile.count ? profile.floor : 0;
  const excluded = new Set((Array.isArray(options.excludeIds) ? options.excludeIds : []).filter(idOf));
  const seen = new Set(excluded);
  const allowAccompaniment = options.allowAccompaniment ?? model?.accompanimentAllowed ?? false;
  const scored = [];

  for (const track of Array.isArray(candidates) ? candidates : []) {
    if (!track || typeof track !== 'object') continue;
    const id = idOf(track.id);
    if (!id || seen.has(id) || track.available === false) continue;
    seen.add(id);
    // 伴奏/纯音乐 is not a song: drop it before scoring so it can never outrank the real track.
    if (!allowAccompaniment && isAccompaniment(track)) continue;
    const { score, parts, reasons } = model ? scoreSong(track, model) : { score: 0, parts: {}, reasons: [] };
    if (model && score < floor) continue; // precision: drop low-fit songs entirely
    scored.push({ track, score, parts, reasons, taken: false });
  }

  // Plain descending fit — a 99 never hides behind a 78. Tiny tie-break keeps output stable.
  scored.sort((left, right) => right.score - left.score || byCodeUnit(left.track.id, right.track.id));

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
      allowAccompaniment: options.allowAccompaniment,
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
    .sort((left, right) => right.weight - left.weight || byCodeUnit(left.key, right.key));
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
    if (albumId && !excludedAlbums.has(albumId) && !isAccompaniment(track)) {
      const found = albums.get(albumId);
      const title = typeof track.album.title === 'string' ? track.album.title : '';
      if (found) found.count += 1;
      else albums.set(albumId, { id: albumId, title, count: 1 });
    }
  }
  const ordered = (left, right) => right.count - left.count || byCodeUnit(left.id, right.id);
  return { artists: [...artists.values()].sort(ordered), albums: [...albums.values()].sort(ordered) };
}

const VERSION_QUERY = Object.freeze({
  live: 'Live', remix: 'Remix', acoustic: '不插电', cover: '翻唱', demo: 'Demo',
});

/**
 * Search terms derived from the profile: version markers the library actually keeps plus
 * the strongest recurring title words. Search results are open-catalogue songs from many
 * different artists, which is exactly the diversity the artist/album endpoints lack.
 *
 * 「伴奏」 is deliberately never a keyword — searching it returns a whole page of accompaniment
 * versions, which is the fastest way to fill the recommendation list with 伴奏. Other version
 * words only qualify as a real habit (they must occur more than once), so one stray Live track
 * cannot turn the whole batch into live recordings.
 */
export function buildSearchKeywords(profile, themeTokens = [], options = {}) {
  const minimum = Number.isFinite(options.minVersionCount) ? options.minVersionCount : 2;
  const keywords = [];
  for (const entry of profile?.versions ?? []) {
    if (entry?.key === 'instrumental') continue;
    const query = VERSION_QUERY[entry?.key];
    if (query && Number(entry.count) >= minimum) keywords.push(query);
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
