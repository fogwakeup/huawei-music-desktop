import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOMPANIMENT_TOLERANCE_SHARE, DIVERSITY_CAPS, SCORE_WEIGHTS, SIMILARITY, VERSION_HABIT_SHARE,
  batchOf, buildRecommendationModel, buildRecommendationPool, buildScoreProfile,
  buildSearchKeywords, buildTasteProfile, buildThemeTokens, detectLanguage, formatClock,
  isAccompaniment, rankCandidates, scoreCandidate, scoreSimilarity, scoreSong, secondHopSeeds,
  titleTokens, versionTagsOf,
} from '../src/renderer/recommend.mjs';

const track = (id, artists = [], album, available = true, extra = {}) => ({
  id, title: id, artists, album, available, ...extra,
});

const savedSeeds = () => [
  track('s1', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: '雨夜情歌', durationSeconds: 240 }),
  track('s2', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: '雨声情歌', durationSeconds: 250 }),
];

const modelFor = seeds => {
  const profile = buildTasteProfile(seeds);
  return buildRecommendationModel(profile, {
    themeTokens: buildThemeTokens(seeds),
    seedArtists: profile.artists.map(entry => entry.id),
    seedAlbums: profile.albums.map(entry => entry.id),
  });
};

test('taste profile counts artists and albums, ignoring missing ids', () => {
  const profile = buildTasteProfile([
    track('a', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }),
    track('b', [{ id: 'A1', name: '甲' }, { id: 'A2', name: '乙' }], { id: 'L1', title: '专辑一' }),
    track('c', [{ id: 'A2', name: '乙' }], { id: 'L2', title: '专辑二' }),
    track('d', [{ name: '没有 ID 的歌手' }], undefined),
    null,
  ]);
  assert.deepEqual(profile.artists, [
    { id: 'A1', name: '甲', count: 2 },
    { id: 'A2', name: '乙', count: 2 },
  ]);
  assert.deepEqual(profile.albums, [
    { id: 'L1', title: '专辑一', count: 2 },
    { id: 'L2', title: '专辑二', count: 1 },
  ]);
});

test('taste profile reports the empty shape for empty and malformed input', () => {
  const empty = { artists: [], albums: [], languages: [], versions: [], duration: null, total: 0 };
  assert.deepEqual(buildTasteProfile(null), empty);
  assert.deepEqual(buildTasteProfile([]), empty);
});

test('detectLanguage separates 华语 / 日语 / 韩语 / 英语 from the text itself', () => {
  assert.equal(detectLanguage({ title: '七里香', artists: [{ name: '周杰伦' }] }), 'zh');
  assert.equal(detectLanguage({ title: '夜に駆ける', artists: [{ name: 'YOASOBI' }] }), 'ja');
  assert.equal(detectLanguage({ title: 'Dynamite', artists: [{ name: '방탄소년단' }] }), 'ko');
  assert.equal(detectLanguage({ title: 'Bohemian Rhapsody', artists: [{ name: 'Queen' }] }), 'en');
  assert.equal(detectLanguage({ title: '1234', artists: [] }), 'unknown');
  assert.equal(detectLanguage(null), 'unknown');
});

test('versionTagsOf only reports markers that are really in the title', () => {
  assert.deepEqual(versionTagsOf('晴天 (Live)'), ['live']);
  assert.deepEqual(versionTagsOf('Lose Yourself (Remix)'), ['remix']);
  assert.deepEqual(versionTagsOf('后来 (伴奏)'), ['instrumental']);
  assert.deepEqual(versionTagsOf('夜曲'), []);
  assert.deepEqual(versionTagsOf(undefined), []);
  // Word boundaries: a real song must not be misread as a live version.
  assert.deepEqual(versionTagsOf('Alive'), []);
  assert.deepEqual(versionTagsOf('Deliver Me'), []);
  assert.deepEqual(versionTagsOf('Piano Man'), []);
  assert.deepEqual(versionTagsOf('英雄 钢琴版'), ['instrumental']);
});

test('isAccompaniment separates accompaniment renditions from real songs', () => {
  assert.equal(isAccompaniment({ title: '后来 (伴奏)' }), true);
  assert.equal(isAccompaniment({ title: '夜空中最亮的星 纯音乐' }), true);
  assert.equal(isAccompaniment({ title: 'Song (Instrumental)' }), true);
  assert.equal(isAccompaniment({ title: 'Song (Inst.)' }), true);
  assert.equal(isAccompaniment({ title: 'Song (Karaoke)' }), true);
  assert.equal(isAccompaniment({ title: '英雄 钢琴版' }), true);
  // The album title is often the only marker on karaoke releases.
  assert.equal(isAccompaniment({ title: '夜曲', album: { id: 'L', title: '十一月的萧邦（伴奏）' } }), true);
  assert.equal(isAccompaniment({ title: '夜曲', album: { id: 'L', title: '十一月的萧邦' } }), false);
  assert.equal(isAccompaniment({ title: 'Piano Man' }), false);
  assert.equal(isAccompaniment({ title: 'Alive' }), false);
  assert.equal(isAccompaniment(null), false);
  assert.equal(isAccompaniment('后来 (伴奏)'), false);
});

test('titleTokens and buildThemeTokens extract recurring topic words, not generic bigrams', () => {
  assert.deepEqual(titleTokens('雨夜的雨'), ['雨夜', '夜的', '的雨']);
  const tokens = buildThemeTokens([
    { track: track('a', [], undefined, true, { title: '雨夜情歌' }), weight: 2 },
    { track: track('b', [], undefined, true, { title: '雨声情歌' }), weight: 2 },
  ]);
  const keys = tokens.map(entry => entry.key);
  assert.ok(keys.includes('雨夜'), `missing 雨夜 in ${keys.join(',')}`);
  assert.ok(keys.includes('情歌'), `missing 情歌 in ${keys.join(',')}`);
  assert.equal(keys.includes('的雨'), false, 'generic bigrams must not become theme tokens');
});

test('taste profile aggregates language, version and duration dimensions', () => {
  const profile = buildTasteProfile([
    track('a', [{ id: 'A1', name: '甲' }], undefined, true, { title: '华语一', durationSeconds: 200 }),
    track('b', [{ id: 'A1', name: '甲' }], undefined, true, { title: '华语二 (Live)', durationSeconds: 400 }),
  ]);
  assert.deepEqual(profile.languages.map(entry => [entry.key, entry.share]), [['zh', 1]]);
  assert.deepEqual(profile.versions.map(entry => [entry.key, entry.count]), [['live', 1]]);
  assert.equal(Math.round(profile.duration.mean), 300);
  assert.equal(profile.duration.count, 2);
  assert.ok(profile.duration.spread > 0, 'spread must stay positive so identical libraries still discriminate');
  assert.equal(profile.total, 2);
});

test('weighted seeds count more than plain ones', () => {
  const profile = buildTasteProfile([
    { track: track('a', [{ id: 'A1', name: '甲' }]), weight: 3 },
    track('b', [{ id: 'A2', name: '乙' }]),
  ]);
  assert.deepEqual(profile.artists.map(artist => [artist.id, artist.count]), [['A1', 3], ['A2', 1]]);
  assert.equal(profile.total, 4);
});

test('song-score weights sum to one and make artist/album the primary signals', () => {
  const total = Object.values(SCORE_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(total * 1000) / 1000, 1);
  assert.ok(SCORE_WEIGHTS.artist > SCORE_WEIGHTS.language, 'artist must outweigh secondary signals');
  assert.ok(SCORE_WEIGHTS.artist + SCORE_WEIGHTS.album >= 0.4, 'artist+album must be a strong taste signal');
});

test('scoreSong rewards saved artist/album and penalises a mismatched stranger', () => {
  const seeds = savedSeeds();
  const model = modelFor(seeds);
  const familiar = scoreSong(track('old', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: '雨夜情歌三', durationSeconds: 245 }), model);
  const stranger = scoreSong(track('new', [{ id: 'A9', name: '陌生' }], { id: 'L9', title: '别的专辑' }, true,
    { title: 'Rainy Night Remix', durationSeconds: 720 }), model);
  assert.ok(familiar.score > stranger.score + 20,
    `saved artist ${familiar.score} should clearly beat stranger ${stranger.score}`);
  assert.ok(familiar.score >= 0 && familiar.score <= 100);
  assert.match(familiar.reasons.join(' / '), /常听歌手 甲/);
  assert.match(familiar.reasons.join(' / '), /同专辑《专辑一》/);
});

test('scoreSong returns explainable reason strings and a 0-100 score', () => {
  const seeds = savedSeeds();
  const model = buildRecommendationModel(buildTasteProfile(seeds), {
    themeTokens: buildThemeTokens(seeds),
    playlistHits: new Map([['hit', 2]]),
  });
  const result = scoreSong(track('hit', [{ id: 'A9', name: '陌生' }], undefined, true,
    { title: '雨夜情歌 (Live)', durationSeconds: 245 }), model);
  assert.ok(Number.isFinite(result.score));
  assert.match(result.reasons.join(' / '), /语种 华语/);
  assert.match(result.reasons.join(' / '), /主题「/);
  assert.match(result.reasons.join(' / '), /歌单共现 ×2/);
  assert.deepEqual(Object.keys(result.parts).sort(),
    ['album', 'artist', 'buzz', 'duration', 'language', 'theme', 'version']);
});

test('scoreCandidate keeps the legacy 0-1 scale for old callers', () => {
  const model = modelFor(savedSeeds());
  const song = scoreSong(track('x', [], undefined, true, { title: '雨夜情歌', durationSeconds: 240 }), model);
  const legacy = scoreCandidate(track('x', [], undefined, true, { title: '雨夜情歌', durationSeconds: 240 }), model);
  assert.equal(legacy.score, song.score / 100);
});

test('scoreSong penalises versions the library never keeps', () => {
  const profile = buildTasteProfile([
    track('s1', [{ id: 'A1', name: '甲' }], undefined, true, { title: '录音室版', durationSeconds: 200 }),
  ]);
  const model = buildRecommendationModel(profile);
  const studio = scoreSong(track('x', [{ id: 'A1', name: '甲' }], undefined, true, { title: '录音室版二' }), model);
  const live = scoreSong(track('y', [{ id: 'A1', name: '甲' }], undefined, true, { title: '录音室版 (Live)' }), model);
  assert.ok(studio.score > live.score, 'a live-only title should score below a plain one');
});

test('an original always outranks its 伴奏 twin, even when the library keeps one 伴奏', () => {
  // Regression for the v4 inversion: one saved 伴奏 gave every other 伴奏 version = 1.0 while a
  // studio original only got 0.8, so the accompaniment beat the real track (81 vs 80.2).
  assert.ok(VERSION_HABIT_SHARE > 0 && VERSION_HABIT_SHARE < 1);
  const seeds = [
    track('s1', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
      { title: '雨夜情歌', durationSeconds: 240 }),
    track('s2', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
      { title: '后来 (伴奏)', durationSeconds: 250 }),
  ];
  const model = modelFor(seeds);
  assert.equal(model.accompanimentAllowed, false, 'one 伴奏 in the library must not unlock 伴奏');
  const instrumental = scoreSong(track('c1', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: '晴天 (伴奏)', durationSeconds: 245 }), model);
  const original = scoreSong(track('c2', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: '晴天', durationSeconds: 245 }), model);
  assert.ok(original.score > instrumental.score,
    `original ${original.score} must beat 伴奏 ${instrumental.score}`);
  assert.equal(original.parts.version, 1);
  assert.ok(instrumental.parts.version <= 0.25);
});

test('rankCandidates drops accompaniment renditions by default', () => {
  const seeds = savedSeeds();
  const model = modelFor(seeds);
  const scoreProfile = buildScoreProfile(seeds, model);
  const candidates = [
    track('inst-1', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
      { title: '雨夜情歌 (伴奏)', durationSeconds: 240 }),
    track('inst-2', [{ id: 'A1', name: '甲' }], { id: 'L2', title: '专辑一（纯音乐）' }, true,
      { title: '雨声情歌 纯音乐', durationSeconds: 245 }),
    track('orig-1', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
      { title: '雨夜情歌三', durationSeconds: 242 }),
  ];
  const ranked = rankCandidates(candidates, { model, scoreProfile });
  assert.deepEqual(ranked.map(item => item.track.id), ['orig-1']);
});

test('a mostly-accompaniment library keeps its accompaniment recommendations', () => {
  assert.ok(ACCOMPANIMENT_TOLERANCE_SHARE > 0 && ACCOMPANIMENT_TOLERANCE_SHARE < 1);
  const seeds = Array.from({ length: 4 }, (_unused, index) => track(`inst-seed-${index}`,
    [{ id: 'A1', name: '甲' }], { id: 'L1', title: '伴奏专辑' }, true,
    { title: `伴奏曲${index} (伴奏)`, durationSeconds: 240 }));
  const model = modelFor(seeds);
  assert.equal(model.accompanimentAllowed, true);
  assert.ok(model.accompanimentShare >= ACCOMPANIMENT_TOLERANCE_SHARE);
  const ranked = rankCandidates([
    track('inst-c', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '伴奏专辑' }, true,
      { title: '新伴奏曲 (伴奏)', durationSeconds: 240 }),
  ], { model });
  assert.deepEqual(ranked.map(item => item.track.id), ['inst-c'],
    'an instrumental library must not be filtered down to nothing');
});

test('accompaniment stays out of the theme profile and the album affinity', () => {
  const seeds = [
    track('a', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
      { title: '雨夜情歌', durationSeconds: 240 }),
    track('b', [{ id: 'A1', name: '甲' }], { id: 'L2', title: '专辑一 (伴奏)' }, true,
      { title: '雨夜情歌 (伴奏)', durationSeconds: 240 }),
  ];
  const profile = buildTasteProfile(seeds);
  assert.deepEqual(profile.albums.map(entry => entry.id), ['L1'],
    'a 伴奏 companion album must not become an album affinity');
  assert.equal(buildThemeTokens(seeds).some(entry => entry.key === '伴奏'), false,
    '伴奏 must not be learned as a theme word');
  // The version share still records it, because that share decides whether 伴奏 is tolerated.
  assert.deepEqual(profile.versions.map(entry => [entry.key, entry.count]), [['instrumental', 1]]);
});

test('buildSearchKeywords never searches for 伴奏 and only honours habitual version words', () => {
  const seeds = [
    track('s1', [], undefined, true, { title: '雨夜情歌 (伴奏)' }),
    track('s2', [], undefined, true, { title: '雨夜情歌二 (伴奏)' }),
  ];
  const profile = buildTasteProfile(seeds);
  const keywords = buildSearchKeywords(profile, buildThemeTokens(seeds), { limit: 5 });
  assert.equal(keywords.includes('伴奏'), false, `伴奏 must never be a search keyword: ${keywords.join(',')}`);
  // A single stray version word is not a habit.
  const oneLive = buildTasteProfile([track('s3', [], undefined, true, { title: '晴天 (Live)' })]);
  assert.equal(buildSearchKeywords(oneLive, []).includes('Live'), false);
  const twoLive = buildTasteProfile([
    track('s4', [], undefined, true, { title: '晴天 (Live)' }),
    track('s5', [], undefined, true, { title: '夜曲 (Live)' }),
  ]);
  assert.equal(buildSearchKeywords(twoLive, []).includes('Live'), true);
});

test('buildScoreProfile derives an acceptance floor below the saved-song minimum', () => {
  const seeds = savedSeeds();
  const model = modelFor(seeds);
  const profile = buildScoreProfile(seeds, model);
  assert.equal(profile.count, 2);
  assert.ok(profile.target > 60 && profile.target <= 100, `target ${profile.target}`);
  assert.ok(profile.tolerance >= SIMILARITY.minTolerance);
  assert.ok(profile.floor >= 0 && profile.floor < profile.min, `floor ${profile.floor} must sit below min ${profile.min}`);
  assert.equal(scoreSimilarity(profile.target, profile), 1);
  assert.equal(scoreSimilarity(profile.floor, profile), 0);
  // Monotonic in fit: higher fit is never scored lower (the v3 |score-target| bug is gone).
  assert.ok(scoreSimilarity(profile.target + 5, profile) >= scoreSimilarity(profile.target - 5, profile));
});

test('buildScoreProfile stays safe on malformed and empty seeds', () => {
  const model = modelFor([]);
  const empty = buildScoreProfile(null, model);
  assert.equal(empty.count, 0);
  assert.equal(empty.target, 60);
  assert.equal(empty.floor, 0);
  assert.equal(scoreSimilarity(80, empty), 0);
});

test('rankCandidates puts the higher-fit song first (a 99 never hides behind a 78)', () => {
  const seeds = savedSeeds();
  const model = modelFor(seeds);
  const stranger = track('new', [{ id: 'A9', name: '陌生' }], { id: 'L9', title: '别的专辑' }, true,
    { title: '雨夜情歌二', durationSeconds: 245 });
  const familiar = track('old', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: 'Rainy Night Remix', durationSeconds: 720 });
  // No scoreProfile here: pure descending fit. Saved artist wins because it genuinely fits more.
  const ranked = rankCandidates([stranger, familiar], { model });
  assert.equal(ranked[0].track.id, 'old');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.match(ranked[0].reasons.join(' / '), /常听歌手|语种|主题|时长/);
});

test('rankCandidates drops low-fit songs below the acceptance floor', () => {
  const seeds = savedSeeds();
  const model = modelFor(seeds);
  const scoreProfile = buildScoreProfile(seeds, model);
  const good = track('good', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: '雨夜情歌', durationSeconds: 245 });
  // A totally foreign, very long remix scores far below the saved-song range.
  const bad = track('bad', [{ id: 'Z9', name: '陌生' }], { id: 'Z8', title: '别的' }, true,
    { title: 'Unknown Remix', durationSeconds: 900 });
  const ranked = rankCandidates([good, bad], { model, scoreProfile });
  assert.deepEqual(ranked.map(item => item.track.id), ['good'], 'low-fit song must be filtered out');
});

test('rankCandidates caps one song per artist and per album before relaxing', () => {
  // No profile → no floor filtering, so the diversity cap itself is what we measure here.
  const candidates = [
    ...Array.from({ length: 6 }, (_unused, index) => track(`a${index}`, [{ id: 'A1', name: '甲' }],
      { id: 'L1', title: '专辑一' })),
    ...Array.from({ length: 6 }, (_unused, index) => track(`b${index}`, [{ id: 'A2', name: '乙' }],
      { id: 'L2', title: '专辑二' })),
  ];
  const ranked = rankCandidates(candidates, { limit: 4 });
  assert.equal(new Set(ranked.slice(0, 2).map(item => item.track.artists[0].id)).size, 2,
    'first pass must alternate artists');
  assert.equal(new Set(ranked.slice(0, 2).map(item => item.track.album.id)).size, 2,
    'first pass must alternate albums');
  assert.equal(DIVERSITY_CAPS[0], 1);
});

test('rankCandidates drops excluded, duplicate and unavailable rows', () => {
  const ranked = rankCandidates([
    track('known'), track('known'), track('off', [], undefined, false), track('ok'), null, {},
  ], { excludeIds: ['known'] });
  assert.deepEqual(ranked.map(item => item.track.id), ['ok']);
  assert.deepEqual(ranked[0].reasons, []);
});

test('rankCandidates honours the limit even when the artist cap cannot be met', () => {
  const candidates = Array.from({ length: 40 }, (_unused, index) => track(`t${index}`, [{ id: 'A1', name: '唯一' }]));
  const ranked = rankCandidates(candidates, { limit: 5 });
  assert.equal(ranked.length, 5);
});

test('recommendation pool interleaves groups and drops known, duplicate and unavailable tracks', () => {
  const pool = buildRecommendationPool([
    { key: 'artist:A1', weight: 9, tracks: [track('known'), track('x1'), track('x2'), track('shared')] },
    { key: 'artist:A2', weight: 2, tracks: [track('y1'), track('shared'), track('off', [], undefined, false)] },
  ], ['known']);
  assert.deepEqual(pool.map(item => item.id), ['x1', 'y1', 'x2', 'shared']);
  assert.equal(pool.some(item => item.id === 'known'), false);
  assert.equal(pool.some(item => item.id === 'off'), false);
});

test('recommendation pool honours the limit and orders groups by weight', () => {
  const pool = buildRecommendationPool([
    { key: 'album:L2', weight: 1, tracks: [track('b1'), track('b2'), track('b3')] },
    { key: 'artist:A1', weight: 8, tracks: [track('a1'), track('a2'), track('a3')] },
  ], [], { limit: 4 });
  assert.deepEqual(pool.map(item => item.id), ['a1', 'b1', 'a2', 'b2']);
});

test('recommendation pool ranks by fit and filters low-fit songs when a model is supplied', () => {
  const seeds = [track('s1', [{ id: 'A1', name: '甲' }], undefined, true, { title: '华语' })];
  const model = modelFor(seeds);
  const scoreProfile = buildScoreProfile(seeds, model);
  const pool = buildRecommendationPool([
    { key: 'artist:A1', weight: 1, tracks: [track('cold', [{ id: 'A9', name: 'Foreigner' }], undefined, true, { title: 'Other Song' })] },
    { key: 'artist:A2', weight: 1, tracks: [track('warm', [{ id: 'A1', name: '甲' }], undefined, true, { title: '华语二' })] },
  ], [], { limit: 2, model, scoreProfile });
  assert.deepEqual(pool.map(item => item.id), ['warm'], 'the foreign low-fit song must be filtered out');
});

test('recommendation pool tolerates malformed groups', () => {
  assert.deepEqual(buildRecommendationPool(null, null), []);
  assert.deepEqual(buildRecommendationPool([{}, { key: 'x', tracks: null }], []), []);
});

test('secondHopSeeds finds artists/albums outside the direct saves', () => {
  const seeds = savedSeeds();
  const profile = buildTasteProfile(seeds);
  const found = secondHopSeeds([
    track('p1', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }),
    track('p2', [{ id: 'A2', name: '乙' }], { id: 'L2', title: '专辑二' }),
    track('p3', [{ id: 'A2', name: '乙' }], { id: 'L2', title: '专辑二' }),
    track('p4', [{ id: 'A3', name: '丙' }], { id: 'L3', title: '专辑三' }),
  ], { artistIds: profile.artists.map(entry => entry.id), albumIds: profile.albums.map(entry => entry.id) });
  assert.deepEqual(found.artists.map(entry => entry.id), ['A2', 'A3']);
  assert.deepEqual(found.albums.map(entry => entry.id), ['L2', 'L3']);
});

test('buildSearchKeywords uses real profile signals and deduplicates', () => {
  const seeds = [
    track('s1', [], undefined, true, { title: '雨夜情歌 (Live)', durationSeconds: 240 }),
    track('s2', [], undefined, true, { title: '雨夜情歌 (Live)', durationSeconds: 240 }),
  ];
  const profile = buildTasteProfile(seeds);
  const keywords = buildSearchKeywords(profile, buildThemeTokens(seeds), { limit: 4 });
  assert.deepEqual(new Set(keywords), new Set(['Live', '雨夜', '夜情', '情歌']));
  assert.deepEqual(buildSearchKeywords(null, []), []);
});

test('batchOf returns stable windows and wraps around', () => {
  const pool = [1, 2, 3, 4, 5].map(value => track(`t${value}`));
  assert.deepEqual(batchOf(pool, 2, 0).map(item => item.id), ['t1', 't2']);
  assert.deepEqual(batchOf(pool, 2, 1).map(item => item.id), ['t3', 't4']);
  assert.deepEqual(batchOf(pool, 2, 2).map(item => item.id), ['t5']);
  assert.deepEqual(batchOf(pool, 2, 3).map(item => item.id), ['t1', 't2']);
  assert.deepEqual(batchOf(pool, 2, -1).map(item => item.id), ['t5']);
});

test('batchOf handles empty pools and invalid page sizes', () => {
  assert.deepEqual(batchOf([], 20, 0), []);
  assert.deepEqual(batchOf(null, 20, 0), []);
  assert.deepEqual(batchOf([track('a')], 0, 0).map(item => item.id), ['a']);
});

test('formatClock renders m:ss for the summary line', () => {
  assert.equal(formatClock(245), '4:05');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(undefined), '0:00');
});
