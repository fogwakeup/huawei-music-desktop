// Offline Electron regression for the local recommendation page. It must derive a target
// score from saved songs, widen the pool beyond the saved artists/albums (second-hop artists,
// chart playlists and profile-driven search), and rank by score similarity instead of by
// artist identity. All catalogue calls are stubbed; no network access is needed.
import electron from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as playwright } from 'playwright-core';

process.umask(0o077);
const profile = await mkdtemp(join(tmpdir(), 'huawei-recommend-profile-'));
let app;

try {
  const instance = await playwright.launch({
    executablePath: electron,
    args: [...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--user-data-dir=${profile}`, 'out/main/index.js'],
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  });
  app = instance;
  const page = await instance.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForTimeout(1200);

  const seeds = [
    { id: 'seed-1', title: '收藏情歌甲', artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 240 },
    { id: 'seed-2', title: '收藏情歌乙', artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 250 },
  ];
  const artistCandidates = Array.from({ length: 25 }, (_unused, index) => ({
    id: `candidate-${index + 1}`, title: `推荐 ${index + 1}`,
    artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true,
    durationSeconds: 245,
  }));
  // Accompaniment renditions score like a saved artist's own track, so without the filter they
  // would sit at the very top of the page. They must never reach the list.
  const accompanimentCandidates = [
    { id: 'inst-1', title: '推荐一 (伴奏)', artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 245 },
    { id: 'inst-2', title: '收藏情歌甲 纯音乐', artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 240 },
    { id: 'inst-3', title: '推荐二 (Instrumental)', artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-inst', title: '本地专辑（伴奏）' }, available: true, durationSeconds: 245 },
  ];
  const albumCandidates = [artistCandidates[0], artistCandidates[1],
    { id: 'album-only-1', title: '专辑专属一', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 230 },
    { id: 'album-only-2', title: '专辑专属二', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 500 },
  ];
  const history = [{ id: 'history-1', title: '最近听过', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 235 }];
  const secondArtistTracks = [
    { id: 'second-1', title: '二跳新歌一', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-2', title: '另一张专辑' }, available: true, durationSeconds: 242 },
    { id: 'second-2', title: '二跳新歌二', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-2', title: '另一张专辑' }, available: true, durationSeconds: 244 },
  ];
  const chartTracks = [
    { id: 'chart-1', title: '榜单热歌一', artists: [{ id: 'artist-10', name: '榜歌手甲' }], album: { id: 'album-10', title: '榜专辑甲' }, available: true, durationSeconds: 246 },
    { id: 'chart-2', title: '榜单热歌二', artists: [{ id: 'artist-11', name: '榜歌手乙' }], album: { id: 'album-11', title: '榜专辑乙' }, available: true, durationSeconds: 248 },
  ];
  const searchTrack = { id: 'search-1', title: '收藏的新歌', artists: [{ id: 'artist-9', name: '独立音乐人' }], album: { id: 'album-9', title: '新专辑' }, available: true, durationSeconds: 245 };

  await instance.evaluate(({ ipcMain }, fixtures) => {
    const ok = data => ({ ok: true, data });
    const channels = ['auth:status', 'music:favorites', 'music:favorites-summary', 'music:resolve-playback', 'music:lyrics',
      'music:set-favorite', 'music:playlists', 'music:playlist-detail', 'music:search', 'music:history', 'music:album',
      'music:artist', 'music:favorite-state', 'music:report-playback', 'music:create-playlist',
      'music:update-playlist-description', 'music:delete-playlist'];
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.handle('auth:status', () => ok({ authenticated: true, persistence: 'memory-only' }));
    ipcMain.handle('music:favorites', () => ok({ tracks: fixtures.saved, nextStart: 50, hasMore: false, total: fixtures.saved.length }));
    ipcMain.handle('music:favorites-summary', () => ok({ total: fixtures.saved.length }));
    ipcMain.handle('music:playlists', () => ok({
      playlists: [
        { id: 'collected-1', title: '收藏歌单', kind: 'collected' },
        { id: 'chart-1', title: '热歌榜', kind: 'chart' },
      ],
      truncated: false,
    }));
    ipcMain.handle('music:playlist-detail', (_event, input) => ok({
      playlist: { id: input.id, title: input.id, kind: input.kind },
      tracks: input.kind === 'chart' ? fixtures.chart : [fixtures.saved[0]],
      nextStart: 50, hasMore: false,
    }));
    ipcMain.handle('music:artist', (_event, input) => ok({
      artist: { id: input.id, name: input.id },
      tracks: [...(input.id === 'artist-2' ? fixtures.second : fixtures.fromArtist), ...fixtures.accompaniment],
      albums: [],
    }));    ipcMain.handle('music:album', () => ok({
      album: { id: 'album-1', title: '本地专辑', artists: [{ name: '本地歌手' }] },
      tracks: fixtures.fromAlbum, nextStart: 50, hasMore: false,
    }));
    ipcMain.handle('music:favorite-state', () => ok({ favorite: false }));
    ipcMain.handle('music:set-favorite', (_event, input) => ok({ favorite: input.favorite }));
    ipcMain.handle('music:search', (_event, input) => ok({
      tracks: input.query === '收藏' ? [fixtures.searchTrack, fixtures.accompaniment[0]] : [],
      nextStart: 0, hasMore: false,
    }));
    ipcMain.handle('music:history', () => ok({ tracks: fixtures.played }));
    ipcMain.handle('music:lyrics', () => ok({ synced: false, lines: [] }));
    ipcMain.handle('music:resolve-playback', () => ok({ url: '', actualQuality: 'unknown' }));
    ipcMain.handle('music:report-playback', () => ok(undefined));
    ipcMain.handle('music:create-playlist', () => ok({ id: 'new-1' }));
    ipcMain.handle('music:update-playlist-description', () => ok({ id: 'collected-1' }));
    ipcMain.handle('music:delete-playlist', () => ok({ id: 'collected-1' }));
  }, {
    saved: seeds, fromArtist: artistCandidates, fromAlbum: albumCandidates, played: history,
    second: secondArtistTracks, chart: chartTracks, searchTrack,
    accompaniment: accompanimentCandidates,
  });

  const rowLabels = () => page.locator('.recommend-library .track-row')
    .evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));
  const assertNoAccompaniment = (labels, where) => {
    const leaked = labels.filter(label => /伴奏|纯音乐|Instrumental/i.test(label ?? ''));
    assert.deepEqual(leaked, [], `accompaniment leaked into ${where}`);
  };

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('button', { name: '猜你喜欢', exact: true }).click();

  await page.locator('.recommend-hero h2').waitFor({ timeout: 15_000 });
  assert.equal(await page.locator('.topbar h1').innerText(), '猜你喜欢');
  assert.equal(await page.locator('.recommend-hero h2').innerText(), '猜你喜欢');

  // The summary lands after every source has been read, so wait for it instead of racing it.
  await page.waitForFunction(() => {
    const node = document.querySelector('.recommend-heading > p');
    return !!node && /基于 2 首收藏歌曲、1 个收藏歌单/.test(node.textContent ?? '');
  }, null, { timeout: 15_000 });
  const summaryText = await page.locator('.recommend-heading > p').first().innerText();
  assert.match(summaryText, /基于 2 首收藏歌曲、1 个收藏歌单、1 条最近播放/);
  assert.match(summaryText, /按口味契合度从高到低（契合线 \d+\+，收藏歌手\/专辑优先，每位歌手限量避免刷屏）/);
  // Every widening source must have contributed, otherwise we are still in the old bubble.
  assert.match(summaryText, /1 个二跳来源/);
  assert.match(summaryText, /3 组主题搜索/);
  assert.match(summaryText, /1 个榜单/);
  // Accompaniment must be filtered out before ranking, and the page says so.
  assert.match(summaryText, /已过滤 3 首伴奏\/纯音乐/, `accompaniment filter missing: ${summaryText}`);

  // The profile readout must show the score target, not only artist names.
  const dims = await page.locator('.recommend-dim').allInnerTexts();
  assert.ok(dims.some(text => /口味契合线 \d+\+/.test(text)), `fit floor missing: ${dims.join(' | ')}`);
  assert.ok(dims.some(text => /主题「收藏」|主题「情歌」/.test(text)), `theme token missing: ${dims.join(' | ')}`);
  assert.ok(dims.some(text => /华语 100%/.test(text)), `language dimension missing: ${dims.join(' | ')}`);
  assert.ok(dims.some(text => /平均时长/.test(text)), `duration dimension missing: ${dims.join(' | ')}`);

  // The favourite seeds must never be recommended back to the user.
  const firstBatch = await rowLabels();
  assert.equal(firstBatch.length, 20, 'first recommendation batch should hold 20 tracks');
  assert.equal(firstBatch.some(label => label?.includes('收藏情歌')), false,
    'seed tracks leaked into recommendations');
  assertNoAccompaniment(firstBatch, 'the first batch');

  // Every row shows the score that decided its position plus a readable reason.
  assert.match(await page.locator('.recommend-library .track-why').first().innerText(), /评分 \d+/);

  await page.getByRole('button', { name: '换一批' }).click();
  const secondBatch = await rowLabels();
  assert.equal(secondBatch.length, 7, 'second batch should hold the remaining candidates');
  assert.equal(secondBatch.some(label => firstBatch.includes(label)), false, '换一批 repeated the same tracks');
  assertNoAccompaniment(secondBatch, 'the second batch');
  assert.match(await page.locator('.recommend-library .hint').innerText(), /共 27 首候选/);

  // "重新分析" rebuilds from the same fixtures and returns to the first batch.
  await page.getByRole('button', { name: '重新分析' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.recommend-library .track-row').length === 20, null, { timeout: 15_000 });
  assert.deepEqual(await rowLabels(), firstBatch);

  if (process.env.CAPTURE_RECOMMEND) await page.screenshot({ path: process.env.CAPTURE_RECOMMEND });
  console.log('Recommendation page regression passed.');
} finally {
  if (app) await app.close().catch(() => {});
}
