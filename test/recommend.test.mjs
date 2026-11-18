import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIMENSION_WEIGHTS, batchOf, buildRecommendationModel, buildRecommendationPool, buildTasteProfile,
  detectLanguage, formatClock, rankCandidates, scoreCandidate, versionTagsOf,
} from '../src/renderer/recommend.mjs';

const track = (id, artists = [], album, available = true, extra = {}) => ({ id, title: id, artists, album, available, ...extra });

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

test('dimension weights sum to one so scores stay comparable', () => {
  const total = Object.values(DIMENSION_WEIGHTS).reduce((sum, value) => sum + value, 0);
  assert.equal(Math.round(total * 1000) / 1000, 1);
});

test('scoreCandidate rewards every dimension it can see', () => {
  const profile = buildTasteProfile([
    track('s1', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true, { title: '华语歌', durationSeconds: 240 }),
    track('s2', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true, { title: '另一首', durationSeconds: 250 }),
  ]);
  const model = buildRecommendationModel(profile, { playlistHits: new Map([['hit', 2]]) });

  const strong = scoreCandidate(track('hit', [{ id: 'A1', name: '甲' }], { id: 'L1', title: '专辑一' }, true,
    { title: '华语新歌', durationSeconds: 245 }), model);
  const weak = scoreCandidate(track('cold', [{ id: 'A9', name: '陌生' }], { id: 'L9', title: '别的专辑' }, true,
    { title: 'Different Song', durationSeconds: 640 }), model);

  assert.ok(strong.score > weak.score + 0.5, `strong ${strong.score} should clearly beat weak ${weak.score}`);
  assert.match(strong.reasons.join(' / '), /常听歌手 甲/);
  assert.match(strong.reasons.join(' / '), /同专辑《专辑一》/);
  assert.match(strong.reasons.join(' / '), /收藏歌单共现 ×2/);
  assert.match(strong.reasons.join(' / '), /语种 华语/);
});

test('scoreCandidate penalises versions the library never keeps', () => {
  const profile = buildTasteProfile([
    track('s1', [{ id: 'A1', name: '甲' }], undefined, true, { title: '录音室版', durationSeconds: 200 }),
  ]);
  const model = buildRecommendationModel(profile);
  const studio = scoreCandidate(track('x', [{ id: 'A1', name: '甲' }], undefined, true, { title: '录音室版二' }), model);
  const live = scoreCandidate(track('y', [{ id: 'A1', name: '甲' }], undefined, true, { title: '录音室版 (Live)' }), model);
  assert.ok(studio.score > live.score, 'a live-only title should score below a plain one');
});

test('rankCandidates sorts by score and keeps the first page diverse', () => {
  const profile = buildTasteProfile([
    track('s1', [{ id: 'A1', name: '甲' }], undefined, true, { title: '华语一', durationSeconds: 240 }),
  ]);
  const model = buildRecommendationModel(profile);
  const candidates = [
    ...Array.from({ length: 6 }, (_unused, index) => track(`a${index}`, [{ id: 'A1', name: '甲' }], undefined, true,
      { title: `甲的歌 ${index}`, durationSeconds: 240 })),
    track('b1', [{ id: 'A2', name: '乙' }], undefined, true, { title: '乙的歌', durationSeconds: 240 }),
  ];
  const ranked = rankCandidates(candidates, { limit: 7, model });
  assert.equal(ranked.length, 7);
  // The artist cap lets the other artist in before one artist owns the whole list.
  assert.equal(ranked.slice(0, 3).filter(item => item.track.id.startsWith('a')).length, 2);
  assert.equal(ranked[2].track.id, 'b1');
  assert.ok(ranked[0].score >= ranked[ranked.length - 1].score);
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
  // Round-robin: one from the strong group, then one from the weak group, and so on.
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

test('recommendation pool switches to scored ranking when a model is supplied', () => {
  const profile = buildTasteProfile([track('s1', [{ id: 'A1', name: '甲' }], undefined, true, { title: '华语' })]);
  const model = buildRecommendationModel(profile);
  const pool = buildRecommendationPool([
    { key: 'artist:A1', weight: 1, tracks: [track('cold', [{ id: 'A9', name: '陌生' }], undefined, true, { title: 'Other' })] },
    { key: 'artist:A2', weight: 1, tracks: [track('warm', [{ id: 'A1', name: '甲' }], undefined, true, { title: '华语二' })] },
  ], [], { limit: 2, model });
  assert.deepEqual(pool.map(item => item.id), ['warm', 'cold']);
});

test('recommendation pool tolerates malformed groups', () => {
  assert.deepEqual(buildRecommendationPool(null, null), []);
  assert.deepEqual(buildRecommendationPool([{}, { key: 'x', tracks: null }], []), []);
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
