// Local, offline recommender. The provider's documented "daily recommendation" endpoint
// rejects every known request shape (HTTP 400, see docs/feature-validation.md), so instead
// we derive taste from the user's saved songs and fetch more titles from the same
// artists/albums through the already-verified catalog APIs. All functions here are pure so
// they can be unit-tested without Electron.

function idOf(value) {
  return typeof value === 'string' && value.length ? value : '';
}

/**
 * Count how often each artist / album appears in the seed tracks.
 * Ties break by id so the output stays stable across runs.
 */
export function buildTasteProfile(tracks) {
  const artists = new Map();
  const albums = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || typeof track !== 'object') continue;
    for (const artist of Array.isArray(track.artists) ? track.artists : []) {
      const id = idOf(artist?.id);
      if (!id) continue;
      const found = artists.get(id);
      if (found) found.count += 1;
      else artists.set(id, { id, name: typeof artist.name === 'string' ? artist.name : '', count: 1 });
    }
    const album = track.album;
    const albumId = idOf(album?.id);
    if (albumId) {
      const found = albums.get(albumId);
      if (found) found.count += 1;
      else albums.set(albumId, { id: albumId, title: typeof album.title === 'string' ? album.title : '', count: 1 });
    }
  }
  const byFrequency = (left, right) => right.count - left.count || left.id.localeCompare(right.id);
  return {
    artists: [...artists.values()].sort(byFrequency),
    albums: [...albums.values()].sort(byFrequency),
  };
}

/**
 * Interleave candidate groups one track at a time (round-robin) so one dominant artist
 * cannot fill the whole list. Groups are visited in descending preference order.
 * Tracks already in the library (seed ids) and unavailable tracks are dropped, as are
 * duplicates across groups.
 */
export function buildRecommendationPool(groups, knownIds, options = {}) {
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? Math.floor(options.limit) : 120;
  const known = new Set((Array.isArray(knownIds) ? knownIds : []).filter(idOf));
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
