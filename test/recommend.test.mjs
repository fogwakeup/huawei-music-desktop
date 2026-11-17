import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTasteProfile, buildRecommendationPool, batchOf } from '../src/renderer/recommend.mjs';

const track = (id, artists = [], album, available = true) => ({ id, title: id, artists, album, available });

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

test('taste profile tolerates empty and malformed input', () => {
  assert.deepEqual(buildTasteProfile(null), { artists: [], albums: [] });
  assert.deepEqual(buildTasteProfile([]), { artists: [], albums: [] });
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
