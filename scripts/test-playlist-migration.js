/**
 * Test playlist data migration, deduplication, and Bilibili favorite parsing logic
 */
const assert = require('assert');

console.log('[test:playlist] Running playlist migration and integrity validation...');

// Test 1: Favorite item normalization
function normalizeMediaItem(item) {
  const bvid = item.bvid || item.bv_id || item.id || '';
  const cid = item.cid || item.ugc?.first_cid || 0;
  return {
    bvid,
    cid,
    favId: item.id,
    favType: item.type,
    title: item.title ? item.title.replace(/<[^>]+>/g, '').trim() : '',
    artist: item.upper?.name || item.author || '未知歌手',
    cover: item.cover || item.pic || '',
    duration: item.duration || 0,
    source: 'bilibili'
  };
}

const rawItemWithUgc = {
  id: 11223344,
  bvid: 'BV1xx411c7mD',
  title: '<em>测试歌曲</em>',
  cover: 'https://i0.hdslb.com/bfs/archive/test.jpg',
  duration: 180,
  upper: { name: 'UP主' },
  ugc: { first_cid: 99887766 }
};

const normalized = normalizeMediaItem(rawItemWithUgc);
assert.strictEqual(normalized.bvid, 'BV1xx411c7mD');
assert.strictEqual(normalized.cid, 99887766, 'Fallback to ugc.first_cid should succeed');
assert.strictEqual(normalized.title, '测试歌曲', 'HTML tags should be stripped');
assert.strictEqual(normalized.artist, 'UP主');

console.log('✓ Favorite item normalization with UGC CID fallback verified.');

// Test 2: Playlist deduplication
const playlist = {
  id: 'bili-fav-123456',
  name: '我的收藏',
  music: [
    { bvid: 'BV1xx411c7mD', cid: 99887766, title: '测试歌曲' }
  ]
};

function appendMedia(targetPlaylist, newMedias) {
  let added = 0;
  for (const item of newMedias) {
    const norm = normalizeMediaItem(item);
    const exists = targetPlaylist.music.some(m => m.bvid === norm.bvid && (!norm.cid || m.cid === norm.cid));
    if (!exists) {
      targetPlaylist.music.push(norm);
      added++;
    }
  }
  return added;
}

const duplicateMedias = [
  rawItemWithUgc, // Duplicate
  {
    id: 55667788,
    bvid: 'BV2yy411c7mE',
    title: '新歌曲',
    cover: '',
    duration: 200,
    upper: { name: '另一个歌手' },
    cid: 12345678
  }
];

const addedCount = appendMedia(playlist, duplicateMedias);
assert.strictEqual(addedCount, 1, 'Only non-duplicate song should be appended');
assert.strictEqual(playlist.music.length, 2);
assert.strictEqual(playlist.music[1].bvid, 'BV2yy411c7mE');

console.log('✓ Playlist deduplication verified.');

// Test 3: Attribute bitmask filtering and invalid video filtering
function filterAndAppendFavMedias(targetPl, medias) {
  if (!targetPl.music) targetPl.music = [];
  let added = 0;
  let skipped = 0;
  medias.forEach(item => {
    if (!item) return;

    // Check invalid videos
    if (
      item.title === '已失效视频' ||
      item.title === '已失效稿件' ||
      item.state === -404 ||
      (typeof item.attr === 'number' && (item.attr & 1) === 1) ||
      item.attr === 9
    ) {
      skipped++;
      return;
    }

    // Skip collections & movies
    if (item.type === 21 || item.type === 24) {
      skipped++;
      return;
    }

    const bvid = item.bvid || item.bv_id;
    const hasBvid = !!bvid;
    if (!hasBvid && !item.id) return;

    const finalCid = item.cid || item.ugc?.first_cid || 0;
    const finalCover = item.cover && (item.cover.startsWith('//') ? `https:${item.cover}` : item.cover);
    const finalAuthor = item.upper?.name || item.upper?.mid || item.author || '未知歌手';

    const existing = targetPl.music.find(m => m && (
      (hasBvid && m.bvid === bvid) ||
      (!hasBvid && m.favId === item.id && m.favType === item.type)
    ));

    if (existing) {
      if (!existing.cid && finalCid) existing.cid = finalCid;
      if (!existing.cover && finalCover) existing.cover = finalCover;
      if (!existing.duration && item.duration) existing.duration = item.duration;
      if (!existing.author && finalAuthor) existing.author = finalAuthor;
      return;
    }

    targetPl.music.push({
      bvid: bvid || '',
      cid: finalCid,
      favId: item.id,
      favType: item.type,
      title: item.title ? item.title.replace(/<[^>]+>/g, '').trim() : '',
      author: finalAuthor,
      cover: finalCover || '',
      duration: item.duration || 0,
      playCount: item.cnt_info?.play || 0,
      isBiliFavoriteResource: true
    });
    added++;
  });
  return { added, skipped };
}

const testFavPlaylist = { id: 'bili-fav-999', music: [] };
const mockFavMedias = [
  { id: 1, bvid: 'BV001', title: 'Normal 0 attr', attr: 0, duration: 100 },
  { id: 2, bvid: 'BV002', title: 'Collaboration attr=2', attr: 2, duration: 120 }, // Previously mistakenly skipped!
  { id: 3, bvid: 'BV003', title: 'Charging attr=4', attr: 4, duration: 150 }, // Previously mistakenly skipped!
  { id: 4, bvid: 'BV004', title: '4K attr=16', attr: 16, duration: 200 }, // Previously mistakenly skipped!
  { id: 5, bvid: 'BV005', title: '已失效视频', attr: 0, duration: 0 }, // Must be skipped
  { id: 6, bvid: 'BV006', title: 'Deleted video state=-404', state: -404, duration: 0 }, // Must be skipped
  { id: 7, bvid: 'BV007', title: 'Invalid bit attr=1', attr: 1, duration: 0 }, // Must be skipped
  { id: 8, bvid: 'BV008', title: 'Invalid bit attr=9', attr: 9, duration: 0 }, // Must be skipped
  { id: 9, bvid: 'BV009', title: 'Chasing episode type=21', type: 21, duration: 1000 }, // Must be skipped
  { id: 10, bvid: 'BV010', title: 'Movie type=24', type: 24, duration: 7200 }, // Must be skipped
];

const res1 = filterAndAppendFavMedias(testFavPlaylist, mockFavMedias);
assert.strictEqual(res1.added, 4, 'Should add exactly 4 valid songs (attr 0, 2, 4, 16)');
assert.strictEqual(res1.skipped, 6, 'Should skip 6 invalid / non-music items');
assert.strictEqual(testFavPlaylist.music.length, 4);

// Test enrichment of existing music
const enrichMock = [
  { id: 1, bvid: 'BV001', title: 'Normal 0 attr', attr: 0, cid: 99999, cover: '//i0.hdslb.com/test.jpg' }
];
const res2 = filterAndAppendFavMedias(testFavPlaylist, enrichMock);
assert.strictEqual(res2.added, 0, 'No new item should be added');
const item1 = testFavPlaylist.music.find(m => m.bvid === 'BV001');
assert.strictEqual(item1.cid, 99999, 'Missing CID should be enriched');
assert.strictEqual(item1.cover, 'https://i0.hdslb.com/test.jpg', 'Missing cover should be enriched with https:');

console.log('✓ Attribute bitmask and invalid video filtering verified.');

// Test 4: Pagination logic when medias.length < 20 but has_more is true
function shouldContinuePaging(data, medias, totalLoaded, totalCount) {
  if (data?.has_more !== undefined) {
    return Boolean(data.has_more);
  } else if (totalCount > 0) {
    return totalLoaded < totalCount;
  } else {
    return medias.length >= 20;
  }
}

// Case 1: Page has 18 items (Bilibili server internally filtered 2 items), but has_more is true
assert.strictEqual(
  shouldContinuePaging({ has_more: true }, new Array(18), 18, 50),
  true,
  'Should continue paging if has_more=true even if medias.length < 20'
);

// Case 2: Page has 20 items, but has_more is false (last page)
assert.strictEqual(
  shouldContinuePaging({ has_more: false }, new Array(20), 40, 40),
  false,
  'Should stop paging when has_more=false'
);

// Case 3: Missing has_more, but totalLoaded < totalCount
assert.strictEqual(
  shouldContinuePaging({}, new Array(15), 15, 30),
  true,
  'Should continue paging if totalLoaded < totalCount when has_more is missing'
);

console.log('✓ Pagination logic with partial page count verified.');

console.log('[test:playlist] All playlist tests passed!');
process.exit(0);
