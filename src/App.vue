<script setup>
import { ref, onMounted, onUnmounted, onBeforeUnmount, computed, watch, nextTick } from 'vue'
import { parseDuration, formatPlayCount, fixCoverUrl } from './utils/bilibili.js'
import WindowControls from './components/WindowControls.vue'
import AppDock from './components/AppDock.vue'
import MineView from './components/MineView.vue'
import LyricDisplay from './components/player/LyricDisplay.vue'
import AudioVisualizer from './components/AudioVisualizer.vue'
import AlbumRipple from './components/AlbumRipple.vue'
import { useLyricStore, usePlayerStore, useSettingsStore, useDownloadStore, useUserStore, usePlaylistStore, useThemeStore, useUpdateStore, useLocalStore } from './stores'
import DownloadManager from './components/DownloadManager.vue'
import LoginPanel from './components/LoginPanel.vue'
import OnboardingGuide from './components/OnboardingGuide.vue'
import LocalMusicView from './components/LocalMusicView.vue'
import { applyLiquidGlass, destroyLiquidGlass } from './composables/useLiquidGlass'
import { useDesktopLyrics } from './composables/useDesktopLyrics'
import { useAudioPlayer } from './composables/useAudioPlayer'
import {
  getAudioEl,
  bindPlaybackRuntime,
  playWithResolvedSrc,
  pauseAudio,
  playAudio,
  seekAudio,
  updateMediaSession,
  prefetchTrack,
  computeBufferedPercent
} from './utils/audioEngine'
import { destroyAudioAnalyser } from './utils/audioAnalyser.js'
import { resolvePlaySource, toLocalUrl } from './utils/playUrlCache'
import { isLocalTrack, trackKey as makeTrackKey, sameTrack, isTrackLike, pickTrackFields } from './utils/trackKey'
import { syncPlaylistCover } from './stores/playlist'
import { appConfirm } from './utils/confirm'
import { flushPendingLocalWrites } from './utils/persistentStorage'
import logger from './utils/logger'

// flush 协议相关：保存 IPC 监听器反注册函数，HMR 时清理旧监听器，避免重复注册
let unregisterFlushListener = null
// 关窗前兜底 flush 监听（onMounted 注册，卸载时注销）
let beforeUnloadFlush = null
// HMR 兜底：模块级标记，让 vite HMR 重新执行前先清理旧监听器
const HMR_FLUSH_KEY = '__pink_music_flush_listener_installed__'
if (typeof window !== 'undefined' && window[HMR_FLUSH_KEY]) {
  try { window[HMR_FLUSH_KEY]() } catch (_) {}
  window[HMR_FLUSH_KEY] = null
}

const topbarRef = ref(null)
const playerBarRef = ref(null)
const liquidGlassInstances = new Map()

const lyricStore = useLyricStore()
const playerStore = usePlayerStore()
const settingsStore = useSettingsStore()
const downloadStore = useDownloadStore()
const userStore = useUserStore()
const playlistStore = usePlaylistStore()
const themeStore = useThemeStore()
const updateStore = useUpdateStore()
const localStore = useLocalStore()

// 自定义背景样式计算
const customBgLayerStyle = computed(() => {
  if (!themeStore.customBgEnabled || !themeStore.customBgUrl) return {}
  const posX = themeStore.customBgPosX ?? 50
  const posY = themeStore.customBgPosY ?? 50
  const fit = themeStore.customBgFit || 'cover'
  const scale = themeStore.customBgScale ?? 1
  const blur = themeStore.customBgBlur ?? 0
  const opacity = themeStore.customBgOpacity ?? 0.8

  const size = fit === 'custom' ? `${Math.round(scale * 100)}%` : fit
  const transform = fit === 'custom' ? 'none' : `scale(${scale})`

  return {
    backgroundImage: `url("${themeStore.customBgUrl}")`,
    backgroundPosition: `${posX}% ${posY}%`,
    backgroundSize: size,
    opacity: opacity,
    filter: blur > 0 ? `blur(${blur}px)` : 'none',
    transform: transform,
    transformOrigin: `${posX}% ${posY}%`
  }
})

const customBgMaskStyle = computed(() => {
  const maskOpacity = themeStore.customBgMaskOpacity ?? 0.3
  const isLight = themeStore.currentTheme === 'light'
  const r = isLight ? 250 : 10
  const g = isLight ? 250 : 10
  const b = isLight ? 255 : 20
  return {
    backgroundColor: `rgba(${r}, ${g}, ${b}, ${maskOpacity})`
  }
})

// Helper function to strip HTML tags
function stripHtmlTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

// Media Session 由 audioEngine.updateMediaSession 统一维护（避免 timeupdate 里高频刷新）
function syncDiscordRpc() {
  if (typeof window === 'undefined' || !window.electronAPI?.discord) return;
  const track = currentTrack.value;
  if (!track || !track.title) {
    try { window.electronAPI.discord.clearActivity(); } catch (_) {}
    return;
  }
  try {
    window.electronAPI.discord.updateActivity({
      title: track.title,
      artist: track.artist || track.author || '',
      duration: duration.value || track.duration || 0,
      currentTime: currentTime.value || 0,
      isPlaying: isPlaying.value,
      cover: track.cover || track.pic || ''
    });
  } catch (_) {}
}

function syncMediaSession() {
  updateMediaSession(currentTrack.value, isPlaying.value);
  syncDiscordRpc();
}

function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return

  // play / pause 各自实现：系统面板发的是绝对指令，共用一个 toggle 会与面板状态互相拉扯
  navigator.mediaSession.setActionHandler('play', () => {
    const el = getAudioEl()
    if (!el.paused) return
    Promise.resolve(playAudio()).then(() => {
      isPlaying.value = true
      playerStore.setIsPlaying(true)
      syncMediaSession()
    }).catch(() => {
      isPlaying.value = false
      playerStore.setIsPlaying(false)
      syncMediaSession()
    })
  })

  navigator.mediaSession.setActionHandler('pause', () => {
    const el = getAudioEl()
    if (el.paused) return
    pauseAudio()
    isPlaying.value = false
    playerStore.setIsPlaying(false)
    syncMediaSession()
  })

  navigator.mediaSession.setActionHandler('previoustrack', () => {
    playPrevious()
  })

  navigator.mediaSession.setActionHandler('nexttrack', () => {
    playNext()
  })

  // 系统面板拖动进度：部分平台不支持 seekto，注册与赋值都可能抛，整体兜住
  try {
    navigator.mediaSession.setActionHandler('seekto', (e) => {
      if (e?.seekTime == null) return
      try {
        seekAudio(e.seekTime)
        currentTime.value = e.seekTime
        playerStore.setCurrentTime(e.seekTime)
      } catch (_) {}
    })
  } catch (_) {}
}

// 主题由 themeStore 统一管理（MineView 设置 tab 提供切换入口），
// 启动时通过 themeStore.initTheme() 同步到 <html> 标签，详见 onMounted。

// 顶栏一键切换深色/浅色模式
function toggleThemeMode() {
  const next = themeStore.currentTheme === 'dark' ? 'light' : 'dark'
  themeStore.setTheme(next)
}
const currentView = computed({
  get: () => playlistStore.currentView,
  set: (val) => playlistStore.setCurrentView(val)
})
const searchQuery = ref('')
const isSearching = ref(false)
const searchResults = ref([])
const isLoadingSearch = ref(false)
const lastSearchQuery = ref('')
const recommendedMusic = ref([])
const isLoadingRecommended = ref(false)
const currentPlaylist = computed({
  get: () => playlistStore.currentPlaylist,
  set: (val) => playlistStore.setCurrentPlaylist(val)
})
const isLoadingFavResources = ref(false)
// 收藏夹分页拉取进度：{ current, total, loaded }
const favSyncProgress = ref({ current: 0, total: 0, loaded: 0 })
const currentTrack = ref(null)
// 大屏播放页封面模糊背景 URL（所有主题通用）：当前歌曲封面，走 fixCoverUrl + fallback
// 在音频可视化关闭时作为全屏毛玻璃背景展示
const coverBgUrl = computed(() => {
  const raw = fixCoverUrl(currentTrack.value?.cover)
  return raw || 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=1200'
})
const isPlaying = ref(false)
const currentTime = ref(0)
const duration = ref(0)
const isSeeking = ref(false)
function onSeekStart() { isSeeking.value = true }
function onSeekEnd() { isSeeking.value = false }
const isAudioLoading = ref(false)
const audioError = ref('')
const bufferedProgress = ref(0)
const showCreatePlaylistModal = ref(false)
const newPlaylistName = ref('')
// 重命名歌单弹窗状态
const showRenameModal = ref(false)
const renamePlaylistTarget = ref(null)
const renameValue = ref('')
const currentSeries = ref(null)
const showSeriesPanel = ref(false)
const downloadProgress = ref(0)
const isDownloading = ref(false)
let downloadMonitorInterval = null
const showPlaylistManager = ref(false)
const showAddToPlaylistModal = ref(false)

// 批量删除歌单：多选模式 + 已选 id 集合
const isBatchMode = ref(false)
const selectedPlaylistIds = ref(new Set())
const currentVideoEpisodes = ref([])
const isLoadingEpisodes = ref(false)
const currentEpisodeIndex = ref(0)
const albumArtRef = ref(null)
const showLyricPanel = ref(true)

// 批量管理歌单内歌曲：多选模式 + 已选 key 集合（key 同模板 :key）
const isTrackBatchMode = ref(false)
const selectedTrackKeys = ref(new Set())
const showBatchAddToPlaylistModal = ref(false)

// 主页/搜索页多分P视频添加：一体式弹窗（勾选分P + 选择目标歌单）
const showAddPModal = ref(false)
const pendingAddMusic = ref(null)
const pendingEpisodes = ref([])
const selectedPKeys = ref(new Set())
const isLoadingPList = ref(false)
// 单曲添加弹窗的目标 music（null 时回退到 currentTrack）
const addToPlaylistTarget = ref(null)
// 创建歌单成功后把分P加入新歌单（null=不加入；'all'=全部P；'selected'=已勾选P）
const createPlaylistForP = ref(null)

// 设置功能状态 - 已迁移到 MineView，不再需要
const showLoginPanel = ref(false)

// 点击播放栏封面打开大屏播放
function openPlayerPageFromCover() {
  playerStore.setShowPlayerPage(true)
}

function closePlayerPage() {
  playerStore.setShowPlayerPage(false)
}

const playMode = ref('order')
// 播放模式图标：用内联 SVG 替代 emoji。
// 顺序播放：双向水平箭头（左右反向）
// 列表循环：环形箭头（refresh）
// 随机播放：交叉箭头（shuffle）
// 单曲循环：左侧小圆点 + 右侧三条横线（repeat one 风格）
const playModes = [
  {
    value: 'order',
    label: '顺序播放',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="17 1 21 5 17 9"/><path d="M3 5h18"/><polyline points="7 23 3 19 7 15"/><path d="M21 19H3"/></svg>'
  },
  {
    value: 'loop',
    label: '列表循环',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>'
  },
  {
    value: 'shuffle',
    label: '随机播放',
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/><polyline points="21 16 21 21 16 21"/><line x1="15" y1="15" x2="21" y2="21"/><line x1="4" y1="4" x2="9" y2="9"/></svg>'
  },
  {
    value: 'single',
    label: '单曲循环',
    // 循环箭头中央放一个 "1"，表示"循环 1 次（单曲）"
    icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/><text x="12" y="15.5" text-anchor="middle" dominant-baseline="middle" fill="currentColor" stroke="none" font-size="8" font-weight="700" font-family="Arial, sans-serif">1</text></svg>'
  }
]

// 主题切换：旧 App.vue 里的 colorOptions / toggleTheme / setTheme / setColor
// 全部迁移到 MineView 设置 tab。这里只保留一个"跳到设置"的入口函数
// 用于顶栏按钮 / 全局快捷入口。
function openSettings() {
  // 1) 切到"我的"视图（MineView 在 currentView === 'mine' 时挂载）
  playlistStore.setCurrentView('mine')
  // 2) 派发全局事件，MineView 监听后把 activeTab 切到 'settings'
  window.dispatchEvent(new CustomEvent('pink-music:open-settings'))
}

function goToHome() {
  playlistStore.setCurrentView('home')
  loadRecommendedMusic()
}

function goToSearch() {
  playlistStore.setCurrentView('search')
}

async function loadFavResources() {
  if (!currentPlaylist.value || !userStore.isLoggedIn) return
  isLoadingFavResources.value = true
  favSyncProgress.value = { stage: '', current: 0, total: 0, loaded: 0 }
  try {
    const totalHint = Number(currentPlaylist.value.media_count) || 0
    const totalChunks = totalHint > 0 ? Math.ceil(totalHint / 20) : 1
    favSyncProgress.value = {
      stage: 'list',
      current: 0,
      total: totalChunks,
      loaded: 0
    }
    const result = await userStore.loadAllFavoriteResources(
      currentPlaylist.value,
      playlistStore,
      {
        onProgress: ({ stage, current, total, loaded }) => {
          favSyncProgress.value = { stage, current, total, loaded }
        }
      }
    )
    try { await playlistStore.savePlaylists() } catch (_) {}

    // 强制触发响应式刷新（新对象引用），使当前歌单视图与列表能即时渲染全部歌曲
    const freshPl = playlistStore.userPlaylists.find(p => p.id === currentPlaylist.value?.id)
    if (freshPl) {
      playlistStore.setCurrentPlaylist({ ...freshPl, music: [...(freshPl.music || [])] })
    }

    const added = typeof result === 'object' ? (result.added ?? 0) : Number(result) || 0
    const loaded = typeof result === 'object' ? (result.loaded ?? 0) : added
    const error = typeof result === 'object' ? (result.error || '') : (userStore._lastFavError || '')
    const totalNow = currentPlaylist.value?.music?.length || 0

    if (error && loaded === 0) {
      alert(`拉取收藏夹失败（${error}）。可尝试重新登录 B 站后再试。`)
    } else if (added > 0) {
      alert(`成功加载 ${added} 首新视频到本地歌单！当前歌单共 ${totalNow} 首。`)
    } else if (loaded > 0) {
      alert(`该收藏夹内容已是最新，共 ${totalNow} 首视频（本次无新增）。`)
    } else {
      alert('该收藏夹为空，暂无可加载的视频。')
    }
  } catch (error) {
    console.error('加载收藏夹内容失败:', error)
    try { await playlistStore.savePlaylists() } catch (_) {}
    alert('加载失败：' + (error?.message || '未知错误'))
  } finally {
    isLoadingFavResources.value = false
    favSyncProgress.value = { stage: '', current: 0, total: 0, loaded: 0 }
  }
}

function goToPlaylist(playlist) {
  playlistStore.setCurrentPlaylist(playlist)
  playlistStore.setCurrentView('playlist')
}

function backToPlaylistList() {
  playlistStore.setCurrentPlaylist(null)
}

/**
 * 一键播放整个歌单：从第一首开始。
 * 1) 切到歌单视图，让 handleTrackEnd 能正确取到 currentPlaylist.music 作为下一首来源
 * 2) 调用 playMusic(第一首)
 * 3) 歌单为空（B 站收藏夹还没加载到本地）则提示用户去加载
 */
async function playPlaylistAll(playlist) {
  if (!playlist) return
  const list = playlist.music || []
  if (list.length === 0) {
    if (playlist.isBiliFavorite) {
      alert('该收藏夹尚未加载到本地歌单，请先点击"加载视频"')
    } else {
      alert('该歌单还没有音乐')
    }
    return
  }
  // 先把视图/歌单指到要播放的这个，避免 handleTrackEnd 取错 musicList
  if (currentPlaylist.value?.id !== playlist.id) {
    playlistStore.setCurrentPlaylist(playlist)
  }
  if (currentView.value !== 'playlist') {
    playlistStore.setCurrentView('playlist')
  }
  await playMusic(list[0])
}

// ============= 本地音乐播放 =============
/**
 * 播放本地库中的一首歌。
 * 先把 currentPlaylist 指向「本地音乐」虚拟歌单，让 handleTrackEnd/上一首下一首
 * 能在本地库范围内续播（与歌单播放的语义一致）。
 */
async function playLocalTrack(track) {
  if (!track) return
  // 每次都用最新快照：virtualPlaylist 是 getter，tracks 变化后会返回新数组，不能按 id 复用旧引用
  playlistStore.setCurrentPlaylist(localStore.virtualPlaylist)
  await playMusic(track)
}

/**
 * 本地曲缺封面时按 歌名/歌手 自动匹配一次云端封面。
 * 与歌词的「播放即加载」同构；同一首失败后本次会话不再重试，避免反复打接口。
 */
const _coverTried = new Set()
function autoFetchLocalCover(track) {
  if (!track?.id || _coverTried.has(track.id)) return
  _coverTried.add(track.id)
  localStore.matchCoverFor(track).then((url) => {
    if (url) {
      // 当前正在播放的就是这首 → 同步刷新 UI 与 MediaSession 封面
      if (currentTrack.value && makeTrackKey(currentTrack.value) === makeTrackKey(track)) {
        // 匹配成功可能顺带把歌手改成封面来源的歌手名（见 localStore.matchCoverFor），播放条跟着换
        const fresh = localStore.tracks.find(t => t.id === track.id)
        currentTrack.value = { ...currentTrack.value, cover: url, author: fresh?.author || currentTrack.value.author }
        playerStore.setCurrentTrack(currentTrack.value)
        syncMediaSession()
      }
    }
  }).catch(() => {})
}

/** 播放整个本地库：优先用视图传入的当前可见顺序数组，缺省回退整库 */
async function playLocalAll(list) {
  const tracks = Array.isArray(list) && list.length > 0 ? list : (localStore.tracks || [])
  if (tracks.length === 0) {
    alert('本地音乐库还没有内容')
    return
  }
  await playLocalTrack(tracks[0])
}

/**
 * 从本地导入音频，并直接加入当前歌单。
 * 同时写入本地库（这样本地视图里也能看到、能做失效检测）。
 */
async function openLocalImportToPlaylist() {
  const pl = currentPlaylist.value
  const api = window.electronAPI?.local
  if (!pl || !api) return
  const res = await api.importFiles()
  if (res?.code !== 0 || !res.data?.length) {
    if (res?.code !== 0) alert(res?.message || '选择文件失败')
    return
  }
  try {
    const parsed = await api.parseMetadata(res.data)
    if (parsed?.code !== 0 || !Array.isArray(parsed.data)) {
      alert(parsed?.message || '解析音频失败')
      return
    }
    let tracks = parsed.data
    if (!settingsStore.localIncludeUnplayable) {
      tracks = tracks.filter(t => !t.isUnplayable)
    }
    await localStore.addTracks(tracks)
    let added = 0
    for (const t of tracks) {
      if (!pl.music.some(m => sameTrack(m, t))) {
        pl.music.push(pickTrackFields(t))
        added++
      }
    }
    syncPlaylistCover(pl)
    const idx = playlistStore.userPlaylists.findIndex(p => p.id === pl.id)
    if (idx >= 0) playlistStore.userPlaylists[idx] = { ...playlistStore.userPlaylists[idx], music: [...pl.music], cover: pl.cover }
    await playlistStore.savePlaylists()
    playlistStore.setCurrentPlaylist(playlistStore.userPlaylists.find(p => p.id === pl.id) || pl)
    alert(added > 0 ? `已添加 ${added} 首本地音乐到「${pl.name}」` : '所选音乐已全部存在于该歌单中')
  } catch (e) {
    alert('导入失败：' + (e?.message || e))
  }
}

/** 设置歌单自定义封面（coverMode='custom' 后不再被首曲封面覆盖） */
async function changePlaylistCover(pl) {
  if (!pl) return
  const api = window.electronAPI?.local
  if (!api) return alert('该功能仅在 Electron 环境中可用')
  const res = await api.saveCover()
  const url = res?.data?.url
  if (res?.code !== 0) return alert(res?.message || '设置封面失败')
  if (!url) return // 用户取消
  await playlistStore.setPlaylistCover(pl.id, url)
  const fresh = playlistStore.userPlaylists.find(p => p.id === pl.id)
  if (fresh && currentPlaylist.value?.id === pl.id) {
    playlistStore.setCurrentPlaylist(fresh)
  }
}

async function confirmDeletePlaylist(playlist) {
  if (!playlist) return
  if (playlist.isDefault) return
  const songCount = playlist.music?.length || playlist.media_count || 0
  // B 站同步的收藏夹删的是本地副本，B 站云端不受影响——文案上明确告知
  const detail = playlist.isBiliFavorite
    ? `该歌单包含 ${songCount} 首音乐，此操作不可恢复。\n（仅删除本地副本，不会影响 B 站云端）`
    : `该歌单包含 ${songCount} 首音乐，此操作不可恢复。`
  const ok = await appConfirm({
    title: '删除歌单',
    message: `确定要删除歌单「${playlist.name}」吗？`,
    detail,
    confirmText: '删除',
    cancelText: '取消'
  })
  if (!ok) return
  deletePlaylist(playlist)
}

// ============= 批量删除歌单 =============
function enterBatchMode() {
  isBatchMode.value = true
}

function exitBatchMode() {
  isBatchMode.value = false
  selectedPlaylistIds.value = new Set()
}

function togglePlaylistSelection(playlist) {
  if (!playlist || playlist.isDefault) return // 默认收藏夹不可选
  const next = new Set(selectedPlaylistIds.value)
  if (next.has(playlist.id)) {
    next.delete(playlist.id)
  } else {
    next.add(playlist.id)
  }
  selectedPlaylistIds.value = next
}

// 取得所有"可被批量选中的"歌单 id（默认收藏夹不算）
function getDeletablePlaylistIds() {
  return playlistStore.userPlaylists
    .filter(p => !p.isDefault)
    .map(p => p.id)
}

// 是否已经处于"全部可删除歌单都选中"的状态——用于决定全选按钮的图标 / 文案
const isAllDeletablePlaylistsSelected = computed(() => {
  const ids = getDeletablePlaylistIds()
  if (ids.length === 0) return false
  return ids.every(id => selectedPlaylistIds.value.has(id))
})

// "全选"按钮的真正逻辑：已全选 → 取消全选；否则全选可删除的歌单
// 这样用户不用退出批量模式就能反向操作
function toggleSelectAllPlaylists() {
  if (isAllDeletablePlaylistsSelected.value) {
    selectedPlaylistIds.value = new Set()
  } else {
    selectedPlaylistIds.value = new Set(getDeletablePlaylistIds())
  }
}

function isPlaylistSelected(playlist) {
  return !!playlist && selectedPlaylistIds.value.has(playlist.id)
}

// 当 store 里的歌单列表变化（单删、外部同步等）时，把已选集合中已不存在的 id 清掉，
// 防止"已选 N 个"和实际可操作数对不上
watch(
  () => playlistStore.userPlaylists.map(p => p.id),
  (currentIds) => {
    if (selectedPlaylistIds.value.size === 0) return
    const idSet = new Set(currentIds)
    const filtered = Array.from(selectedPlaylistIds.value).filter(id => idSet.has(id))
    if (filtered.length !== selectedPlaylistIds.value.size) {
      selectedPlaylistIds.value = new Set(filtered)
    }
  }
)

async function confirmBatchDeletePlaylists() {
  console.log('[BatchDelete] called, selected size =', selectedPlaylistIds.value.size)
  if (selectedPlaylistIds.value.size === 0) {
    console.log('[BatchDelete] selection empty, abort')
    return
  }
  const ids = Array.from(selectedPlaylistIds.value)
  console.log('[BatchDelete] selected ids =', ids)
  // 预先统计：哪些会被真删，哪些会被跳过
  const targets = playlistStore.userPlaylists.filter(p => ids.includes(p.id))
  console.log('[BatchDelete] matched playlists =', targets.map(t => ({ id: t.id, name: t.name, isDefault: t.isDefault })))
  const deletable = targets.filter(p => !p.isDefault)
  const skipped = targets.filter(p => p.isDefault)
  console.log('[BatchDelete] deletable =', deletable.length, 'skipped =', skipped.length)
  if (deletable.length === 0) {
    await appConfirm({
      title: '无法删除',
      message: '所选歌单均为默认收藏夹，不可删除。',
      detail: '默认收藏夹为系统内置歌单，需要保留以便日常使用。',
      confirmText: '我知道了',
      cancelText: '关闭'
    })
    return
  }
  const totalSongs = deletable.reduce(
    (sum, p) => sum + (p.music?.length || p.media_count || 0),
    0
  )
  const hasBili = deletable.some(p => p.isBiliFavorite)
  const detail =
    (hasBili
      ? `共 ${deletable.length} 个歌单、约 ${totalSongs} 首音乐将被删除。\n（其中 B 站收藏夹仅删除本地副本，不影响 B 站云端）`
      : `共 ${deletable.length} 个歌单、约 ${totalSongs} 首音乐将被删除，此操作不可恢复。`) +
    (skipped.length > 0 ? `\n另有 ${skipped.length} 个默认收藏夹将被自动跳过。` : '')
  const ok = await appConfirm({
    title: '批量删除歌单',
    message: `确定要删除已选中的 ${deletable.length} 个歌单吗？`,
    detail,
    confirmText: '批量删除',
    cancelText: '取消'
  })
  console.log('[BatchDelete] user confirmed =', ok)
  if (!ok) return
  try {
    // 直接在 App.vue 里操作 store state，避开 Pinia action HMR 不热更的问题
    // 逻辑与 store.batchDeletePlaylists 一致：默认歌单跳过，其余删除
    const idSet = new Set(ids)
    const deletedIds = []
    let skipped = 0
    playlistStore.userPlaylists = playlistStore.userPlaylists.filter(p => {
      if (!idSet.has(p.id)) return true
      if (p.isDefault) { skipped++; return true }
      deletedIds.push(p.id)
      return false
    })
    if (deletedIds.length > 0) {
      try { await playlistStore.savePlaylists() } catch (e) {
        console.warn('[batchDelete] save failed:', e.message)
      }
    }
    const result = { deleted: deletedIds.length, skipped, deletedIds }
    console.log('[BatchDelete] result =', result, 'userPlaylists now =', playlistStore.userPlaylists.map(p => p.id))
    // 如果当前正在查看的歌单被删了，跳回列表
    if (
      currentPlaylist.value &&
      result.deletedIds.includes(currentPlaylist.value.id)
    ) {
      playlistStore.setCurrentPlaylist(null)
    }
    // 退出批量模式
    exitBatchMode()
    if (result.deleted === 0 && result.skipped > 0) {
      alert('所选歌单均为默认收藏夹，已跳过。')
    } else if (result.deleted > 0) {
      console.log(`[BatchDelete] ✅ 成功删除 ${result.deleted} 个歌单`)
    }
  } catch (err) {
    console.error('[BatchDelete] ❌ 删除出错:', err)
    alert('批量删除失败：' + (err?.message || err))
  }
}

function loadFavResourcesFor(playlist) {
  playlistStore.setCurrentPlaylist(playlist)
  playlistStore.setCurrentView('playlist')
  loadFavResources()
}

// ============= 歌单内歌曲：单首删除 / 批量删除 =============

/**
 * 与模板里的 :key 保持一致：bvid:favId:favType。
 * **永远在末尾追加 index** 作为唯一性兜底——这是修复 BUG 的关键：
 * 当多条音乐恰好有相同的 bvid + favId + favType（例如同 bvid 重复条目、
 * 收藏夹内多 P 但 id 缺失等情况），如果只用前三个字段拼 key，所有歌会
 * 生成同一个 key，导致：
 *   1. 点击一首时，集合里只有 1 个 key，但所有歌的 key 都命中 → 视觉"全选"
 *   2. 点"全选"时，set 已有该 key，set 大小仍为 1 → 计数器显示 1/n
 * 把 index 拼到 key 末尾能确保每个位置都有独立 key，彻底规避这种碰撞。
 */
function getTrackKey(music, index) {
  if (!music) return ''
  // 本地曲：稳定 id；B 站曲：bvid + favId + favType
  const base = isLocalTrack(music)
    ? makeTrackKey(music)
    : (music.bvid || '') + ':' + (music.favId ?? '') + ':' + (music.favType ?? '')
  return base + ':' + index
}

function enterTrackBatchMode() {
  isTrackBatchMode.value = true
}

function exitTrackBatchMode() {
  isTrackBatchMode.value = false
  selectedTrackKeys.value = new Set()
}

function toggleTrackSelection(music, index) {
  if (!music) return
  const key = getTrackKey(music, index)
  if (!key) return
  const next = new Set(selectedTrackKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedTrackKeys.value = next
}

function isTrackSelected(music, index) {
  if (!music) return false
  return selectedTrackKeys.value.has(getTrackKey(music, index))
}

function selectAllTracks() {
  const list = currentPlaylist.value?.music || []
  const next = new Set()
  list.forEach((m, i) => {
    const k = getTrackKey(m, i)
    if (k) next.add(k)
  })
  selectedTrackKeys.value = next
}

function isAllTracksSelected() {
  const list = currentPlaylist.value?.music || []
  if (list.length === 0) return false
  return list.every((m, i) => selectedTrackKeys.value.has(getTrackKey(m, i)))
}

/**
 * 单首删除：从当前歌单里删除一首歌。
 * - B 站收藏夹：只删本地副本，云端不受影响
 * - 默认收藏夹（"收藏夹"）：允许删除单首
 */
async function confirmDeleteTrack(music) {
  if (!music || !currentPlaylist.value) return
  const pl = currentPlaylist.value
  const ok = await appConfirm({
    title: '删除歌曲',
    message: `确定要从歌单「${pl.name}」中删除「${music.title || '该歌曲'}」吗？`,
    detail: pl.isBiliFavorite
      ? '仅删除本地副本，不会影响 B 站云端。'
      : '此操作不可恢复。',
    confirmText: '删除',
    cancelText: '取消'
  })
  if (!ok) return
  const list = pl.music || []
  const idx = list.findIndex(m => sameTrack(m, music))
  if (idx < 0) return
  list.splice(idx, 1)
  const pIdx = playlistStore.userPlaylists.findIndex(p => p.id === pl.id)
  if (pIdx >= 0) {
    playlistStore.userPlaylists[pIdx] = {
      ...playlistStore.userPlaylists[pIdx],
      music: [...list]
    }
    syncPlaylistCover(playlistStore.userPlaylists[pIdx])
    try { await playlistStore.savePlaylists() } catch (e) {
      console.warn('[deleteTrack] save failed:', e.message)
    }
    // 刷新 currentPlaylist 引用，触发视图更新
    playlistStore.setCurrentPlaylist(playlistStore.userPlaylists[pIdx])
  }
}

/**
 * 批量删除歌曲：
 * - 逻辑直接在 UI 组件里执行，避开 Pinia store action HMR 不热更的坑
 * - 删除前弹窗确认，B 站收藏夹附文案说明
 * - 删除后自动退出批量模式
 */
async function confirmBatchDeleteTracks() {
  console.log('[BatchDeleteTrack] called, selected size =', selectedTrackKeys.value.size)
  if (selectedTrackKeys.value.size === 0) return
  const pl = currentPlaylist.value
  if (!pl || !pl.music || pl.music.length === 0) return
  const keys = new Set(selectedTrackKeys.value)
  const matched = pl.music.filter((m, i) => keys.has(getTrackKey(m, i)))
  console.log('[BatchDeleteTrack] matched =', matched.length)
  if (matched.length === 0) {
    await appConfirm({
      title: '无匹配歌曲',
      message: '所选歌曲均已不在歌单中',
      detail: '歌曲可能已被其他操作删除',
      confirmText: '我知道了',
      cancelText: '关闭'
    })
    exitTrackBatchMode()
    return
  }
  const detail = pl.isBiliFavorite
    ? `共 ${matched.length} 首音乐将被删除。\n（仅删除本地副本，不会影响 B 站云端）`
    : `共 ${matched.length} 首音乐将被删除，此操作不可恢复。`
  const ok = await appConfirm({
    title: '批量删除歌曲',
    message: `确定要从歌单「${pl.name}」中删除已选中的 ${matched.length} 首歌曲吗？`,
    detail,
    confirmText: '批量删除',
    cancelText: '取消'
  })
  if (!ok) return
  try {
    const newList = pl.music.filter((m, i) => !keys.has(getTrackKey(m, i)))
    const deletedCount = pl.music.length - newList.length
    const pIdx = playlistStore.userPlaylists.findIndex(p => p.id === pl.id)
    if (pIdx >= 0) {
      playlistStore.userPlaylists[pIdx] = {
        ...playlistStore.userPlaylists[pIdx],
        music: newList
      }
      syncPlaylistCover(playlistStore.userPlaylists[pIdx])
      try { await playlistStore.savePlaylists() } catch (e) {
        console.warn('[batchDeleteTracks] save failed:', e.message)
      }
      // 刷新 currentPlaylist 引用
      playlistStore.setCurrentPlaylist(playlistStore.userPlaylists[pIdx])
    }
    console.log(`[BatchDeleteTrack] ✅ 删除 ${deletedCount} 首，剩余 ${newList.length} 首`)
    exitTrackBatchMode()
  } catch (err) {
    console.error('[BatchDeleteTrack] ❌', err)
    alert('批量删除失败：' + (err?.message || err))
  }
}

// 切歌单时自动清理批量模式
watch(currentPlaylist, () => {
  if (isTrackBatchMode.value) {
    exitTrackBatchMode()
  }
})

/**
 * 批量添加到其它歌单：
 * - 打开"添加到歌单"弹窗，歌单列表排除当前歌单自身
 * - 添加成功后保留批量模式与勾选，可连续添加到多个歌单
 */
function openBatchAddToPlaylist() {
  if (selectedTrackKeys.value.size === 0) return
  const pl = currentPlaylist.value
  if (!pl || !pl.music || pl.music.length === 0) return
  showBatchAddToPlaylistModal.value = true
}

function isCurrentPlaylist(playlist) {
  return playlist && currentPlaylist.value && playlist.id === currentPlaylist.value.id
}

/**
 * 批量把歌曲写入目标歌单（共享逻辑）：
 * - 去重规则：bvid 必须匹配；cid 同时存在时才要求一致（与 store addToPlaylist 一致）
 * - 通过 userPlaylists 整体替换数组引用触发响应式，然后持久化
 * - 逻辑直接在 UI 组件里执行，避开 Pinia store action HMR 不热更的坑
 * @param {Array} tracks 要添加的歌曲数组（会浅拷贝）
 * @param {object} playlist 目标歌单
 * @returns {Promise<{added: number, skipped: number}>}
 */
async function pushTracksToPlaylist(tracks, playlist) {
  const list = Array.isArray(tracks) ? tracks : []
  if (list.length === 0 || !playlist) return { added: 0, skipped: 0 }
  const targetMusic = Array.isArray(playlist.music) ? [...playlist.music] : []
  const existingKeys = new Set(targetMusic.map(m => (m.bvid ?? '') + (m.cid ?? '')))
  let addedCount = 0
  for (const music of list) {
    // 防御：只接受真正的歌曲对象，事件对象等杂散数据一律跳过
    if (!isTrackLike(music)) {
      console.warn('[pushTracksToPlaylist] 跳过非歌曲对象（疑似事件对象）:', typeof music, music && Object.keys(music).slice(0, 5))
      continue
    }
    // cid 为空时只用 bvid 判重；两者都有 cid 时联合判重
    const k = (music.bvid ?? '') + (music.cid ?? '')
    if (!existingKeys.has(k)) {
      existingKeys.add(k)
      // 规范化：只保留歌曲字段 + 标题/作者/封面兜底（不再整体展开 music，
      // 防止事件对象上的 isTrusted/_vts 等杂散键被持久化）
      targetMusic.push(pickTrackFields(music))
      addedCount++
    }
  }
  const skippedCount = list.length - addedCount
  if (addedCount > 0) {
    const pIdx = playlistStore.userPlaylists.findIndex(p => p.id === playlist.id)
    if (pIdx >= 0) {
      playlistStore.userPlaylists[pIdx] = {
        ...playlistStore.userPlaylists[pIdx],
        music: targetMusic
      }
      syncPlaylistCover(playlistStore.userPlaylists[pIdx])
      try {
        await playlistStore.savePlaylists()
      } catch (e) {
        console.warn('[pushTracksToPlaylist] save failed:', e.message)
      }
      console.log(`[pushTracksToPlaylist] ✅ 添加到「${playlist.name}」 ${addedCount} 首，跳过重复 ${skippedCount} 首`)
    } else {
      return { added: 0, skipped: skippedCount }
    }
  } else {
    console.log(`[pushTracksToPlaylist] 所选歌曲已全部存在于「${playlist.name}」，无新增`)
  }
  return { added: addedCount, skipped: skippedCount }
}

/**
 * 批量添加到目标歌单：
 * - 保留批量模式与勾选，用户可继续添加到其它歌单
 */
async function batchAddToPlaylist(playlist) {
  const pl = currentPlaylist.value
  if (!pl || !playlist || playlist.id === pl.id) return
  const keys = new Set(selectedTrackKeys.value)
  const matched = pl.music.filter((m, i) => keys.has(getTrackKey(m, i)))
  if (matched.length === 0) {
    showBatchAddToPlaylistModal.value = false
    return
  }
  await pushTracksToPlaylist(matched, playlist)
  showBatchAddToPlaylistModal.value = false
}

/**
 * 构造分P对应的 music 对象：继承整稿信息，写入 cid / part 标题 / 分P时长 / 分P封面
 */
function buildEpisodeMusic(episode, source) {
  if (!episode || !source) return null
  return {
    ...source,
    cid: episode.cid,
    title: episode.part || source.title,
    duration: episode.duration || source.duration,
    cover: fixCoverUrl(episode.first_frame) || source.cover
  }
}

/**
 * 主页/搜索页卡片"+"入口：
 * - 单P视频或接口失败 → 走单曲添加到歌单弹窗
 * - 多P视频 → 打开一体式分P选择弹窗
 */
async function openAddPSelect(music) {
  // 防御：非歌曲对象（如事件对象）不进入分P/添加流程
  if (!isTrackLike(music)) return
  if (!music || !music.bvid) return
  isLoadingPList.value = true
  try {
    let episodes = []
    if (window.electronAPI) {
      const res = await window.electronAPI.getVideoEpisodes(music.bvid)
      if (res.code === 0 && Array.isArray(res.data) && res.data.length > 1) {
        episodes = res.data
      }
    }
    if (episodes.length <= 1) {
      openAddToPlaylistModal(music)
      return
    }
    pendingAddMusic.value = music
    pendingEpisodes.value = episodes
    selectedPKeys.value = new Set()
    showAddPModal.value = true
  } catch (e) {
    console.warn('[openAddPSelect] 获取分P列表失败:', e.message)
    openAddToPlaylistModal(music)
  } finally {
    isLoadingPList.value = false
  }
}

function togglePSelection(cid) {
  const next = new Set(selectedPKeys.value)
  if (next.has(cid)) next.delete(cid)
  else next.add(cid)
  selectedPKeys.value = next
}

function selectAllPs() {
  const next = new Set()
  pendingEpisodes.value.forEach(e => next.add(e.cid))
  selectedPKeys.value = next
}

function isAllPsSelected() {
  const list = pendingEpisodes.value
  if (list.length === 0) return false
  return list.every(e => selectedPKeys.value.has(e.cid))
}

/**
 * 把已勾选的分P加入目标歌单
 */
async function addSelectedPsToPlaylist(playlist) {
  const source = pendingAddMusic.value
  const list = pendingEpisodes.value
  if (!source || !playlist || list.length === 0) return
  const keys = new Set(selectedPKeys.value)
  const tracks = list
    .filter(e => keys.has(e.cid))
    .map(e => buildEpisodeMusic(e, source))
    .filter(Boolean)
  if (tracks.length === 0) return
  await pushTracksToPlaylist(tracks, playlist)
  showAddPModal.value = false
}

/**
 * 打开创建歌单弹窗，确认后把分P加入新歌单
 * @param {'all'|'selected'} mode 全部P 或 已勾选P
 */
function createPlaylistWithPs(mode) {
  if (!pendingAddMusic.value) return
  createPlaylistForP.value = mode
  newPlaylistName.value = pendingAddMusic.value.title || ''
  showCreatePlaylistModal.value = true
}

async function loadRecommendedMusic() {
  isLoadingRecommended.value = true
  
  try {
    // 使用随机关键词搜索作为推荐
    const randomKeywords = ['热门音乐', '流行歌曲', '经典老歌', '电音', '摇滚', '民谣', '说唱', '古风', '轻音乐', '影视原声']
    const randomKeyword = randomKeywords[Math.floor(Math.random() * randomKeywords.length)]
    
    // 完全通过 electronAPI 调用主进程
    let searchResult
    if (window.electronAPI) {
      console.log('开始搜索:', randomKeyword)
      searchResult = await window.electronAPI.searchMusic(randomKeyword, 1, 20)
      console.log('搜索结果:', searchResult)
    } else {
      // 为了 Web 环境的降级方案（如果有）
      searchResult = { code: -1, message: 'Not available in web mode' }
    }
    
    // 解析搜索结果
    if (searchResult.code === 0 && searchResult.data?.result) {
      // 找到 video 类型的结果
      const videoResult = searchResult.data.result.find(item => item.result_type === 'video');
      if (videoResult && videoResult.data?.length > 0) {
        // 转换搜索结果为音乐格式
        const musicList = videoResult.data.map((item, index) => ({
          bvid: item.bvid,
          aid: item.aid,
          title: stripHtmlTags(item.title),
          author: stripHtmlTags(item.author),
          cover: fixCoverUrl(item.pic),
          duration: typeof item.duration === 'string' ? parseDuration(item.duration) : item.duration || 180,
          playCount: item.play || 0,
          pubdate: item.pubdate
        }))
        
        // 过滤掉标题包含敏感词的歌曲
        const filteredMusic = musicList.filter(music => !music.title.includes('吻'))
        
        // 随机打乱结果
        const shuffledMusic = [...filteredMusic].sort(() => 0.5 - Math.random())
        recommendedMusic.value = shuffledMusic
      } else {
        recommendedMusic.value = []
      }
    } else {
      recommendedMusic.value = []
    }
  } catch (error) {
    console.error('加载推荐音乐失败:', error)
    recommendedMusic.value = []
  } finally {
    isLoadingRecommended.value = false
  }
}

async function handleSearch() {
  if (!searchQuery.value.trim()) return
  // 防重复提交：相同关键词在搜索中不重复触发
  if (isSearching.value && searchQuery.value === lastSearchQuery.value) return
  lastSearchQuery.value = searchQuery.value
  isSearching.value = true
  isLoadingSearch.value = true
  currentView.value = 'search'
  try {
    // 完全通过 electronAPI 调用
    let searchResult
    if (window.electronAPI) {
      console.log('开始搜索:', searchQuery.value)
      searchResult = await window.electronAPI.searchMusic(searchQuery.value, 1, 30)
      console.log('搜索结果:', searchResult)
    } else {
      searchResult = { code: -1, message: 'Not available' }
    }
    
    // 解析搜索结果
    if (searchResult.code === 0 && searchResult.data?.result) {
      // 找到 video 类型的结果
      const videoResult = searchResult.data.result.find(item => item.result_type === 'video');
      if (videoResult && videoResult.data?.length > 0) {
        // 转换搜索结果为音乐格式
        searchResults.value = videoResult.data.map((item, index) => ({
          bvid: item.bvid,
          aid: item.aid,
          title: stripHtmlTags(item.title),
          author: stripHtmlTags(item.author),
          cover: fixCoverUrl(item.pic),
          duration: typeof item.duration === 'string' ? parseDuration(item.duration) : item.duration || 180,
          playCount: item.play || 0,
          pubdate: item.pubdate,
          videos: item.videos || 0
        }))
      } else {
        searchResults.value = []
      }
    } else {
      searchResults.value = []
    }
  } catch (error) {
    console.error('搜索音乐失败:', error)
    searchResults.value = []
  } finally {
    isLoadingSearch.value = false
    lastSearchQuery.value = ''
  }
}

function getRandomIndex(max) {
  return Math.floor(Math.random() * max)
}

/** 续播列表来源：歌单/本地视图用当前歌单，搜索页用搜索结果，其余用推荐列表 */
function getPlaybackList() {
  const view = currentView.value
  if (view === 'playlist' || view === 'local') return currentPlaylist.value?.music || []
  if (view === 'search') return searchResults.value || []
  return recommendedMusic.value || []
}

function getNextMusicIndex() {
  const musicList = getPlaybackList()

  if (!musicList || musicList.length === 0) return -1

  // 统一身份定位（本地曲走 id，B 站曲走 bvid+cid）
  const curKey = makeTrackKey(currentTrack.value)
  let currentIndex = musicList.findIndex(m => makeTrackKey(m) === curKey)
  // 多P时当前曲是某一分P（cid 与列表项不同），先按 sameTrack 回退定位同一视频
  if (currentIndex < 0) currentIndex = musicList.findIndex(m => sameTrack(m, currentTrack.value))
  // sameTrack 在两边 cid 都非空时会比 cid，而分P 的 cid 与歌单项不同，故多P定位再退到只比 bvid
  if (currentIndex < 0) {
    const curBvid = currentTrack.value?.bvid
    if (curBvid) currentIndex = musicList.findIndex(m => m?.bvid && m.bvid === curBvid)
  }

  switch (playMode.value) {
    case 'single':
      return currentIndex >= 0 ? currentIndex : 0
    case 'shuffle':
      let nextIndex
      do {
        nextIndex = getRandomIndex(musicList.length)
      } while (musicList.length > 1 && nextIndex === currentIndex)
      return nextIndex
    case 'loop':
      return currentIndex >= 0 ? (currentIndex + 1) % musicList.length : 0
    case 'order':
    default:
      if (currentIndex >= 0 && currentIndex < musicList.length - 1) {
        return currentIndex + 1
      }
      return -1
  }
}

// 切歌竞态守卫：每次 playMusic 领一个序号，只有最新序号的异步结果允许落地
let playSeq = 0

async function playMusic(music) {
  const mySeq = ++playSeq
  logger.log('开始播放:', music?.title)
  const local = isLocalTrack(music)
  // 本地曲没有 bvid/favId，但可正常播放；仅拦截真正的无效对象
  if (!local && !music?.bvid && !music?.favId) {
    audioError.value = '该收藏内容暂不支持播放'
    playerStore.setAudioError(audioError.value)
    isAudioLoading.value = false
    playerStore.setIsAudioLoading(false)
    return
  }
  // 本地曲：文件失效 / 需转码格式直接给出明确提示，避免播放器静默失败
  if (local) {
    if (music.isMissing) {
      audioError.value = '本地文件已移动或删除，请重新定位'
      playerStore.setAudioError(audioError.value)
      isAudioLoading.value = false
      playerStore.setIsAudioLoading(false)
      return
    }
    if (music.isUnplayable) {
      audioError.value = '该格式暂不支持直接播放（需转码）'
      playerStore.setAudioError(audioError.value)
      isAudioLoading.value = false
      playerStore.setIsAudioLoading(false)
      return
    }
  }

  currentTrack.value = music
  playerStore.setCurrentTrack(music)
  lyricStore.loadLyricForTrack(music).catch(e => logger.warn('[playMusic] 歌词加载失败:', e?.message))
  playerStore.setIsPlaying(false)
  playerStore.setIsAudioLoading(true)
  playerStore.setAudioError('')
  playerStore.setDuration(music.duration || 180)
  playerStore.setCurrentTime(0)
  playerStore.setBufferedProgress(0)
  isPlaying.value = false
  isAudioLoading.value = true
  audioError.value = ''
  duration.value = music.duration || 180
  currentTime.value = 0
  bufferedProgress.value = 0
  currentVideoEpisodes.value = []
  currentEpisodeIndex.value = 0

  // 分P/合集仅 B 站曲需要；本地曲跳过（无 bvid）
  if (!local) {
    loadVideoSeries(music.bvid)
  } else if (!music.cover) {
    // 本地曲无封面：与歌词「播放时自动加载」同构，按歌名/歌手匹配一次云端封面
    autoFetchLocalCover(music)
  }
  syncMediaSession()

  try {
    const result = await playWithResolvedSrc(music, settingsStore.audioQuality, {
      forceReload: true,
      shouldAbort: () => mySeq !== playSeq
    })
    // 已被更新的切歌请求取代（引擎判过期，或 el.play() 期间又切了歌）：不回写状态也不预取
    if (result?.aborted || mySeq !== playSeq) return
    logger.log('使用音频地址:', result?.src)
    isPlaying.value = true
    playerStore.setIsPlaying(true)
    syncMediaSession()
    const nextMusic = peekNextTrack()
    if (nextMusic) prefetchTrack(nextMusic, settingsStore.audioQuality)
  } catch (error) {
    // 旧请求的失败不能覆盖新曲状态
    if (mySeq !== playSeq) return
    logger.error('播放失败:', error)
    // 英文 DOMException 直接抛给用户没有意义，只有中文原因才透出
    const reason = error?.message && /[一-龥]/.test(error.message) ? error.message : '音频加载失败'
    audioError.value = reason
    playerStore.setAudioError(reason)
    isAudioLoading.value = false
    playerStore.setIsAudioLoading(false)
    isPlaying.value = false
    playerStore.setIsPlaying(false)
  }
}

/** 只计算下一首，不触发播放（供预取用） */
function peekNextTrack() {
  if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
    const episode = currentVideoEpisodes.value[getNextEpisodeIndex()]
    if (episode) return episode
  }
  const nextIndex = getNextMusicIndex()
  const list = getPlaybackList()
  if (nextIndex >= 0 && list?.[nextIndex]) return list[nextIndex]
  return null
}

function updateBufferedProgress() {
  const el = getAudioEl()
  bufferedProgress.value = computeBufferedPercent(el)
}

async function loadVideoSeries(bvid) {
  try {
    // 获取视频详细信息，包含合集信息
    const result = await window.electronAPI.getMusicInfo(bvid)
    // 结果回来时当前曲已换成别的视频：整份丢弃，避免分P列表串台
    if (currentTrack.value?.bvid !== bvid) return
    if (result.code === 0 && result.data.pages && result.data.pages.length > 1) {
      const episodes = result.data.pages.map((page, index) => ({
        bvid: bvid,
        cid: page.cid,
        title: page.part,
        duration: page.duration,
        cover: fixCoverUrl(page.first_frame)
      }))
      // 构建合集信息
      currentSeries.value = {
        id: bvid,
        title: result.data.title,
        cover: fixCoverUrl(result.data.pic),
        episodes
      }
      // 同步填充分 P 列表，让 handleTrackEnd 能直接在分 P 内循环，
      // 不再依赖用户先打开一次"分P列表"面板
      currentVideoEpisodes.value = episodes.map(e => ({
        bvid: e.bvid,
        cid: e.cid,
        part: e.title,
        duration: e.duration
      }))
      // 定位当前 cid 在分 P 中的位置
      const currentCid = currentTrack.value?.cid
      const idx = currentCid
        ? currentVideoEpisodes.value.findIndex(e => e.cid === currentCid)
        : 0
      currentEpisodeIndex.value = idx >= 0 ? idx : 0
      showSeriesPanel.value = true
      console.log('加载视频合集成功:', result.data.title, '共', result.data.pages.length, '集')
    } else {
      currentSeries.value = null
      currentVideoEpisodes.value = []
      currentEpisodeIndex.value = 0
      showSeriesPanel.value = false
    }
  } catch (error) {
    if (currentTrack.value?.bvid !== bvid) return
    console.error('加载视频合集失败:', error)
    currentSeries.value = null
    currentVideoEpisodes.value = []
    currentEpisodeIndex.value = 0
    showSeriesPanel.value = false
  }
}

function playFromSeries(episode) {
  if (!episode) return
  // 先定位这一集，避免合集接口返回前按第 1 集推进
  const index = currentVideoEpisodes.value.findIndex(e => e.cid === episode.cid)
  if (index >= 0) currentEpisodeIndex.value = index
  playMusic({
    bvid: episode.bvid,
    cid: episode.cid,
    title: episode.title,
    author: episode.author || currentTrack.value?.author || '未知作者',
    cover: episode.cover || currentTrack.value?.cover,
    duration: episode.duration || 180
  })
}

function toggleSeriesPanel() {
  showSeriesPanel.value = !showSeriesPanel.value
}

async function togglePlaylistManager() {
  if (!currentTrack.value) {
    showPlaylistManager.value = false
    return
  }
  
  showPlaylistManager.value = !showPlaylistManager.value
  
  // If opening, load episodes for current track
  if (showPlaylistManager.value) {
    isLoadingEpisodes.value = true
    try {
      const response = await window.electronAPI.getVideoEpisodes(currentTrack.value.bvid)
      if (response.code === 0 && response.data) {
        currentVideoEpisodes.value = response.data
        // Find current episode index
        if (currentTrack.value.cid) {
          const currentIndex = currentVideoEpisodes.value.findIndex(episode => episode.cid === currentTrack.value.cid)
          currentEpisodeIndex.value = currentIndex >= 0 ? currentIndex : 0
        } else {
          currentEpisodeIndex.value = 0
        }
      } else {
        currentVideoEpisodes.value = []
        currentEpisodeIndex.value = 0
      }
    } catch (error) {
      console.error('获取分P列表失败:', error)
      currentVideoEpisodes.value = []
      currentEpisodeIndex.value = 0
    } finally {
      isLoadingEpisodes.value = false
    }
  }
}

async function playEpisode(episode) {
  if (!currentTrack.value) return
  
  try {
    // Find the episode index
    const episodeIndex = currentVideoEpisodes.value.findIndex(e => e.cid === episode.cid)
    if (episodeIndex >= 0) {
      currentEpisodeIndex.value = episodeIndex
    }
    
    // Create a new track object with the episode's cid
    const episodeTrack = {
      ...currentTrack.value,
      cid: episode.cid,
      title: episode.part || currentTrack.value.title,
      duration: episode.duration || currentTrack.value.duration
    }
    
    // Update current track
    currentTrack.value = episodeTrack
    playerStore.setCurrentTrack(episodeTrack)

    // Load and play the episode
    await playMusic(episodeTrack)
    
    // Close the playlist manager
    showPlaylistManager.value = false
  } catch (error) {
    console.error('播放分P失败:', error)
  }
}

function startDownloadProgressMonitor(bvid) {
  // 清除之前的监控
  if (downloadMonitorInterval) {
    clearInterval(downloadMonitorInterval)
  }

  isDownloading.value = false
  downloadProgress.value = 0

  // 新的API系统暂时不支持下载进度监控
  console.log('下载进度监控已禁用')
}

function stopDownloadProgressMonitor() {
  if (downloadMonitorInterval) {
    clearInterval(downloadMonitorInterval)
    downloadMonitorInterval = null
  }
  isDownloading.value = false
  downloadProgress.value = 0
}

/**
 * 下一个分P 的下标；返回 -1 表示已到末P（不回绕，交回外层列表续播）。
 * single 重播当前P，shuffle 随机其它P，order/loop 顺序取下一P。
 */
function getNextEpisodeIndex() {
  const total = currentVideoEpisodes.value.length
  if (total === 0) return -1
  if (playMode.value === 'single') return currentEpisodeIndex.value
  if (playMode.value === 'shuffle') {
    let index
    do {
      index = getRandomIndex(total)
    } while (total > 1 && index === currentEpisodeIndex.value)
    return index
  }
  const next = currentEpisodeIndex.value + 1
  return next < total ? next : -1
}

/**
 * 用户点「下一首」时的分P 下标：忽略 single（single 下点下一首不该变成重播当前集）。
 * shuffle 随机其它P，order/loop/single 顺序取下一P，已是末P 返回 -1。
 */
function getExplicitNextEpisodeIndex() {
  const total = currentVideoEpisodes.value.length
  if (total === 0) return -1
  if (playMode.value === 'shuffle') {
    let index
    do {
      index = getRandomIndex(total)
    } while (total > 1 && index === currentEpisodeIndex.value)
    return index
  }
  const next = currentEpisodeIndex.value + 1
  return next < total ? next : -1
}

function handleTrackEnd() {
  // 多P：末P 不回绕，落到下面按外层列表的同一播放模式续播
  if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
    const nextEpisode = currentVideoEpisodes.value[getNextEpisodeIndex()]
    if (nextEpisode) {
      playEpisode(nextEpisode)
      return
    }
  }
  // Normal song navigation
  const musicList = getPlaybackList()
  const nextIndex = getNextMusicIndex()
  if (nextIndex >= 0 && musicList[nextIndex]) {
    playMusic(musicList[nextIndex])
  } else {
    isPlaying.value = false
    playerStore.setIsPlaying(false)
  }
}

function togglePlayMode() {
  const modes = ['order', 'loop', 'single', 'shuffle']
  const currentIndex = modes.indexOf(playMode.value)
  playMode.value = modes[(currentIndex + 1) % modes.length]
  // 同步到 store：播放栏 / 引擎预取与 useAudioPlayer 读同一份模式
  try { playerStore.playMode = playMode.value } catch (_) {}
}

watch(playMode, (v) => {
  try { if (playerStore.playMode !== v) playerStore.playMode = v } catch (_) {}
})
watch(() => playerStore.playMode, (v) => {
  if (v && playMode.value !== v) playMode.value = v
})
function getPlayModeIcon() {
  const mode = playModes.find(m => m.value === playMode.value)
  return mode ? mode.icon : playModes[0].icon
}

function getPlayModeLabel() {
  const mode = playModes.find(m => m.value === playMode.value)
  return mode ? mode.label : '顺序播放'
}

function togglePlayPause() {
  const el = getAudioEl()
  if (!el.src && !currentTrack.value) return

  if (isPlaying.value) {
    pauseAudio()
    isPlaying.value = false
    playerStore.setIsPlaying(false)
    syncMediaSession()
  } else {
    Promise.resolve(playAudio()).then(() => {
      isPlaying.value = true
      playerStore.setIsPlaying(true)
      // 恢复播放后补一次同步，避免系统面板仍停在「暂停」
      syncMediaSession()
    }).catch(() => {
      isPlaying.value = false
      playerStore.setIsPlaying(false)
    })
  }
}

function playPrevious() {
  // Check if current track has episodes
  if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
    let prevEpisodeIndex
    
    if (playMode.value === 'shuffle') {
      // Random episode
      do {
        prevEpisodeIndex = getRandomIndex(currentVideoEpisodes.value.length)
      } while (currentVideoEpisodes.value.length > 1 && prevEpisodeIndex === currentEpisodeIndex.value)
    } else {
      // Previous episode, wrap around
      prevEpisodeIndex = currentEpisodeIndex.value > 0 ? currentEpisodeIndex.value - 1 : currentVideoEpisodes.value.length - 1
    }
    
    const prevEpisode = currentVideoEpisodes.value[prevEpisodeIndex]
    if (prevEpisode) {
      playEpisode(prevEpisode)
    }
  } else {
    // Normal song navigation
    const musicList = getPlaybackList()

    if (!musicList || musicList.length === 0) return

    const currentIndex = musicList.findIndex(m => makeTrackKey(m) === makeTrackKey(currentTrack.value))
    let prevIndex

    if (playMode.value === 'shuffle') {
      do {
        prevIndex = getRandomIndex(musicList.length)
      } while (musicList.length > 1 && prevIndex === currentIndex)
    } else {
      prevIndex = currentIndex > 0 ? currentIndex - 1 : musicList.length - 1
    }

    if (musicList[prevIndex]) {
      playMusic(musicList[prevIndex])
    }
  }
}

function playNext() {
  // 多P：显式「下一首」忽略 single；末P 不回绕，落到下面按外层列表的同一播放模式续播
  if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
    const nextEpisode = currentVideoEpisodes.value[getExplicitNextEpisodeIndex()]
    if (nextEpisode) {
      playEpisode(nextEpisode)
      return
    }
  }
  // Normal song navigation
  const musicList = getPlaybackList()
  const nextIndex = getNextMusicIndex()
  if (nextIndex >= 0 && musicList[nextIndex]) {
    playMusic(musicList[nextIndex])
  }
}

function onProgressInput(event) {
  const newTime = parseFloat(event.target.value)
  if (!isNaN(newTime)) {
    seekAudio(newTime)
    currentTime.value = newTime
    playerStore.setCurrentTime(newTime)
  }
}

function onProgressChange(event) {
  const newTime = parseFloat(event.target.value)
  if (!isNaN(newTime)) {
    seekAudio(newTime)
    currentTime.value = newTime
    playerStore.setCurrentTime(newTime)
  }
}

function handleLyricSeek(targetTime) {
  if (!isNaN(targetTime)) {
    seekAudio(targetTime)
    currentTime.value = targetTime
    playerStore.setCurrentTime(targetTime)
  }
}

function toggleLyricPanel() {
  showLyricPanel.value = !showLyricPanel.value
  lyricStore.setShowLyricPanel(showLyricPanel.value)
}

// ───────── 桌面歌词（悬浮窗） ─────────
const {
  dlEnabled,
  dlLocked,
  toggleDesktopLyrics,
  unlockDesktopLyrics
} = useDesktopLyrics({ onSeek: handleLyricSeek })

function createPlaylist() {
  showCreatePlaylistModal.value = true
  newPlaylistName.value = ''
}

async function confirmCreatePlaylist() {
  const name = newPlaylistName.value.trim()
  if (!name) return
  // 用 store 的统一 createPlaylist，id 走稳定生成器（Date.now+random），避免快速连点冲突
  const pl = playlistStore.createPlaylist(name)
  try { await playlistStore.savePlaylists() } catch (e) {
    console.warn('[createPlaylist] save failed:', e.message)
  }
  // 创建歌单后把分P加入新歌单（主页/搜索页多P添加流程）
  if (createPlaylistForP.value && pendingAddMusic.value) {
    const mode = createPlaylistForP.value
    createPlaylistForP.value = null
    const list = pendingEpisodes.value
    const source = pendingAddMusic.value
    let tracks = []
    if (mode === 'all') {
      tracks = list.map(e => buildEpisodeMusic(e, source)).filter(Boolean)
    } else {
      const keys = new Set(selectedPKeys.value)
      tracks = list.filter(e => keys.has(e.cid)).map(e => buildEpisodeMusic(e, source)).filter(Boolean)
    }
    await pushTracksToPlaylist(tracks, pl)
    showAddPModal.value = false
  }
  showCreatePlaylistModal.value = false
}

function cancelCreatePlaylist() {
  showCreatePlaylistModal.value = false
  createPlaylistForP.value = null
  newPlaylistName.value = ''
}

/**
 * 歌单封面同步统一走 stores/playlist.js 导出的 syncPlaylistCover：
 * - 本地歌单（含默认收藏夹）跟随 music[0] 封面
 * - coverMode === 'custom' 时保留用户自定义封面
 * - B 站收藏夹（isBiliFavorite）保留云端封面
 * 已在文件顶部 import，此处不再重复定义。
 */

// ============= 重命名歌单 =============
function openRenamePlaylist(playlist) {
  if (!playlist || playlist.isDefault) return
  renamePlaylistTarget.value = playlist
  renameValue.value = playlist.name || ''
  showRenameModal.value = true
}

async function confirmRenamePlaylist() {
  const name = renameValue.value.trim()
  const playlist = renamePlaylistTarget.value
  if (!name || !playlist) return
  playlist.name = name
  try { await playlistStore.savePlaylists() } catch (e) {
    console.warn('[renamePlaylist] save failed:', e.message)
  }
  showRenameModal.value = false
  renamePlaylistTarget.value = null
  renameValue.value = ''
}

function cancelRenamePlaylist() {
  showRenameModal.value = false
  renamePlaylistTarget.value = null
  renameValue.value = ''
}

// isTrackLike / pickTrackFields / TRACK_FIELDS 统一收敛在 utils/trackKey.js，
// 本地曲与 B 站曲共用同一套判定与字段白名单（已在文件顶部 import）。

function openAddToPlaylistModal(music) {
  // 防御：如果传入的不是歌曲对象（例如裸绑定 @click 时 Vue 塞进来的
  // 原生事件对象），按"未指定歌曲"处理，回退到当前播放曲目。
  if (music && !isTrackLike(music)) {
    console.warn('[openAddToPlaylistModal] 忽略非歌曲对象（疑似事件对象）:', typeof music, music && Object.keys(music).slice(0, 5))
    music = null
  }
  if (!music) {
    if (!currentTrack.value) return
    addToPlaylistTarget.value = null
  } else {
    addToPlaylistTarget.value = music
  }
  showAddToPlaylistModal.value = true
}

async function addToPlaylist(playlist) {
  let music = addToPlaylistTarget.value || currentTrack.value
  if (!music || !playlist) return
  // 防御：目标必须是真正的歌曲对象（带 bvid/favId/标题），
  // 事件对象等杂散数据不能进歌单（否则就会出现"空白标题/未知作者"的脏条目）
  if (!isTrackLike(music)) {
    console.warn('[addToPlaylist] 忽略非歌曲对象（疑似事件对象）:', typeof music, music && Object.keys(music).slice(0, 5))
    addToPlaylistTarget.value = null
    showAddToPlaylistModal.value = false
    return
  }
  if (!playlist.music) {
    playlist.music = []
  }
  // 统一身份判重（本地曲走 id，B 站曲走 bvid+cid / favId）
  const exists = playlist.music.some(m => sameTrack(m, music))
  if (!exists) {
    // 规范化：只保留歌曲字段 + 标题/作者/封面兜底（不再整体展开 music，
    // 避免把事件对象上的 isTrusted/_vts 等杂散键写进歌单）
    const normalizedMusic = pickTrackFields(music)
    playlist.music.push(normalizedMusic)
    syncPlaylistCover(playlist)
    try { await playlistStore.savePlaylists() } catch (e) {
      console.warn('[addToPlaylist] save failed:', e.message)
      alert('添加到歌单失败，请稍后重试')
      return
    }
  }
  addToPlaylistTarget.value = null
  showAddToPlaylistModal.value = false
}

async function downloadMusic(music) {
  try {
    isAudioLoading.value = true

    // 本地曲已在磁盘上，无需下载；直接定位到文件
    if (isLocalTrack(music)) {
      isAudioLoading.value = false
      try { await window.electronAPI?.local?.revealFile(music.filePath) } catch (_) {}
      alert('这是本地文件，已在文件夹中为你定位')
      return
    }

    // 复用播放地址缓存（cid + playurl），避免下载与播放重复打接口
    const source = await resolvePlaySource(music, settingsStore.audioQuality)
    if (!source?.url) {
      throw new Error('未找到音频地址')
    }
    const audioUrl = source.url
    const audioCodecs = source.codecs
    const cid = source.cid ?? music.cid

    downloadStore.setShowDownloadManager(true)
    await downloadStore.addTask({
      audioUrl,
      fileName: `${music.title} - ${music.author}`,
      bvid: music.bvid,
      cid,
      title: music.title,
      author: music.author,
      quality: settingsStore.audioQuality,
      audioCodecs
    })
  } catch (error) {
    logger.error('下载音乐失败:', error)
    alert('下载失败：' + error.message)
  } finally {
    isAudioLoading.value = false
  }
}

async function openDownloadFolder() {
  try {
    const result = await window.electronAPI.openDownloadFolder()
    if (result.code === 0) {
      console.log('成功打开下载目录')
    } else {
      throw new Error(result.message || '打开下载目录失败')
    }
  } catch (error) {
    console.error('打开下载目录失败:', error)
    alert('打开下载目录失败：' + error.message)
  }
}

function loadPlaylists() {
  playlistStore.loadPlaylists()
}

function deletePlaylist(playlist) {
  if (!playlist || playlist.isDefault) return
  const ok = playlistStore.deletePlaylist(playlist.id)
  if (!ok) return
  // 如果删的就是当前正在查看的歌单，需要清理 + 跳回列表
  if (currentPlaylist.value && currentPlaylist.value.id === playlist.id) {
    playlistStore.setCurrentPlaylist(null)
    backToPlaylistList()
  }
}

function exportPlaylist(playlist) {
  if (!playlist) return
  const dataStr = JSON.stringify(playlist, null, 2)
  const blob = new Blob([dataStr], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${playlist.name || '歌单'}.json`
  a.click()
  URL.revokeObjectURL(url)
}

function openLoginPanel() {
  showLoginPanel.value = true
}

function closeLoginPanel() {
  showLoginPanel.value = false
}

async function handleLoginSuccess() {
  // 登录成功后只拉取一次用户信息
  // （按用户要求：不再静默同步 B 站收藏夹，避免每次启动/登录都触发远端请求）
  if (!userStore.userInfo) {
    await userStore.fetchUserInfo()
  }
}

async function handleSyncFavorites() {
  if (!userStore.isLoggedIn || !userStore.userInfo?.mid) {
    alert('请先登录 B 站账号')
    return
  }
  const added = await userStore.syncFavorites(playlistStore)
  if (added === 0) {
    alert('收藏夹已为最新或没有可同步的项')
  } else {
    alert(`已同步 ${added} 个收藏夹到我的歌单`)
  }
}

function importPlaylist() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async (event) => {
      try {
        const imported = JSON.parse(event.target.result)
        if (imported.name && Array.isArray(imported.music)) {
          // 用统一 createPlaylist，id 走稳定生成器
          const pl = playlistStore.createPlaylist(imported.name, {
            cover: imported.cover || '',
            music: imported.music
          })
          syncPlaylistCover(pl)
          try { await playlistStore.savePlaylists() } catch (e) {
            console.warn('[importPlaylist] save failed:', e.message)
          }
        }
      } catch (error) {
        console.error('导入歌单失败:', error)
      }
    }
    reader.readAsText(file)
  }
  input.click()
}

// 实时同步播放器栏显隐状态到 document 属性，让 dock / main-content 立即响应
function syncPlayerState(track) {
  if (track) {
    document.documentElement.setAttribute('data-has-player', '')
  } else {
    document.documentElement.removeAttribute('data-has-player')
  }
}

watch(
  () => playerStore.currentTrack,
  (track) => syncPlayerState(track),
  { immediate: true, deep: true }
)

// 监听 MineView 等子组件派发的事件
function handlePinkMusicEvent(event) {
  const type = event.type
  if (type === 'pink-music:play-track') {
    playMusic(event.detail)
  } else if (type === 'pink-music:open-download') {
    downloadStore.setShowDownloadManager(true)
  } else if (type === 'pink-music:open-login') {
    showLoginPanel.value = true
  } else if (type === 'pink-music:open-playlist') {
    // 本地导入完成 → 跳转到新建的歌单
    const id = event.detail?.id
    const pl = playlistStore.userPlaylists.find(p => p.id === id)
    if (pl) {
      playlistStore.setCurrentPlaylist(pl)
      playlistStore.setCurrentView('playlist')
    }
  } else if (type === 'pink-music:playlist-deleted') {
    // 侧边栏/AppDock 等不在父组件作用域的删除入口派发的事件
    // 如果删的就是当前正在查看的歌单，需要清理 + 跳回列表
    const deletedId = event.detail?.id
    if (deletedId && currentPlaylist.value && currentPlaylist.value.id === deletedId) {
      playlistStore.setCurrentPlaylist(null)
      backToPlaylistList()
    }
  }
}

// Liquid Glass：应用 SVG feDisplacementMap 实现的液体玻璃效果
//
// 注意：<filter> 的 x/y/width/height 在 applyLiquidGlass 里按"创建那一刻的元素尺寸"固化，
// 之后窗口变宽不会更新。超出旧尺寸的部分不再经过玻璃滤镜，于是顶栏右侧（主题切换/用户按钮所在区）
// 会出现一块与顶栏背景不一致的矩形 —— 用户截图里"盖住按钮区"的就是它，不是任何真实的覆盖层。
// 因此尺寸一变（窗口缩放、最大化/还原、断点切换）就要按新尺寸重建实例。
const GLASS_OPTIONS = {
  topbar: {
    depth: 0.06,
    edgeSoftness: 0.4,
    backdrop: 'blur(1.5px) contrast(1.2) brightness(1.05) saturate(1.3)'
  },
  playerBar: {
    depth: 0.08,
    edgeSoftness: 0.35,
    backdrop: 'blur(2px) contrast(1.25) brightness(1.05) saturate(1.4)'
  }
}
const GLASS_TARGETS = {
  topbar: () => topbarRef.value,
  playerBar: () => playerBarRef.value
}
let glassResizeObserver = null
const glassResyncTimers = new Map()

function mountLiquidGlass(key, el) {
  if (!el) return
  const prev = liquidGlassInstances.get(key)
  if (prev) {
    destroyLiquidGlass(prev.id)
    liquidGlassInstances.delete(key)
  }
  const inst = applyLiquidGlass(el, {
    ...GLASS_OPTIONS[key],
    width: el.offsetWidth,
    height: el.offsetHeight
  })
  if (inst) liquidGlassInstances.set(key, inst)
}

function scheduleGlassResync(key) {
  const el = GLASS_TARGETS[key]()
  if (!el) return
  const inst = liquidGlassInstances.get(key)
  // 尺寸没变（只是布局抖动）就什么都不做，避免反复重建 SVG filter
  if (inst && inst.width === el.offsetWidth && inst.height === el.offsetHeight) return
  clearTimeout(glassResyncTimers.get(key))
  glassResyncTimers.set(key, setTimeout(() => {
    const target = GLASS_TARGETS[key]()
    if (!target) return
    const current = liquidGlassInstances.get(key)
    if (current && current.width === target.offsetWidth && current.height === target.offsetHeight) return
    mountLiquidGlass(key, target)
  }, 180))
}

function setupLiquidGlass() {
  const observing = new Set()
  for (const key of Object.keys(GLASS_OPTIONS)) {
    const el = GLASS_TARGETS[key]()
    if (!el) continue
    if (!liquidGlassInstances.has(key)) mountLiquidGlass(key, el)
    observing.add(el)
  }
  if (observing.size === 0 || typeof ResizeObserver === 'undefined') return
  if (!glassResizeObserver) {
    glassResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        for (const key of Object.keys(GLASS_TARGETS)) {
          if (entry.target === GLASS_TARGETS[key]()) scheduleGlassResync(key)
        }
      }
    })
  }
  // 播放栏是 v-if 后出现的，每次都重新对当前存在的目标调用一次 observe（重复调用无副作用）
  for (const el of observing) glassResizeObserver.observe(el)
}

// macOS 原生菜单命令处理
let unregisterMenuCommand = null
function handleMenuCommand(command) {
  if (!command || !command.action) return
  switch (command.action) {
    case 'toggle-play-pause':
      togglePlayPause()
      break
    case 'play-next':
      playNext()
      break
    case 'play-previous':
      playPrevious()
      break
    case 'set-play-mode':
      if (command.payload) playMode.value = command.payload
      break
    case 'go-home':
      goToHome()
      break
    case 'go-search':
      goToSearch()
      break
    case 'toggle-theme':
      toggleThemeMode()
      break
    case 'toggle-visualizer':
      settingsStore.audioVisualizerEnabled = !settingsStore.audioVisualizerEnabled
      break
    case 'toggle-lyric':
      toggleLyricPanel()
      break
    case 'toggle-desktop-lyrics':
      toggleDesktopLyrics()
      break
    case 'open-settings':
      openSettings()
      break
    case 'go-mine':
      // 切到"我的"视图（MineView 在 currentView === 'mine' 时挂载）
      playlistStore.setCurrentView('mine')
      break
    case 'check-update':
      // 菜单"检查更新…"：手动检查（绕过缓存），有新版本时切到"我的"让用户看到
      updateStore.check(true).then((res) => {
        if (res && res.hasUpdate) playlistStore.setCurrentView('mine')
      })
      break
    case 'toggle-player-page':
      // 全屏播放器显隐：有 currentTrack 时才进，无曲不响应
      if (playerStore.showPlayerPage) {
        playerStore.setShowPlayerPage(false)
      } else if (playerStore.currentTrack) {
        playerStore.setShowPlayerPage(true)
      }
      break
    case 'next-episode':
      // 跳到当前视频的下一个分P（仅在有分P时生效；shuffle 模式随机取一个不同的分P）
      if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
        let nextEpisodeIndex
        if (playMode.value === 'shuffle') {
          do {
            nextEpisodeIndex = getRandomIndex(currentVideoEpisodes.value.length)
          } while (
            currentVideoEpisodes.value.length > 1 &&
            nextEpisodeIndex === currentEpisodeIndex.value
          )
        } else {
          nextEpisodeIndex = (currentEpisodeIndex.value + 1) % currentVideoEpisodes.value.length
        }
        const nextEp = currentVideoEpisodes.value[nextEpisodeIndex]
        if (nextEp) playEpisode(nextEp)
      }
      break
    case 'previous-episode':
      // 跳到当前视频的上一个分P（仅在有分P时生效；shuffle 模式随机取一个不同的分P）
      if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
        let prevEpisodeIndex
        if (playMode.value === 'shuffle') {
          do {
            prevEpisodeIndex = getRandomIndex(currentVideoEpisodes.value.length)
          } while (
            currentVideoEpisodes.value.length > 1 &&
            prevEpisodeIndex === currentEpisodeIndex.value
          )
        } else {
          prevEpisodeIndex = currentEpisodeIndex.value > 0
            ? currentEpisodeIndex.value - 1
            : currentVideoEpisodes.value.length - 1
        }
        const prevEp = currentVideoEpisodes.value[prevEpisodeIndex]
        if (prevEp) playEpisode(prevEp)
      }
      break
    default:
      console.warn('[MenuCommand] 未知菜单命令:', command.action)
  }
}

onMounted(async () => {
  // 注册 macOS 原生菜单命令监听
  if (window.electronPlayer && window.electronPlayer.onMenuCommand) {
    unregisterMenuCommand = window.electronPlayer.onMenuCommand(handleMenuCommand)
  }
  // 主题应用：统一交给 themeStore（兼容旧版 localStorage 键名）
  themeStore.initTheme()
  // 关键修复：歌单加载必须 await，不能 fire-and-forget！
  // 否则会出现以下竞态：
  //   1) peek 拿不到 localStorage（空）→ 初始 state = []
  //   2) 用户立刻添加歌单/歌曲 → savePlaylists() 写空 state 到主存储
  //   3) async load() 才完成 → 主存储原数据已被覆盖
  // 改为 await：等 load() 完成、_loaded 置位、迁移完成后再继续，
  // 期间任何 savePlaylists() 会被 store 内部排队，load 完才 flush。
  await playlistStore.load()
  loadRecommendedMusic()

  // 统一播放内核：注册完整 playMusic/handleTrackEnd，并把引擎事件同步到本地 UI 状态
  const hostPlayer = useAudioPlayer()
  hostPlayer.registerHostPlayback({ playMusic, handleTrackEnd })
  bindPlaybackRuntime({
    onTime: (time, buf, flags) => {
      currentTime.value = time
      if (flags?.bufChanged) bufferedProgress.value = buf
      if (flags?.syncStore) playerStore.setCurrentTime(time)
    },
    onLoadedMetadata: (el) => {
      const dur = el.duration || currentTrack.value?.duration || 180
      duration.value = dur
      playerStore.setDuration(dur)
      isAudioLoading.value = false
      playerStore.setIsAudioLoading(false)
    },
    onCanPlay: () => {
      isAudioLoading.value = false
      playerStore.setIsAudioLoading(false)
      bufferedProgress.value = 100
      playerStore.setBufferedProgress(100)
    },
    onError: () => {
      audioError.value = '音频加载失败'
      playerStore.setAudioError('音频加载失败')
      isAudioLoading.value = false
      playerStore.setIsAudioLoading(false)
      isPlaying.value = false
      playerStore.setIsPlaying(false)
    },
    onEnded: () => {
      isPlaying.value = false
      playerStore.setIsPlaying(false)
      syncMediaSession()
      handleTrackEnd()
    }
  })
  // 本地 playMode 与 store 对齐（播放栏/引擎读 store，大屏读本地）
  if (playerStore.playMode) playMode.value = playerStore.playMode

  setupMediaSessionHandlers()
  downloadStore.loadTasks()
  downloadStore.registerProgressListener()
  // 下载目录：纯 IPC 内存态，先注册主进程推送监听再拉一次初值
  settingsStore.registerDownloadDirListener()
  settingsStore.loadDownloadDirectory()
  window.addEventListener('pink-music:play-track', handlePinkMusicEvent)
  window.addEventListener('pink-music:open-download', handlePinkMusicEvent)
  window.addEventListener('pink-music:open-login', handlePinkMusicEvent)
  window.addEventListener('pink-music:playlist-deleted', handlePinkMusicEvent)
  window.addEventListener('pink-music:open-playlist', handlePinkMusicEvent)

  // ───────── 持久化存储启动加载 ─────────
  // 各 store 的 load() 都会从主存储 userData/app-data/<key>.json 拉最新数据；
  // 主存储为空时自动从 localStorage 老 key 迁移到主存储。
  // 并行执行，减少启动延迟。
  // 关键修复：把 playlistStore.load() 也加进来。
  // 虽然上面已经 await 过一次（保证首屏前就绪），这里再放一次是为了
  // 兼容"组件 onMounted 之前已经触发 load 但还没完成"的边界场景（如
  // 别的组件 import 了 store 立刻调用 load()），统一让 _loaded 流程
  // 在主流程里被正确识别。
  await Promise.allSettled([
    themeStore.load(),
    settingsStore.load(),
    playerStore.load(),
    lyricStore.load(),
    userStore.load(),
    playlistStore.load(),
    localStore.load()
  ])

  // 本地库失效检测：启动后台静默执行（不阻塞首屏），只标记不删除
  if (settingsStore.localCheckMissingOnStartup && localStore.tracks.length > 0) {
    localStore.checkMissing().catch(e => logger.warn('[App] 本地失效检测失败:', e?.message))
  }

  // 版本更新：静默检查，排在首次引导之后 —— 引导未完成时不检查，避免与引导页抢占首屏
  updateStore.loadVersion()
  if (settingsStore.onboardingCompleted && settingsStore.checkUpdateOnStartup) {
    updateStore.check(false)
  }
  // 引导页刚完成（onboardingCompleted 变为 true）时补一次静默检查
  watch(() => settingsStore.onboardingCompleted, (done) => {
    if (done && settingsStore.checkUpdateOnStartup) updateStore.check(false)
  })

  // 启动时尝试恢复登录态：先检查主进程是否持有 B 站 cookie，再拉取用户信息
  try {
    const restored = await userStore.restoreFromCookies()
    if (!restored) {
      await userStore.fetchUserInfo()
    }
  } catch (error) {
    console.error('恢复登录态失败:', error)
  }
  // 等 DOM 稳定后初始化 liquid glass，并监听播放器栏显隐
  await nextTick()
  setupLiquidGlass()
  watch(playerBarRef, (val) => {
    if (val) setupLiquidGlass()
  })

  // 关窗口前 flush 协议：主进程 before-quit 时通知
  if (window.electronAPI?.onFlushRequired) {
    const flushHandler = async () => {
      try {
        console.log('[App] 收到 flush 请求，开始同步所有 store')
        // 先 await 一个微任务，让所有"刚同步触发的 save"先进 store 内部的 _pendingSave 队列
        await Promise.resolve()
        // 歌单最重要，先 flush（含 localStorage 同步写 + 主存 IPC）
        await playlistStore.flush(2500)
        // 其他 store 也强制 flush：先同步写 localStorage（writeLocalJsonNow 走
        // 同步写，不依赖 debounce 队列），再发主存储 IPC。
        // 这样能在关窗口的 3s 死线前确保 localStorage 一定落盘，主存储 IPC 已经发出。
        const flushTasks = []
        try { flushTasks.push(themeStore.persist?.() ?? themeStore.save?.()) } catch (e) { console.warn('[flush] theme:', e.message) }
        try { flushTasks.push(settingsStore.persist?.() ?? settingsStore.save?.()) } catch (e) { console.warn('[flush] settings:', e.message) }
        // 先 flush pending 的 debounced save（如果有 timer 在等，立即触发；没有则 no-op）
        try { await playerStore.flushPendingHistorySave?.() } catch (e) { console.warn('[flush] pending history:', e.message) }
        // 再补一次显式 persist，确保关窗前最新快照落盘
        try { flushTasks.push(playerStore.savePlayHistory?.()) } catch (e) { console.warn('[flush] player:', e.message) }
        try { flushTasks.push(lyricStore.persist?.() ?? lyricStore.save?.()) } catch (e) { console.warn('[flush] lyric:', e.message) }
        try { flushTasks.push(userStore.persist?.() ?? userStore.save?.()) } catch (e) { console.warn('[flush] user:', e.message) }
        const results = await Promise.allSettled(flushTasks)
        const failed = results.filter(r => r.status === 'rejected').length
        console.log(`[App] flush 完毕（${results.length - failed} 成功 / ${failed} 失败），通知主进程`)
      } catch (e) {
        console.error('[App] flush 异常:', e.message)
      } finally {
        // 刷新所有防抖的 localStorage 写，确保双写一致
        try { flushPendingLocalWrites() } catch (_) {}
        // 无论成功失败都告诉主进程可以退出了（3s 超时保护）
        try { window.electronAPI?.notifyFlushDone?.() } catch (_) {}
      }
    }
    unregisterFlushListener = window.electronAPI.onFlushRequired(flushHandler)
    // 暴露给 HMR 用：让下次模块热更时能调用反注册
    window[HMR_FLUSH_KEY] = unregisterFlushListener
  }

  // 兜底：浏览器原生 beforeunload 事件（双保险，覆盖 webview 之类场景）
  beforeUnloadFlush = () => {
    try { playlistStore.flush?.(500) } catch (_) {}
  }
  window.addEventListener('beforeunload', beforeUnloadFlush)
  window.addEventListener('pagehide', beforeUnloadFlush)
})

onBeforeUnmount(() => {
  // 卸载前释放 WebAudio 分析器（关闭 AudioContext），避免 HMR / 退出时泄漏
  try { destroyAudioAnalyser() } catch (_) {}
})

onUnmounted(() => {
  // 注销 macOS 原生菜单命令监听
  if (unregisterMenuCommand) {
    unregisterMenuCommand()
    unregisterMenuCommand = null
  }
  // 注销 flush 监听器（HMR / 组件卸载时清理，避免重复注册）
  if (unregisterFlushListener) {
    try { unregisterFlushListener() } catch (_) {}
    unregisterFlushListener = null
  }
  // 注销下载目录变更监听
  settingsStore.unregisterDownloadDirListener()
  // 注销下载进度监听
  try { downloadStore.unregisterProgressListener() } catch (_) {}
  // 注销关窗前兜底 flush 监听
  if (beforeUnloadFlush) {
    window.removeEventListener('beforeunload', beforeUnloadFlush)
    window.removeEventListener('pagehide', beforeUnloadFlush)
    beforeUnloadFlush = null
  }
  if (window[HMR_FLUSH_KEY]) {
    window[HMR_FLUSH_KEY] = null
  }
  window.removeEventListener('pink-music:play-track', handlePinkMusicEvent)
  window.removeEventListener('pink-music:open-download', handlePinkMusicEvent)
  window.removeEventListener('pink-music:open-login', handlePinkMusicEvent)
  window.removeEventListener('pink-music:open-playlist', handlePinkMusicEvent)
  if (glassResizeObserver) {
    glassResizeObserver.disconnect()
    glassResizeObserver = null
  }
  glassResyncTimers.forEach((timer) => clearTimeout(timer))
  glassResyncTimers.clear()
  liquidGlassInstances.forEach((inst) => destroyLiquidGlass(inst.id))
  liquidGlassInstances.clear()
})
</script>

<template>
  <div class="app-container" :class="{ 'has-custom-bg': themeStore.customBgEnabled && themeStore.customBgUrl }">
    <!-- 自定义背景层 -->
    <div
      v-if="themeStore.customBgEnabled && themeStore.customBgUrl"
      class="custom-app-background"
      aria-hidden="true"
    >
      <div class="custom-bg-layer" :style="customBgLayerStyle"></div>
      <div class="custom-bg-mask" :style="customBgMaskStyle"></div>
    </div>
    <div class="drag-bar"></div>
    <WindowControls />
    <header ref="topbarRef" class="topbar">
      <div class="topbar-left">
        <h1 class="brand">Pink Music</h1>
      </div>

      <div class="topbar-right">
        <!-- 一键切换深色/浅色模式 -->
        <button
          class="topbar-btn theme-quick-toggle"
          :title="themeStore.currentTheme === 'dark' ? '切换到浅色模式' : '切换到深色模式'"
          @click="toggleThemeMode"
        >
          <svg v-if="themeStore.currentTheme === 'dark'" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
            <path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/>
          </svg>
        </button>
        <button
          v-if="userStore.hasLoginCookie"
          class="topbar-btn topbar-user"
          @click="openLoginPanel"
          :class="{ active: showLoginPanel }"
          title="已登录 B 站账号"
        >
          <img
            :src="userStore.userInfo?.face"
            class="topbar-avatar"
            alt=""
            @error="$event.target.style.display='none'" loading="lazy" decoding="async" />
          <span>{{ userStore.userInfo?.uname || '已登录' }}</span>
        </button>
        <button v-else class="topbar-btn topbar-login" @click="openLoginPanel" title="登录 B 站">
          <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
            <path d="M11 7L9.6 8.4l2.6 2.6H2v2h10.2l-2.6 2.6L11 17l5-5-5-5zm9 12h-8v2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-8v2h8v14z"/>
          </svg>
          <span>登录 B 站</span>
        </button>
      </div>
    </header>

    <main class="main-content">
      <Transition name="page" mode="out-in">
        <section v-if="currentView === 'home'" key="home" class="home-section">
        <div class="hero-section">
          <h2 class="text-gradient">欢迎使用 Pink Music</h2>
          <p>从 B 站发现并播放你喜欢的音乐</p>
        </div>

        <div class="recommended-section">
          <div class="section-header">
            <h3>推荐音乐</h3>
            <button
              class="refresh-btn"
              @click="loadRecommendedMusic"
              :disabled="isLoadingRecommended"
              title="刷新推荐"
            >
              <svg
                viewBox="0 0 24 24"
                fill="currentColor"
                width="18"
                height="18"
                :class="{ spinning: isLoadingRecommended }"
              >
                <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
              </svg>
            </button>
          </div>
          <div v-if="isLoadingRecommended" class="loading">
            <div class="loading-spinner"></div>
            <p>加载中...</p>
          </div>
          <div v-else-if="recommendedMusic.length === 0" class="loading">
            <p>暂无推荐音乐</p>
          </div>
          <div v-else class="card-grid">
            <div
              v-for="(music, index) in recommendedMusic"
              :key="music.bvid"
              class="music-card"
              :style="{ '--card-index': index }"
              @click="playMusic(music)"
            >
              <div class="card-cover">
                <img :src="fixCoverUrl(music.cover)" :alt="music.title" loading="lazy" decoding="async" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
                <div class="play-overlay">
                  <button class="play-button" @click.stop="playMusic(music)">
                    <svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                  <button class="download-button" @click.stop="downloadMusic(music)" title="下载">
                    <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                  </button>
                  <button class="p-add-btn" @click.stop="openAddPSelect(music)" title="添加到歌单">
                    <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                  </button>
                </div>
              </div>
              <h4 class="card-title">{{ music.title }}</h4>
              <p class="card-artist">{{ music.author }}</p>
              <div class="music-card-meta">
                <span>{{ formatPlayCount(music.playCount) }} 播放</span>
                <span>{{ parseDuration(music.duration) }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section v-else-if="currentView === 'search'" key="search" class="search-section">
        <div class="header">
          <div class="search-box">
            <input 
              type="text"
              v-model="searchQuery"
              placeholder="搜索音乐..." 
              @keyup.enter="handleSearch"
            >
            <button @click="handleSearch">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
            </button>
          </div>
        </div>

        <!-- 搜索结果（仅在搜索时显示在中间） -->
        <div v-if="isLoadingSearch" class="loading">
          <div class="loading-spinner"></div>
          <p>搜索中...</p>
        </div>
        <div v-else-if="currentView === 'search' && searchResults.length === 0" class="loading">
          <p>未找到相关音乐</p>
        </div>
        <div v-else-if="currentView === 'search'" class="card-grid">
          <div
            v-for="(music, index) in searchResults"
            :key="music.bvid"
            class="music-card"
            :style="{ '--card-index': index }"
            @click="playMusic(music)"
          >
            <div class="card-cover">
              <img :src="fixCoverUrl(music.cover)" :alt="music.title" loading="lazy" decoding="async" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
              <span v-if="music.videos > 1" class="p-badge">{{ music.videos }} P</span>
              <div class="play-overlay">
                <button class="play-button" @click.stop="playMusic(music)">
                  <svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="download-button" @click.stop="downloadMusic(music)" title="下载">
                  <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                </button>
                <button class="p-add-btn" @click.stop="openAddPSelect(music)" title="添加到歌单">
                  <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                </button>
              </div>
            </div>
            <h4 class="card-title">{{ music.title }}</h4>
            <p class="card-artist">{{ music.author }}</p>
            <div class="music-card-meta">
              <span>{{ formatPlayCount(music.playCount) }} 播放</span>
              <span>{{ parseDuration(music.duration) }}</span>
            </div>
          </div>
        </div>
      </section>

      <section v-else-if="currentView === 'playlist'" key="playlist" class="playlist-page">
        <!-- 歌单列表 -->
        <div v-if="!currentPlaylist" class="playlist-list-view">
          <div class="playlist-list-header">
            <div>
              <span class="playlist-label">我的歌单</span>
              <h2 class="playlist-list-title">全部歌单</h2>
              <p class="playlist-list-subtitle">
                <template v-if="isBatchMode">
                  已选 {{ selectedPlaylistIds.size }} / {{ playlistStore.userPlaylists.length }} 个
                </template>
                <template v-else>
                  共 {{ playlistStore.userPlaylists.length }} 个歌单
                </template>
              </p>
            </div>
            <div class="playlist-list-actions">
              <!-- 批量模式下的工具栏 -->
              <template v-if="isBatchMode">
                <button
                  v-if="getDeletablePlaylistIds().length > 0"
                  @click="toggleSelectAllPlaylists"
                  class="playlist-action-btn"
                  :title="isAllDeletablePlaylistsSelected ? '取消全选' : '选中所有可删除的歌单（默认收藏夹除外）'"
                >
                  <svg v-if="isAllDeletablePlaylistsSelected" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                  <span>{{ isAllDeletablePlaylistsSelected ? '取消全选' : '全选' }}</span>
                </button>
                <button
                  @click="exitBatchMode"
                  class="playlist-action-btn"
                  title="退出批量模式"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                  <span>取消</span>
                </button>
                <button
                  @click="confirmBatchDeletePlaylists"
                  class="playlist-action-btn danger"
                  :disabled="selectedPlaylistIds.size === 0"
                  :title="selectedPlaylistIds.size === 0 ? '请先选择要删除的歌单' : '批量删除所选歌单'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1-1H5v2h14V4z"/></svg>
                  <span>批量删除{{ selectedPlaylistIds.size > 0 ? ` (${selectedPlaylistIds.size})` : '' }}</span>
                </button>
              </template>
              <!-- 正常模式下的工具栏 -->
              <template v-else>
                <button @click="createPlaylist" class="playlist-action-btn primary" title="新建歌单">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                  <span>新建歌单</span>
                </button>
                <button @click="importPlaylist" class="playlist-action-btn" title="导入歌单">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
                  <span>导入歌单</span>
                </button>
                <button @click="handleSyncFavorites" class="playlist-action-btn" title="从 B 站收藏夹同步">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z"/></svg>
                  <span>同步收藏夹</span>
                </button>
                <button
                  v-if="playlistStore.userPlaylists.length > 1"
                  @click="enterBatchMode"
                  class="playlist-action-btn"
                  title="批量管理歌单"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M3 5h2v2H3V5zm4 0h14v2H7V5zM3 11h2v2H3v-2zm4 0h14v2H7v-2zM3 17h2v2H3v-2zm4 0h14v2H7v-2z"/></svg>
                  <span>批量管理</span>
                </button>
              </template>
            </div>
          </div>

          <div v-if="playlistStore.userPlaylists.length === 0" class="playlist-empty">
            <div class="empty-icon">
              <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
                <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
              </svg>
            </div>
            <p>还没有歌单</p>
            <div class="empty-actions">
              <button @click="createPlaylist" class="load-fav-btn">新建一个歌单</button>
              <button @click="importPlaylist" class="playlist-action-btn">从 JSON 导入</button>
            </div>
          </div>

          <div v-else class="playlist-cards-grid">
            <div
              v-for="(playlist, index) in playlistStore.userPlaylists"
              :key="playlist.id"
              class="playlist-card-item"
              :class="{
                'is-bili-fav': playlist.isBiliFavorite,
                'is-default': playlist.isDefault,
                'is-batch-mode': isBatchMode,
                'is-selected': isBatchMode && isPlaylistSelected(playlist),
                'is-disabled': isBatchMode && playlist.isDefault
              }"
              :style="{ '--card-index': index }"
              @click="isBatchMode ? togglePlaylistSelection(playlist) : goToPlaylist(playlist)"
            >
              <div
                v-if="isBatchMode"
                class="playlist-card-checkbox"
                :class="{ checked: isPlaylistSelected(playlist) }"
                @click.stop="togglePlaylistSelection(playlist)"
              >
                <svg v-if="isPlaylistSelected(playlist)" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                <span v-else-if="playlist.isDefault" class="lock-hint" title="默认收藏夹不可删除">🔒</span>
              </div>
              <div class="playlist-card-cover">
              <img
                :src="fixCoverUrl(playlist.cover, 300) || 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300'"
                :alt="playlist.name"
                loading="lazy"
                decoding="async"
                @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=300'"
              />
              <div
                v-if="!isBatchMode"
                class="playlist-card-overlay"
                :class="{ 'is-clickable': playlist.music && playlist.music.length > 0 }"
                :title="playlist.music && playlist.music.length > 0 ? '一键播放该歌单' : '该歌单暂无歌曲'"
                @click.stop="playPlaylistAll(playlist)"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
                  <path d="M8 5v14l11-7z"/>
                </svg>
              </div>
              <div
                v-else
                class="playlist-card-overlay playlist-card-overlay--batch"
                :class="{ 'is-checked': isPlaylistSelected(playlist) }"
                @click.stop="togglePlaylistSelection(playlist)"
              >
                <svg v-if="isPlaylistSelected(playlist)" viewBox="0 0 24 24" fill="currentColor" width="36" height="36"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
              </div>
              <span v-if="playlist.isBiliFavorite" class="bili-fav-badge">B站</span>
              <span v-if="playlist.isDefault" class="default-badge">默认</span>
            </div>
              <div class="playlist-card-body">
                <h4 class="playlist-card-name">{{ playlist.name }}</h4>
                <p class="playlist-card-count">{{ playlist.music?.length || playlist.media_count || 0 }} 首</p>
              </div>
              <!-- 批量模式下隐藏工具栏：里面的单条删除/导出/加载按钮与批量管理语义冲突，会让用户误以为点了能影响"已选"集合 -->
              <div v-if="!isBatchMode" class="playlist-card-toolbar">
                <button
                  v-if="!playlist.isDefault"
                  class="card-tool-btn"
                  @click.stop="exportPlaylist(playlist)"
                  title="导出"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                </button>
                <button
                  v-if="playlist.isBiliFavorite"
                  class="card-tool-btn"
                  @click.stop="loadFavResourcesFor(playlist)"
                  :disabled="isLoadingFavResources"
                  title="加载收藏夹内容"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>
                </button>
                <button
                  v-if="!playlist.isDefault"
                  class="card-tool-btn danger"
                  @click.stop="confirmDeletePlaylist(playlist)"
                  title="删除"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1-1H5v2h14V4z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 歌单详情 -->
        <div v-else>
          <button @click="backToPlaylistList" class="back-link">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
            <span>返回歌单列表</span>
          </button>
        <div class="playlist-header">
          <div
            class="playlist-cover"
            :class="{ 'is-clickable': currentPlaylist?.music && currentPlaylist.music.length > 0 }"
            :title="currentPlaylist?.music && currentPlaylist.music.length > 0 ? '点击一键播放整个歌单' : ''"
            @click="playPlaylistAll(currentPlaylist)"
          >
            <img
              :src="currentPlaylist?.cover || 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'"
              :alt="currentPlaylist?.name"
              @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'" loading="lazy" decoding="async" />
            <div class="playlist-cover-overlay">
              <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
          </div>
          <div class="playlist-meta">
            <span class="playlist-label">歌单</span>
            <h2 class="playlist-name">{{ currentPlaylist?.name }}</h2>
            <div class="playlist-stats">
              <span>{{ currentPlaylist?.music?.length || currentPlaylist?.media_count || 0 }} 首音乐</span>
              <span v-if="currentPlaylist?.isBiliFavorite" class="playlist-tag">B 站收藏夹</span>
            </div>
            <div class="playlist-actions" v-if="!currentPlaylist?.id || currentPlaylist?.music">
              <!-- 批量管理模式工具栏 -->
              <template v-if="isTrackBatchMode">
                <span class="batch-mode-hint">
                  已选 {{ selectedTrackKeys.size }} / {{ currentPlaylist?.music?.length || 0 }} 首
                </span>
                <button
                  @click="isAllTracksSelected() ? (selectedTrackKeys = new Set()) : selectAllTracks()"
                  class="playlist-action-btn"
                  :title="isAllTracksSelected() ? '取消全选' : '全选所有歌曲'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                  <span>{{ isAllTracksSelected() ? '取消全选' : '全选' }}</span>
                </button>
                <button @click="exitTrackBatchMode" class="playlist-action-btn" title="退出批量模式">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
                  <span>取消</span>
                </button>
                <button
                  @click="openBatchAddToPlaylist"
                  class="playlist-action-btn"
                  :disabled="selectedTrackKeys.size === 0"
                  :title="selectedTrackKeys.size === 0 ? '请先选择要添加的歌曲' : '将所选歌曲添加到其它歌单'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                  <span>添加到...</span>
                </button>
                <button
                  @click="confirmBatchDeleteTracks"
                  class="playlist-action-btn danger"
                  :disabled="selectedTrackKeys.size === 0"
                  :title="selectedTrackKeys.size === 0 ? '请先选择要删除的歌曲' : '批量删除所选歌曲'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1-1H5v2h14V4z"/></svg>
                  <span>批量删除{{ selectedTrackKeys.size > 0 ? ` (${selectedTrackKeys.size})` : '' }}</span>
                </button>
              </template>
              <!-- 正常模式工具栏 -->
              <template v-else>
                <button
                  v-if="currentPlaylist?.music && currentPlaylist.music.length > 0"
                  @click="playPlaylistAll(currentPlaylist)"
                  class="playlist-action-btn primary"
                  title="一键播放整个歌单"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M8 5v14l11-7z"/></svg>
                  <span>播放</span>
                </button>
                <button @click="exportPlaylist(currentPlaylist)" class="playlist-action-btn" title="导出歌单">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
                  <span>导出</span>
                </button>
                <button
                  v-if="!currentPlaylist?.isBiliFavorite"
                  @click="openLocalImportToPlaylist()"
                  class="playlist-action-btn"
                  title="从本地导入音频到这个歌单"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                  <span>从本地添加</span>
                </button>
                <button
                  v-if="!currentPlaylist?.isBiliFavorite"
                  @click="changePlaylistCover(currentPlaylist)"
                  class="playlist-action-btn"
                  :title="currentPlaylist?.coverMode === 'custom' ? '当前为自定义封面，点击更换' : '设置自定义封面'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>
                  <span>封面</span>
                </button>
                <button
                  v-if="!currentPlaylist?.isDefault"
                  @click="openRenamePlaylist(currentPlaylist)"
                  class="playlist-action-btn"
                  title="重命名歌单"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
                  <span>重命名</span>
                </button>
                <button
                  v-if="currentPlaylist?.isBiliFavorite"
                  @click="loadFavResources"
                  class="playlist-action-btn"
                  :disabled="isLoadingFavResources"
                  title="加载收藏夹内的视频"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 8l-4 4h3c0 3.31-2.69 6-6 6-1.01 0-1.97-.25-2.8-.7l-1.46 1.46C8.97 19.54 10.43 20 12 20c4.42 0 8-3.58 8-8h3l-4-4zM6 12c0-3.31 2.69-6 6-6 1.01 0 1.97.25 2.8.7l1.46-1.46C15.03 4.46 13.57 4 12 4c-4.42 0-8 3.58-8 8H1l4 4 4-4H6z"/></svg>
                  <span v-if="isLoadingFavResources">
                    {{ `加载中 ${favSyncProgress.loaded}/${currentPlaylist?.media_count || favSyncProgress.loaded}` }}
                  </span>
                  <span v-else>加载视频</span>
                </button>
                <button
                  v-if="currentPlaylist?.music && currentPlaylist.music.length > 0"
                  @click="enterTrackBatchMode"
                  class="playlist-action-btn"
                  title="批量管理歌曲"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M3 5h2v2H3V5zm4 0h14v2H7V5zM3 11h2v2H3v-2zm4 0h14v2H7v-2zM3 17h2v2H3v-2zm4 0h14v2H7v-2z"/></svg>
                  <span>批量管理</span>
                </button>
                <button
                  v-if="!currentPlaylist?.isDefault"
                  @click="confirmDeletePlaylist(currentPlaylist)"
                  class="playlist-action-btn danger"
                  title="删除歌单（仅本地）"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1-1H5v2h14V4z"/></svg>
                  <span>删除</span>
                </button>
              </template>
            </div>
          </div>
        </div>

        <div class="track-list" v-if="currentPlaylist?.music && currentPlaylist.music.length > 0">
          <div class="track-list-header" :class="{ 'is-batch-mode': isTrackBatchMode }">
            <span class="col-index">#</span>
            <span class="col-title">标题</span>
            <span class="col-actions"></span>
            <span class="col-duration">时长</span>
          </div>
          <div
            v-for="(music, index) in currentPlaylist?.music"
            :key="getTrackKey(music, index)"
            class="track-row"
            :class="{
              'is-track-batch': isTrackBatchMode,
              'is-track-selected': isTrackBatchMode && isTrackSelected(music, index)
            }"
            :style="{ '--track-index': index }"
            @click="isTrackBatchMode ? toggleTrackSelection(music, index) : playMusic(music)"
          >
            <div class="col-index">
              <span class="track-index">{{ index + 1 }}</span>
              <svg class="track-play-icon" viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                <path d="M8 5v14l11-7z"/>
              </svg>
            </div>
            <div class="col-title">
              <img
                :src="music.cover"
                :alt="music.title"
                class="track-cover"
                @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=100'" loading="lazy" decoding="async" />
              <div class="track-text">
                <h4>{{ music.title || '未知标题' }}</h4>
                <p>{{ music.author || '未知作者' }}</p>
              </div>
            </div>
            <div class="col-actions">
              <button
                v-if="!isTrackBatchMode"
                class="track-action-btn"
                @click.stop="downloadMusic(music)"
                title="下载"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </button>
              <button
                v-if="!isTrackBatchMode"
                class="track-action-btn track-action-btn--delete"
                @click.stop="confirmDeleteTrack(music)"
                title="从歌单中删除"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1-1H5v2h14V4z"/></svg>
              </button>
              <span
                v-if="isTrackBatchMode"
                class="track-row-checkbox"
                :class="{ checked: isTrackSelected(music, index) }"
                @click.stop="toggleTrackSelection(music, index)"
              >
                <svg v-if="isTrackSelected(music, index)" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
              </span>
            </div>
            <div class="col-duration">{{ parseDuration(music.duration) }}</div>
          </div>
        </div>

        <div v-else-if="currentPlaylist?.isBiliFavorite" class="playlist-empty">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
          <p>该收藏夹内的视频尚未加载到本地歌单</p>
          <button class="load-fav-btn" :disabled="isLoadingFavResources" @click="loadFavResources">
            <template v-if="isLoadingFavResources">
              {{ `加载中 ${favSyncProgress.loaded}/${currentPlaylist?.media_count || favSyncProgress.loaded}` }}
            </template>
            <template v-else>加载该收藏夹内的视频</template>
          </button>
        </div>

        <div v-else class="playlist-empty">
          <div class="empty-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="48" height="48">
              <path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/>
            </svg>
          </div>
          <p>该歌单还没有音乐</p>
        </div>
        </div>
      </section>

      <LocalMusicView
        v-else-if="currentView === 'local'"
        key="local"
        @play="playLocalTrack"
        @play-all="playLocalAll"
        @add-to-playlist="openAddToPlaylistModal"
      />

      <MineView v-else-if="currentView === 'mine'" key="mine" />
      </Transition>
    </main>

    <div v-if="currentTrack" class="player-bar">
      <div class="current-track">
        <button class="current-cover-btn" @click="openPlayerPageFromCover">
          <img :src="fixCoverUrl(currentTrack.cover)" :alt="currentTrack.title" class="current-cover" loading="lazy" decoding="async" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
          <div class="cover-overlay">
            <svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>
          </div>
        </button>
        <div class="current-info">
          <h4>{{ currentTrack.title || '未知标题' }}</h4>
          <p>{{ currentTrack.author || '未知作者' }}</p>
        </div>
      </div>

      <div class="player-controls">
        <div class="control-buttons">
          <button @click="togglePlayMode" class="control-btn mode-btn" :class="{ active: playMode !== 'order' }" :title="getPlayModeLabel()">
            <span class="mode-icon" v-html="getPlayModeIcon()"></span>
          </button>
          <button @click="playPrevious" class="control-btn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button @click="togglePlayPause" class="control-btn play">
            <svg v-if="isPlaying" viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button @click="playNext" class="control-btn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
          </button>
        </div>

        <div class="progress-container">
          <span class="progress-time">{{ parseDuration(currentTime) }}</span>
          <div class="progress-bar-wrapper">
            <input
              type="range"
              min="0"
              :max="duration || 100"
              :value="currentTime"
              @input="onProgressInput"
              @change="onProgressChange"
              class="progress-slider"
            >
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: (duration > 0 ? (currentTime / duration) * 100 : 0) + '%' }"></div>
              <div class="buffered-fill" :style="{ width: bufferedProgress + '%' }"></div>
            </div>
          </div>
          <span class="progress-time">{{ parseDuration(duration) }}</span>
        </div>
      </div>

      <div class="player-actions">
        <button
          @click="dlLocked ? unlockDesktopLyrics() : toggleDesktopLyrics()"
          class="action-btn desktop-lyrics-btn"
          :class="{ active: dlEnabled, locked: dlLocked }"
          :title="dlLocked ? '桌面歌词已锁定，点击解锁' : (dlEnabled ? '关闭桌面歌词' : '开启桌面歌词 (Cmd/Ctrl+D)')"
        >
          <span class="desktop-lyrics-char" aria-hidden="true">词</span>
          <svg v-if="dlEnabled && !dlLocked" viewBox="0 0 24 24" fill="currentColor" width="10" height="10" class="dl-on-dot"><circle cx="12" cy="12" r="6"/></svg>
        </button>
        <button @click="openAddToPlaylistModal()" class="action-btn" title="添加到歌单">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
        </button>
        <button @click="togglePlaylistManager" class="action-btn" title="歌单管理">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M2 15.5v2h20v-2H2zm0-5v2h20v-2H2zm0-5v2h20V5H2z"/></svg>
        </button>
      </div>
    </div>

    <!-- Playlist Manager -->
    <div v-if="showPlaylistManager" class="playlist-manager" @click="showPlaylistManager = false">
      <div class="playlist-manager-content" @click.stop>
        <div class="playlist-manager-header">
          <h3>视频分P</h3>
          <button class="close-btn" @click="showPlaylistManager = false">
            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>

        <div v-if="isLoadingEpisodes" class="loading-episodes">
          <p>加载分P列表中...</p>
        </div>

        <div v-else class="playlist-manager-list">
          <div v-if="currentVideoEpisodes.length === 0" class="empty-list">
            <p>当前视频没有分P</p>
          </div>
          <div
            v-for="(episode, index) in currentVideoEpisodes"
            :key="episode.cid"
            class="manager-item"
            @click="playEpisode(episode)"
          >
            <div class="item-info">
              <span class="item-index">{{ index + 1 }}</span>
              <div class="item-details">
                <h4>{{ episode.part }}</h4>
              </div>
              <span class="item-duration">{{ parseDuration(episode.duration) }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <Transition name="player-zoom">
      <div
        v-if="playerStore.showPlayerPage && currentTrack"
        class="player-page"
        :class="{ active: playerStore.showPlayerPage, 'no-visualizer': !settingsStore.audioVisualizerEnabled }"
        @click="closePlayerPage"
      >
      <!-- 音频可视化关闭时用当前歌曲封面作全屏模糊背景（所有主题通用） -->
      <div v-if="!settingsStore.audioVisualizerEnabled" class="player-page-cover-bg" aria-hidden="true">
        <img
          class="player-page-cover-bg__img"
          :src="coverBgUrl"
          :key="coverBgUrl"
          loading="lazy"
          decoding="async"
          @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=1200'"
        />
      </div>

      <!-- 左上角：返回 -->
      <button class="back-btn" @click.stop="closePlayerPage">
        <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
        <span>返回</span>
      </button>

      <!-- 音频频谱可视化：开关关闭时不渲染，避免空 canvas 占位 -->
      <AudioVisualizer
        v-if="settingsStore.audioVisualizerEnabled"
        :enabled="settingsStore.audioVisualizerEnabled"
      />

      <div class="player-page-content" @click.stop>
        <button v-if="currentSeries" class="series-toggle-btn" @click="toggleSeriesPanel">
          <span>📋 合集</span>
          <span class="series-count">{{ currentSeries.episodes.length }}</span>
        </button>

        <div
          class="player-page-layout"
          :class="{ 'player-page-layout--solo': !lyricStore.showLyricPanel }"
        >
          <!-- 左侧：封面 + 标题 + 进度 + 控制 -->
          <div class="player-page-left">
            <div class="album-art-zone">
              <div ref="albumArtRef" class="album-art">
                <img :src="fixCoverUrl(currentTrack.cover)" :alt="currentTrack.title" loading="lazy" decoding="async" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
              </div>
              <!-- 音频波纹：随低音能量从封面中心向外扩散，开关关闭时不渲染 -->
              <AlbumRipple
                v-if="settingsStore.audioVisualizerEnabled"
                :intensity="settingsStore.audioVisualizerIntensity"
              />
            </div>

            <div class="track-info">
              <h2>{{ currentTrack.title || '未知标题' }}</h2>
              <h3>{{ currentTrack.author || '未知作者' }}</h3>
            </div>

            <div class="big-progress">
              <div class="progress-container">
                <span class="progress-time">{{ parseDuration(currentTime) }}</span>
                <div class="progress-bar-wrapper" :class="{ seeking: isSeeking }">
                  <input
                    type="range"
                    min="0"
                    :max="duration || 100"
                    :value="currentTime"
                    @input="onProgressInput"
                    @change="onProgressChange"
                    @pointerdown="onSeekStart"
                    @pointerup="onSeekEnd"
                    @pointercancel="onSeekEnd"
                    class="progress-slider"
                  >
                  <div class="progress-bar">
                    <div class="progress-fill" :style="{ width: (duration > 0 ? (currentTime / duration) * 100 : 0) + '%' }"></div>
                    <div class="buffered-fill" :style="{ width: bufferedProgress + '%' }"></div>
                  </div>
                </div>
                <span class="progress-time">{{ parseDuration(duration) }}</span>
              </div>

              <!-- 下载缓存进度 -->
              <div v-if="isDownloading" class="download-progress">
                <div class="download-progress-bar">
                  <div class="download-progress-fill" :style="{ width: downloadProgress + '%' }"></div>
                </div>
                <span class="download-progress-text">缓存中 {{ downloadProgress }}%</span>
              </div>
            </div>

            <div class="big-control-buttons">
              <div class="big-control-row">
                <div class="big-control-side big-control-side--left">
                  <button @click="togglePlayMode" class="big-control-btn" :class="{ active: playMode !== 'order' }" :title="getPlayModeLabel()">
                    <span class="mode-icon" v-html="getPlayModeIcon()"></span>
                  </button>
                  <button @click="playPrevious" class="big-control-btn">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
                  </button>
                </div>
                <button @click="togglePlayPause" class="big-control-btn play">
                  <svg v-if="isPlaying" viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
                  <svg v-else viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <div class="big-control-side big-control-side--right">
                  <button @click="playNext" class="big-control-btn">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
                  </button>
                  <!-- 显示/隐藏歌词：放在控制按钮行最右侧 -->
                  <button
                    class="big-control-btn lyric-toggle-btn-inline"
                    :class="{ active: lyricStore.showLyricPanel }"
                    :title="lyricStore.showLyricPanel ? '隐藏歌词' : '显示歌词'"
                    :aria-label="lyricStore.showLyricPanel ? '隐藏歌词' : '显示歌词'"
                    :aria-pressed="lyricStore.showLyricPanel"
                    @click="toggleLyricPanel"
                  >
                    <span class="lyric-toggle-char" aria-hidden="true">词</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- 右侧：歌词 -->
          <div v-if="lyricStore.showLyricPanel" class="player-page-right">
            <LyricDisplay
              :currentTime="currentTime"
              :onSeek="handleLyricSeek"
              :large="true"
            />
          </div>
        </div>

        <div v-if="showSeriesPanel && currentSeries" class="series-panel">
          <div class="series-header">
            <h3>{{ currentSeries.title }}</h3>
            <button class="close-series-btn" @click="toggleSeriesPanel">×</button>
          </div>
          <div class="series-list">
            <div
              v-for="(episode, index) in currentSeries.episodes"
              :key="episode.cid"
              class="series-item"
              :class="{ active: episode.cid === currentTrack?.cid }"
              @click="playFromSeries(episode)"
            >
              <span class="series-index">{{ index + 1 }}</span>
              <span class="series-title">{{ episode.title || '第' + (index + 1) + '集' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 旧版 showThemePanel 主题面板已迁移到 MineView 设置 tab -->

    <div v-if="showCreatePlaylistModal" class="modal-overlay modal-overlay--top" @click="cancelCreatePlaylist">
      <div class="modal" @click.stop>
        <h2>创建歌单</h2>
        <div class="form-group">
          <label for="playlist-name">歌单名称</label>
          <input
            type="text"
            id="playlist-name"
            v-model="newPlaylistName"
            placeholder="请输入歌单名称"
            @keyup.enter="confirmCreatePlaylist"
          >
        </div>
        <div class="modal-buttons">
          <button class="modal-btn cancel" @click="cancelCreatePlaylist">
            取消
          </button>
          <button class="modal-btn confirm" @click="confirmCreatePlaylist">
            创建
          </button>
        </div>
      </div>
    </div>

    <div v-if="showRenameModal" class="modal-overlay modal-overlay--top" @click="cancelRenamePlaylist">
      <div class="modal" @click.stop>
        <h2>重命名歌单</h2>
        <div class="form-group">
          <label for="rename-playlist-name">歌单名称</label>
          <input
            type="text"
            id="rename-playlist-name"
            v-model="renameValue"
            placeholder="请输入歌单名称"
            @keyup.enter="confirmRenamePlaylist"
          >
        </div>
        <div class="modal-buttons">
          <button class="modal-btn cancel" @click="cancelRenamePlaylist">
            取消
          </button>
          <button class="modal-btn confirm" @click="confirmRenamePlaylist">
            保存
          </button>
        </div>
      </div>
    </div>

    <div v-if="showAddToPlaylistModal" class="modal-overlay" @click="addToPlaylistTarget = null; showAddToPlaylistModal = false">
      <div class="modal" @click.stop>
        <h2>添加到歌单</h2>
        <div class="playlist-list-modal">
          <div
            v-for="playlist in playlistStore.userPlaylists"
            :key="playlist.id"
            class="playlist-modal-item"
            @click="addToPlaylist(playlist)"
          >
            <span>{{ playlist.name }}</span>
            <span class="playlist-count">{{ playlist.music.length }} 首</span>
          </div>
          <div v-if="playlistStore.userPlaylists.length === 0" class="empty-list">
            <p>暂无歌单，请先创建</p>
          </div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn cancel" @click="addToPlaylistTarget = null; showAddToPlaylistModal = false">
            关闭
          </button>
        </div>
      </div>
    </div>

    <div v-if="showBatchAddToPlaylistModal" class="modal-overlay" @click="showBatchAddToPlaylistModal = false">
      <div class="modal" @click.stop>
        <h2>添加到歌单</h2>
        <p class="batch-add-hint">已选 {{ selectedTrackKeys.size }} 首歌曲，选择要加入的歌单</p>
        <div class="playlist-list-modal">
          <div
            v-for="playlist in playlistStore.userPlaylists"
            :key="playlist.id"
            class="playlist-modal-item"
            :class="{ 'is-current': isCurrentPlaylist(playlist) }"
            :title="isCurrentPlaylist(playlist) ? '当前歌单' : `添加到「${playlist.name}」`"
            @click="!isCurrentPlaylist(playlist) && batchAddToPlaylist(playlist)"
          >
            <span>
              {{ playlist.name }}
              <span v-if="isCurrentPlaylist(playlist)" class="playlist-modal-item-tag">当前歌单</span>
            </span>
            <span class="playlist-count">{{ playlist.music.length }} 首</span>
          </div>
          <div v-if="playlistStore.userPlaylists.filter(p => p.id !== currentPlaylist?.id).length === 0" class="empty-list">
            <p>暂无其它歌单，请先创建</p>
          </div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn cancel" @click="showBatchAddToPlaylistModal = false">
            关闭
          </button>
        </div>
      </div>
    </div>

    <!-- 主页/搜索页多分P视频：一体式勾选分P + 选择目标歌单 -->
    <div v-if="showAddPModal" class="modal-overlay" @click="showAddPModal = false">
      <div class="modal" @click.stop>
        <div class="p-modal-header">
          <div class="p-modal-title-wrap">
            <h2>添加到歌单</h2>
            <p class="p-modal-subtitle">{{ pendingAddMusic?.title }}<span v-if="pendingEpisodes.length > 1">（共 {{ pendingEpisodes.length }} P）</span></p>
          </div>
          <button
            @click="isAllPsSelected() ? (selectedPKeys = new Set()) : selectAllPs()"
            class="playlist-action-btn"
            :title="isAllPsSelected() ? '取消全选' : '全选所有分P'"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
            <span>{{ isAllPsSelected() ? '取消全选' : '全选' }}</span>
          </button>
        </div>
        <div v-if="isLoadingPList" class="p-select-loading">
          <div class="loading-spinner"></div>
          <p>加载分P列表...</p>
        </div>
        <div v-else class="p-select-list">
          <div
            v-for="(episode, index) in pendingEpisodes"
            :key="episode.cid"
            class="p-select-row"
            :class="{ 'is-selected': selectedPKeys.has(episode.cid) }"
            @click="togglePSelection(episode.cid)"
          >
            <span
              class="p-select-checkbox"
              :class="{ checked: selectedPKeys.has(episode.cid) }"
              @click.stop="togglePSelection(episode.cid)"
            >
              <svg v-if="selectedPKeys.has(episode.cid)" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
            </span>
            <span class="p-select-index">{{ index + 1 }}</span>
            <span class="p-select-part">{{ episode.part }}</span>
            <span class="p-select-duration">{{ parseDuration(episode.duration) }}</span>
          </div>
          <div v-if="pendingEpisodes.length === 0" class="empty-list">
            <p>未获取到分P列表</p>
          </div>
        </div>
        <div class="p-add-to-section">
          <div class="p-add-to-header">
            <span>已选 {{ selectedPKeys.size }} / {{ pendingEpisodes.length }} P</span>
            <button
              class="p-create-all-btn"
              @click="createPlaylistWithPs('all')"
              title="创建以视频标题命名的新歌单，并加入全部P"
            >
              <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>新建歌单（全部P）</span>
            </button>
          </div>
          <div class="p-add-to-list">
            <div
              class="playlist-modal-item"
              @click="createPlaylistWithPs('selected')"
              title="创建新歌单并加入已勾选的P"
            >
              <span>
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="margin-right: 8px; vertical-align: -2px;"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
                新建歌单（加入已勾选的P）
              </span>
            </div>
            <div
              v-for="playlist in playlistStore.userPlaylists"
              :key="playlist.id"
              class="playlist-modal-item"
              :title="`添加到「${playlist.name}」`"
              @click="addSelectedPsToPlaylist(playlist)"
            >
              <span>{{ playlist.name }}</span>
              <span class="playlist-count">{{ playlist.music.length }} 首</span>
            </div>
            <div v-if="playlistStore.userPlaylists.length === 0" class="empty-list">
              <p>暂无歌单，可通过上方"新建歌单"创建</p>
            </div>
          </div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn cancel" @click="showAddPModal = false">
            关闭
          </button>
        </div>
      </div>
    </div>

    <!-- 设置面板已迁移至 MineView 中 -->

    <!-- 首次启动引导（onboardingCompleted 为 false 时自显示） -->
    <OnboardingGuide />

    <DownloadManager />

    <LoginPanel
      :visible="showLoginPanel"
      @update:visible="(val) => showLoginPanel = val"
      @login-success="handleLoginSuccess"
      @sync-favorites="handleSyncFavorites"
    />

    <AppDock />
  </div>
</template>