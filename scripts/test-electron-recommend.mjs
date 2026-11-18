// Offline Electron regression for the local recommendation page: the renderer must derive
// taste from saved songs / collected playlists, fetch same-artist and same-album candidates
// through the existing catalog APIs, and page through the result without repeating seeds.
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
    { id: 'seed-1', title: '收藏甲', artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 240 },
    { id: 'seed-2', title: '收藏乙', artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 250 },
  ];
  const artistCandidates = Array.from({ length: 25 }, (_unused, index) => ({
    id: `candidate-${index + 1}`, title: `推荐 ${index + 1}`,
    artists: [{ id: 'artist-1', name: '本地歌手' }], album: { id: 'album-1', title: '本地专辑' }, available: true,
    durationSeconds: 245,
  }));
  const albumCandidates = [artistCandidates[0], artistCandidates[1],
    { id: 'album-only-1', title: '专辑专属一', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 230 },
    { id: 'album-only-2', title: '专辑专属二', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 500 },
  ];
  const history = [{ id: 'history-1', title: '最近听过', artists: [{ id: 'artist-2', name: '另一位' }], album: { id: 'album-1', title: '本地专辑' }, available: true, durationSeconds: 235 }];

  await instance.evaluate(({ ipcMain }, { seeds: saved, artistCandidates: fromArtist, albumCandidates: fromAlbum, history: played }) => {
    const ok = data => ({ ok: true, data });
    const channels = ['auth:status', 'music:favorites', 'music:favorites-summary', 'music:resolve-playback', 'music:lyrics',
      'music:set-favorite', 'music:playlists', 'music:playlist-detail', 'music:search', 'music:history', 'music:album',
      'music:artist', 'music:favorite-state', 'music:report-playback', 'music:create-playlist',
      'music:update-playlist-description', 'music:delete-playlist'];
    for (const channel of channels) ipcMain.removeHandler(channel);
    ipcMain.handle('auth:status', () => ok({ authenticated: true, persistence: 'memory-only' }));
    ipcMain.handle('music:favorites', () => ok({ tracks: saved, nextStart: 50, hasMore: false, total: saved.length }));
    ipcMain.handle('music:favorites-summary', () => ok({ total: saved.length }));
    ipcMain.handle('music:playlists', () => ok({ playlists: [{ id: 'collected-1', title: '收藏歌单', kind: 'collected' }], truncated: false }));
    ipcMain.handle('music:playlist-detail', () => ok({
      playlist: { id: 'collected-1', title: '收藏歌单', kind: 'collected' },
      tracks: [saved[0]], nextStart: 50, hasMore: false,
    }));
    ipcMain.handle('music:artist', () => ok({
      artist: { id: 'artist-1', name: '本地歌手' }, tracks: fromArtist, albums: [],
    }));
    ipcMain.handle('music:album', () => ok({
      album: { id: 'album-1', title: '本地专辑', artists: [{ name: '本地歌手' }] },
      tracks: fromAlbum, nextStart: 50, hasMore: false,
    }));
    ipcMain.handle('music:favorite-state', () => ok({ favorite: false }));
    ipcMain.handle('music:set-favorite', (_event, input) => ok({ favorite: input.favorite }));
    ipcMain.handle('music:search', () => ok({ tracks: [], nextStart: 0, hasMore: false }));
    ipcMain.handle('music:history', () => ok({ tracks: played }));
    ipcMain.handle('music:lyrics', () => ok({ synced: false, lines: [] }));
    ipcMain.handle('music:resolve-playback', () => ok({ url: '', actualQuality: 'unknown' }));
    ipcMain.handle('music:report-playback', () => ok(undefined));
    ipcMain.handle('music:create-playlist', () => ok({ id: 'new-1' }));
    ipcMain.handle('music:update-playlist-description', () => ok({ id: 'collected-1' }));
    ipcMain.handle('music:delete-playlist', () => ok({ id: 'collected-1' }));
  }, { seeds, artistCandidates, albumCandidates, history });

  const rowLabels = () => page.locator('.recommend-library .track-row')
    .evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')));

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
  assert.match(summaryText, /按 歌手 \/ 专辑 \/ 收藏歌单共现 \/ 语种 \/ 时长习惯 排序/);

  // The profile readout must show the dimensions actually used, not only artist names.
  const dims = await page.locator('.recommend-dim').allInnerTexts();
  assert.ok(dims.some(text => /华语 100%/.test(text)), `language dimension missing: ${dims.join(' | ')}`);
  assert.ok(dims.some(text => /平均时长/.test(text)), `duration dimension missing: ${dims.join(' | ')}`);

  // The favourite seeds must never be recommended back to the user.
  const firstBatch = await rowLabels();
  assert.equal(firstBatch.length, 20, 'first recommendation batch should hold 20 tracks');
  assert.equal(firstBatch.some(label => label?.includes('收藏甲') || label?.includes('收藏乙')), false,
    'seed tracks leaked into recommendations');

  // Every row carries the reason it was picked, so the five dimensions are visible per track.
  assert.match(await page.locator('.recommend-library .track-why').first().innerText(), /常听歌手 本地歌手/);

  await page.getByRole('button', { name: '换一批' }).click();
  const secondBatch = await rowLabels();
  assert.equal(secondBatch.length, 7, 'second batch should hold the remaining candidates');
  assert.equal(secondBatch.some(label => firstBatch.includes(label)), false, '换一批 repeated the same tracks');
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
