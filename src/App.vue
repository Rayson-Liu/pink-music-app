<script setup>
import { ref, onMounted, computed } from 'vue'
import { parseDuration, formatPlayCount } from './utils/bilibili.js'

// Helper function to strip HTML tags
function stripHtmlTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

// Helper function to fix cover URL
function fixCoverUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) {
    return 'https:' + url;
  }
  return url;
}

// Media Session API for system media controls
function updateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  
  const music = currentTrack.value;
  if (!music) return;
  
  navigator.mediaSession.metadata = new MediaMetadata({
    title: music.title || '未知标题',
    artist: music.author || '未知作者',
    album: 'Pink Music',
    artwork: [
      {
        src: fixCoverUrl(music.cover) || '',
        sizes: '256x256',
        type: 'image/jpeg'
      }
    ]
  });
  
  // Update playback state
  navigator.mediaSession.playbackState = isPlaying.value ? 'playing' : 'paused';
}

function setupMediaSessionHandlers() {
  if (!('mediaSession' in navigator)) return;
  
  navigator.mediaSession.setActionHandler('play', () => {
    togglePlay()
  });
  
  navigator.mediaSession.setActionHandler('pause', () => {
    togglePlay()
  });
  
  navigator.mediaSession.setActionHandler('previoustrack', () => {
    playPrevious()
  });
  
  navigator.mediaSession.setActionHandler('nexttrack', () => {
    playNext()
  });
}

const currentTheme = ref(localStorage.getItem('pink-music-theme') || 'dark')
const currentColor = ref(localStorage.getItem('pink-music-color') || 'pink')
const currentView = ref('home')
const searchQuery = ref('')
const isSearching = ref(false)
const searchResults = ref([])
const isLoadingSearch = ref(false)
const recommendedMusic = ref([])
const isLoadingRecommended = ref(false)
const userPlaylists = ref([])
const currentPlaylist = ref(null)
const currentTrack = ref(null)
const isPlaying = ref(false)
const showPlayerPage = ref(false)
const audioElement = ref(null)
const currentTime = ref(0)
const duration = ref(0)
const isLoggedIn = ref(false)
const showLoginModal = ref(false)
const qrcodeImage = ref('')
const qrcodeKey = ref('')
const loginStatus = ref('')
const bilibiliFavorites = ref([])
const showThemePanel = ref(false)
const loginError = ref('')
const isAudioLoading = ref(false)
const audioError = ref('')
const playHistory = ref([])
const bufferedProgress = ref(0)
const showCreatePlaylistModal = ref(false)
const newPlaylistName = ref('')
const currentSeries = ref(null)
const showSeriesPanel = ref(false)
const downloadProgress = ref(0)
const isDownloading = ref(false)
let downloadMonitorInterval = null
const showPlaylistManager = ref(false)
const showAddToPlaylistModal = ref(false)
const currentVideoEpisodes = ref([])
const isLoadingEpisodes = ref(false)
const currentEpisodeIndex = ref(0)

const playMode = ref('order')
const playModes = [
  { value: 'order', icon: '🔁', label: '顺序播放' },
  { value: 'loop', icon: '🔃', label: '列表循环' },
  { value: 'single', icon: '🔂', label: '单曲循环' },
  { value: 'shuffle', icon: '🔀', label: '随机播放' }
]

const colorOptions = [
  { value: 'pink', label: '粉色' },
  { value: 'purple', label: '紫色' },
  { value: 'blue', label: '蓝色' },
  { value: 'green', label: '绿色' },
  { value: 'orange', label: '橙色' }
]

function toggleTheme() {
  showThemePanel.value = !showThemePanel.value
}

function setTheme(mode) {
  currentTheme.value = mode
  localStorage.setItem('pink-music-theme', mode)
  document.documentElement.setAttribute('data-theme', mode)
  showThemePanel.value = false
}

function setColor(color) {
  currentColor.value = color
  localStorage.setItem('pink-music-color', color)
  document.documentElement.setAttribute('data-color', color)
}

function goToHome() {
  currentView.value = 'home'
  loadRecommendedMusic()
}

function goToSearch() {
  currentView.value = 'search'
}

async function goToPlaylist(playlist) {
  currentPlaylist.value = playlist
  currentView.value = 'playlist'
  
  // 如果是B站收藏夹，加载收藏夹内容
  if (playlist.id && !playlist.music) {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.getFavoriteMedia(playlist.id)
        if (result.code === 0 && result.data?.media_list) {
          currentPlaylist.value.music = result.data.media_list.map((item, index) => ({
            bvid: item.bvid,
            aid: item.id,
            title: item.title,
            author: item.upper?.name || '未知作者',
            cover: fixCoverUrl(item.cover),
            duration: item.duration || 180,
            playCount: item.play || 0,
            pubdate: item.pubtime,
            description: item.intro || ''
          }))
        }
      } else {
        console.log('收藏夹功能仅在桌面版可用')
      }
    } catch (error) {
      console.error('加载收藏夹内容失败:', error)
    }
  }
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
        
        // 随机打乱结果
        const shuffledMusic = [...musicList].sort(() => 0.5 - Math.random())
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
          pubdate: item.pubdate
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
  }
}

function getRandomIndex(max) {
  return Math.floor(Math.random() * max)
}

function getNextMusicIndex() {
  let musicList = currentView.value === 'search' ? searchResults.value : recommendedMusic.value
  if (currentPlaylist.value?.music) {
    musicList = currentPlaylist.value.music
  }

  if (!musicList || musicList.length === 0) return -1

  const currentIndex = musicList.findIndex(m => m.bvid === currentTrack.value?.bvid)

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

async function playMusic(music) {
  console.log('开始播放:', music.title)
  currentTrack.value = music
  isPlaying.value = false
  isAudioLoading.value = true
  audioError.value = ''
  duration.value = music.duration || 180
  currentTime.value = 0
  bufferedProgress.value = 0

  // 添加到播放历史
  addToPlayHistory(music)

  // 尝试加载视频合集
  loadVideoSeries(music.bvid)

  // 更新系统媒体控制
  updateMediaSession()

  if (audioElement.value) {
    try {
      // 只有在音频正在播放时才调用pause()
      if (!audioElement.value.paused) {
        audioElement.value.pause()
      }
    } catch (error) {
      console.error('暂停音频失败:', error)
    }
    audioElement.value.src = ''
    audioElement.value = null
  }

  audioElement.value = new Audio()
  audioElement.value.crossOrigin = 'anonymous'

  let audioSrc = null

  try {
    // 通过 electronAPI 获取视频详细信息
    let musicInfoResult
    if (window.electronAPI) {
      musicInfoResult = await window.electronAPI.getMusicInfo(music.bvid)
    }

    if (musicInfoResult?.code === 0) {
      const musicInfo = musicInfoResult.data

      // 通过 electronAPI 获取视频播放地址
      let playUrlResult
      if (window.electronAPI) {
        playUrlResult = await window.electronAPI.getMusicPlayUrl(music.bvid, music.cid || musicInfo.cid)
      }

      if (playUrlResult?.code === 0) {
        console.log('获取到播放地址')
        
        // 从DASH格式中获取音频地址
        if (playUrlResult.data.dash && playUrlResult.data.dash.audio && playUrlResult.data.dash.audio.length > 0) {
          audioSrc = playUrlResult.data.dash.audio[0].baseUrl
        } else if (playUrlResult.data.durl && playUrlResult.data.durl.length > 0) {
          // 回退到FLV格式
          audioSrc = playUrlResult.data.durl[0].url
        }
        
        console.log('使用音频地址:', audioSrc)
      }
    }
  } catch (error) {
    console.error('获取B站音频失败:', error)
  }

  if (!audioSrc) {
    audioSrc = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
    console.log('使用备用音频源')
  }

  audioElement.value.src = audioSrc

  // 开始监控下载进度
  startDownloadProgressMonitor(music.bvid)

  audioElement.value.addEventListener('loadedmetadata', () => {
    console.log('音频加载完成，时长:', audioElement.value.duration)
    duration.value = audioElement.value.duration || music.duration || 180
    isAudioLoading.value = false
  })

  audioElement.value.addEventListener('timeupdate', () => {
    if (audioElement.value) {
      currentTime.value = audioElement.value.currentTime
      // 更新缓冲进度
      updateBufferedProgress()
    }
  })

  audioElement.value.addEventListener('ended', () => {
    console.log('音频播放结束')
    isPlaying.value = false
    updateMediaSession()
    handleTrackEnd()
  })

  audioElement.value.addEventListener('error', (e) => {
    console.error('音频加载错误:', e)
    audioError.value = '音频加载失败'
    isAudioLoading.value = false
  })

  audioElement.value.addEventListener('canplaythrough', () => {
    console.log('音频可以播放')
    isAudioLoading.value = false
    bufferedProgress.value = 100
  })

  audioElement.value.volume = 1.0

  try {
    await audioElement.value.play()
    isPlaying.value = true
    updateMediaSession()
    console.log('音乐播放成功')
  } catch (error) {
    console.error('播放失败:', error)
    isAudioLoading.value = false
  }

  showPlayerPage.value = true
}

function updateBufferedProgress() {
  if (audioElement.value && audioElement.value.buffered.length > 0) {
    const bufferedEnd = audioElement.value.buffered.end(audioElement.value.buffered.length - 1)
    const duration = audioElement.value.duration || 1
    bufferedProgress.value = Math.round((bufferedEnd / duration) * 100)
  }
}

async function loadVideoSeries(bvid) {
  try {
    // 获取视频详细信息，包含合集信息
    const result = await getWebInterfaceView({ bvid: bvid })
    if (result.code === 0 && result.data.pages && result.data.pages.length > 1) {
      // 构建合集信息
      currentSeries.value = {
        id: bvid,
        title: result.data.title,
        cover: fixCoverUrl(result.data.pic),
        episodes: result.data.pages.map((page, index) => ({
          bvid: bvid,
          cid: page.cid,
          title: page.part,
          duration: page.duration,
          cover: fixCoverUrl(page.first_frame)
        }))
      }
      showSeriesPanel.value = true
      console.log('加载视频合集成功:', result.data.title, '共', result.data.pages.length, '集')
    } else {
      currentSeries.value = null
      showSeriesPanel.value = false
    }
  } catch (error) {
    console.error('加载视频合集失败:', error)
    currentSeries.value = null
    showSeriesPanel.value = false
  }
}

function playFromSeries(episode) {
  playMusic({
    bvid: episode.bvid,
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

function handleTrackEnd() {
  // Check if current track has episodes
  if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
    let nextEpisodeIndex
    
    if (playMode.value === 'shuffle') {
      // Random episode
      do {
        nextEpisodeIndex = getRandomIndex(currentVideoEpisodes.value.length)
      } while (currentVideoEpisodes.value.length > 1 && nextEpisodeIndex === currentEpisodeIndex.value)
    } else {
      // Next episode, wrap around
      nextEpisodeIndex = (currentEpisodeIndex.value + 1) % currentVideoEpisodes.value.length
    }
    
    const nextEpisode = currentVideoEpisodes.value[nextEpisodeIndex]
    if (nextEpisode) {
      playEpisode(nextEpisode)
    } else {
      isPlaying.value = false
    }
  } else {
    // Normal song navigation
    const nextIndex = getNextMusicIndex()
    let musicList = currentView.value === 'search' ? searchResults.value : recommendedMusic.value
    if (currentPlaylist.value?.music) {
      musicList = currentPlaylist.value.music
    }

    if (nextIndex >= 0 && musicList && musicList[nextIndex]) {
      playMusic(musicList[nextIndex])
    } else {
      isPlaying.value = false
    }
  }
}

function togglePlayMode() {
  const modes = ['order', 'loop', 'single', 'shuffle']
  const currentIndex = modes.indexOf(playMode.value)
  playMode.value = modes[(currentIndex + 1) % modes.length]
}
function getPlayModeIcon() {
  const mode = playModes.find(m => m.value === playMode.value)
  return mode ? mode.icon : playModes[0].icon
}

function getPlayModeLabel() {
  const mode = playModes.find(m => m.value === playMode.value)
  return mode ? mode.label : '顺序播放'
}

function togglePlayPause() {
  if (!audioElement.value) return

  if (isPlaying.value) {
    audioElement.value.pause()
  } else {
    audioElement.value.play()
  }
  isPlaying.value = !isPlaying.value
  updateMediaSession()
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
    let musicList = currentView.value === 'search' ? searchResults.value : recommendedMusic.value
    if (currentPlaylist.value?.music) {
      musicList = currentPlaylist.value.music
    }

    if (!musicList || musicList.length === 0) return

    const currentIndex = musicList.findIndex(m => m.bvid === currentTrack.value?.bvid)
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
  // Check if current track has episodes
  if (currentTrack.value && currentVideoEpisodes.value.length > 0) {
    let nextEpisodeIndex
    
    if (playMode.value === 'shuffle') {
      // Random episode
      do {
        nextEpisodeIndex = getRandomIndex(currentVideoEpisodes.value.length)
      } while (currentVideoEpisodes.value.length > 1 && nextEpisodeIndex === currentEpisodeIndex.value)
    } else {
      // Next episode, wrap around
      nextEpisodeIndex = (currentEpisodeIndex.value + 1) % currentVideoEpisodes.value.length
    }
    
    const nextEpisode = currentVideoEpisodes.value[nextEpisodeIndex]
    if (nextEpisode) {
      playEpisode(nextEpisode)
    }
  } else {
    // Normal song navigation
    const nextIndex = getNextMusicIndex()
    let musicList = currentView.value === 'search' ? searchResults.value : recommendedMusic.value
    if (currentPlaylist.value?.music) {
      musicList = currentPlaylist.value.music
    }

    if (nextIndex >= 0 && musicList && musicList[nextIndex]) {
      playMusic(musicList[nextIndex])
    }
  }
}

function onProgressInput(event) {
  const newTime = parseFloat(event.target.value)
  if (audioElement.value && !isNaN(newTime)) {
    audioElement.value.currentTime = newTime
    currentTime.value = newTime
  }
}

function onProgressChange(event) {
  const newTime = parseFloat(event.target.value)
  if (audioElement.value && !isNaN(newTime)) {
    audioElement.value.currentTime = newTime
    currentTime.value = newTime
  }
}

function createPlaylist() {
  showCreatePlaylistModal.value = true
  newPlaylistName.value = ''
}

function confirmCreatePlaylist() {
  if (newPlaylistName.value.trim()) {
    userPlaylists.value.push({
      id: Date.now(),
      name: newPlaylistName.value.trim(),
      music: []
    })
    savePlaylists()
    showCreatePlaylistModal.value = false
  }
}

function cancelCreatePlaylist() {
  showCreatePlaylistModal.value = false
  newPlaylistName.value = ''
}

function openAddToPlaylistModal() {
  if (!currentTrack.value) return
  showAddToPlaylistModal.value = true
}

function addToPlaylist(playlist) {
  if (!currentTrack.value || !playlist) return
  const music = { ...currentTrack.value }
  if (!playlist.music) {
    playlist.music = []
  }
  const exists = playlist.music.some(m => m.bvid === music.bvid && m.cid === music.cid)
  if (!exists) {
    playlist.music.push(music)
    savePlaylists()
  }
  showAddToPlaylistModal.value = false
}

async function downloadMusic(music) {
  try {
    isAudioLoading.value = true
    
    // Get music info if needed
    let musicInfoResult
    if (!music.cid) {
      musicInfoResult = await window.electronAPI.getMusicInfo(music.bvid)
      if (musicInfoResult.code !== 0) {
        throw new Error('获取音乐信息失败')
      }
    }
    const cid = music.cid || musicInfoResult?.data?.cid
    
    // Get play URL
    const playUrlResult = await window.electronAPI.getMusicPlayUrl(music.bvid, cid)
    if (playUrlResult.code !== 0) {
      throw new Error('获取播放地址失败')
    }
    
    const audioUrl = playUrlResult.data.dash.audio[0].baseUrl
    if (!audioUrl) {
      throw new Error('未找到音频地址')
    }
    
    // Download the audio
    const downloadResult = await window.electronAPI.downloadAudio(audioUrl, `${music.title} - ${music.author}`)
    if (downloadResult.code === 0) {
      console.log('下载成功:', downloadResult.data)
      // Show success message
      alert('下载成功！文件保存在：' + downloadResult.data)
    } else {
      throw new Error(downloadResult.message || '下载失败')
    }
  } catch (error) {
    console.error('下载音乐失败:', error)
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

function savePlaylists() {
  localStorage.setItem('pink-music-playlists', JSON.stringify(userPlaylists.value))
}

function loadPlaylists() {
  const saved = localStorage.getItem('pink-music-playlists')
  if (saved) {
    userPlaylists.value = JSON.parse(saved)
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

function importPlaylist() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json'
  input.onchange = (e) => {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (event) => {
      try {
        const imported = JSON.parse(event.target.result)
        if (imported.name && Array.isArray(imported.music)) {
          const newPlaylist = {
            id: Date.now(),
            name: imported.name,
            cover: imported.cover || '',
            music: imported.music
          }
          userPlaylists.value.push(newPlaylist)
          savePlaylists()
        }
      } catch (error) {
        console.error('导入歌单失败:', error)
      }
    }
    reader.readAsText(file)
  }
  input.click()
}

function savePlayHistory() {
  // 只保存最近50首
  const historyToSave = playHistory.value.slice(0, 50)
  localStorage.setItem('pink-music-history', JSON.stringify(historyToSave))
}

function loadPlayHistory() {
  const saved = localStorage.getItem('pink-music-history')
  if (saved) {
    playHistory.value = JSON.parse(saved)
  }
}

function addToPlayHistory(music) {
  // 移除重复项
  playHistory.value = playHistory.value.filter(item => item.bvid !== music.bvid)
  // 添加到开头
  playHistory.value.unshift(music)
  // 保存到本地存储
  savePlayHistory()
}

function clearPlayHistory() {
  playHistory.value = []
  savePlayHistory()
}

async function showLoginQRCode() {
  showLoginModal.value = true
  loginStatus.value = '生成二维码中...'
  loginError.value = ''

  try {
    // 调用Electron的登录二维码生成功能
    if (window.electronAPI) {
      const result = await window.electronAPI.getLoginQRCode()
      if (result.code === 0) {
        qrcodeImage.value = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(result.data.url)}`
        qrcodeKey.value = result.data.qrcode_key
        loginStatus.value = '请使用B站客户端扫描二维码'
        startLoginPolling()
      } else {
        loginStatus.value = ''
        loginError.value = result.message || '生成二维码失败'
      }
    } else {
      loginStatus.value = ''
      loginError.value = '登录功能仅在桌面版可用'
    }
  } catch (error) {
    console.error('获取登录二维码失败:', error)
    loginStatus.value = ''
    loginError.value = '网络错误'
  }
}

function startLoginPolling() {
  const pollInterval = setInterval(async () => {
    if (!qrcodeKey.value) {
      clearInterval(pollInterval)
      return
    }

    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.checkLoginStatus(qrcodeKey.value)
        console.log('登录状态检查:', result)

        if (result.code === 0) {
          if (result.data.code === 0) {
            loginStatus.value = '登录成功!'
            isLoggedIn.value = true
            if (result.data.url) {
              // 提取Cookies
              try {
                const url = new URL(result.data.url)
                const searchParams = url.searchParams
                const cookies = {}
                const cookieParams = ['bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA']
                cookieParams.forEach(param => {
                  const value = searchParams.get(param)
                  if (value) {
                    cookies[param] = value
                  }
                })
                if (cookies.bili_jct) {
                  await window.electronAPI.setCookies(cookies)
                }
              } catch (e) {
                console.error('解析Cookie失败:', e)
              }
            }
            await loadBilibiliFavorites()
            setTimeout(() => {
              showLoginModal.value = false
            }, 1000)
            clearInterval(pollInterval)
          } else {
            switch (result.data.code) {
              case 86101:
                loginStatus.value = '请扫描二维码'
                break
              case 86090:
                loginStatus.value = '请在手机上确认登录'
                break
              case 86038:
                loginStatus.value = ''
                loginError.value = '二维码已失效，请重新生成'
                clearInterval(pollInterval)
                break
              default:
                loginStatus.value = result.data.message || '等待扫码...'
            }
          }
        } else {
          loginStatus.value = ''
          loginError.value = result.message || '网络错误'
          clearInterval(pollInterval)
        }
      } else {
        loginStatus.value = ''
        loginError.value = '登录功能仅在桌面版可用'
        clearInterval(pollInterval)
      }
    } catch (error) {
      console.error('检查登录状态失败:', error)
      loginError.value = '网络错误'
      clearInterval(pollInterval)
    }
  }, 2000)
}

function logout() {
  isLoggedIn.value = false
  bilibiliFavorites.value = []
  if (window.electronAPI) {
    window.electronAPI.setCookies({})
  }
}

async function refreshBilibiliFavorites() {
  if (isLoggedIn.value) {
    await loadBilibiliFavorites()
  }
}

async function loadBilibiliFavorites() {
  console.log('加载B站收藏夹')
  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.getFavorites()
      console.log('收藏夹结果:', result)
      if (result.code === 0 && result.data?.list) {
        bilibiliFavorites.value = result.data.list.map((item, index) => ({
          id: item.id,
          name: item.title,
          cover: fixCoverUrl(item.cover),
          media_count: item.media_count || 0
        }))
      } else {
        console.log('获取收藏夹失败:', result.message || '无收藏夹数据')
        bilibiliFavorites.value = []
      }
    } else {
      console.log('收藏夹功能仅在桌面版可用')
      bilibiliFavorites.value = []
    }
  } catch (error) {
    console.error('加载收藏夹失败:', error)
    bilibiliFavorites.value = []
  }
}

onMounted(() => {
  document.documentElement.setAttribute('data-theme', currentTheme.value)
  document.documentElement.setAttribute('data-color', currentColor.value)
  loadPlaylists()
  loadPlayHistory()
  loadRecommendedMusic()
  setupMediaSessionHandlers()
})
</script>

<template>
  <div class="app-container">
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="logo">Pink Music</h1>
        <button class="theme-toggle" @click="toggleTheme" title="主题设置">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
        </button>
      </div>

      <nav>
        <button class="nav-item" @click="goToHome" :class="{ active: currentView === 'home' }">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z"/></svg>
          <span>首页</span>
        </button>

        <button class="nav-item" @click="goToSearch" :class="{ active: currentView === 'search' }">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>
          <span>搜索</span>
        </button>

        <div class="nav-section">
          <h3>我的歌单</h3>
          <div class="playlist-nav-buttons">
            <button class="nav-item" @click="createPlaylist">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>
              <span>创建</span>
            </button>
            <button class="nav-item" @click="importPlaylist">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z"/></svg>
              <span>导入</span>
            </button>
          </div>
          <button class="nav-item" @click="openDownloadFolder">
            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
            <span>下载</span>
          </button>
          <button
            v-for="playlist in userPlaylists"
            :key="playlist.id"
            class="playlist-item"
            @click="goToPlaylist(playlist)"
            :class="{ playing: currentPlaylist?.id === playlist.id && currentView === 'playlist' }"
          >
            <span>{{ playlist.name }}</span>
            <span class="playlist-count">{{ playlist.music.length }}</span>
          </button>

          <!-- <div v-if="isLoggedIn" class="nav-section">
            <div class="section-header">
              <h3>B站收藏夹</h3>
              <button class="refresh-btn" @click="refreshBilibiliFavorites" title="刷新收藏夹">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                  <path d="M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
                </svg>
              </button>
            </div>
            <button
              v-for="favorite in bilibiliFavorites"
              :key="favorite.id"
              class="playlist-item"
              @click="goToPlaylist(favorite)"
              :class="{ playing: currentPlaylist?.id === favorite.id && currentView === 'playlist' }"
            >
              <span>{{ favorite.name }}</span>
              <span class="playlist-count">{{ favorite.media_count }}</span>
            </button>
          </div> -->

          <div class="nav-section">
            <div class="section-header">
              <h3>播放历史</h3>
              <button v-if="playHistory.length > 0" class="refresh-btn" @click="clearPlayHistory" title="清空历史">
                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
                  <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
                </svg>
              </button>
            </div>
            <button
              v-if="playHistory.length === 0"
              class="playlist-item disabled"
            >
              <span>暂无播放历史</span>
            </button>
            <button
              v-for="(music, index) in playHistory.slice(0, 10)"
              :key="music.bvid"
              class="playlist-item"
              @click="playMusic(music)"
            >
              <span>{{ music.title }}</span>
              <span class="playlist-count">{{ index + 1 }}</span>
            </button>
          </div>
        </div>

        <!-- <button class="nav-item" @click="isLoggedIn ? logout() : showLoginQRCode()">
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
          <span>{{ isLoggedIn ? '退出登录' : '登录B站' }}</span>
        </button> -->
      </nav>
    </aside>

    <main class="main-content">
      <section v-if="currentView === 'home'" class="home-section">
        <div class="hero-section">
          <h2 class="text-gradient">欢迎使用 Pink Music</h2>
          <p>从 B 站发现并播放你喜欢的音乐</p>
        </div>

        <div class="recommended-section">
          <h3>推荐音乐</h3>
          <div v-if="isLoadingRecommended" class="loading">
            <div class="loading-spinner"></div>
            <p>加载中...</p>
          </div>
          <div v-else-if="recommendedMusic.length === 0" class="loading">
            <p>暂无推荐音乐</p>
          </div>
          <div v-else class="card-grid">
            <div
              v-for="music in recommendedMusic"
              :key="music.bvid"
              class="music-card"
              @click="playMusic(music)"
            >
              <div class="card-cover">
                <img :src="music.cover" :alt="music.title" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
                <div class="play-overlay">
                  <button class="play-button" @click.stop="playMusic(music)">
                    <svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>
                  </button>
                  <button class="download-button" @click.stop="downloadMusic(music)" title="下载">
                    <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
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

      <section v-else-if="currentView === 'search'" class="search-section">
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

        <div v-if="isLoadingSearch" class="loading">
          <div class="loading-spinner"></div>
          <p>搜索中...</p>
        </div>
        <div v-else-if="isSearching && searchResults.length === 0" class="loading">
          <p>未找到相关音乐</p>
        </div>
        <div v-else-if="isSearching" class="card-grid">
          <div
            v-for="music in searchResults"
            :key="music.bvid"
            class="music-card"
            @click="playMusic(music)"
          >
            <div class="card-cover">
              <img :src="music.cover" :alt="music.title" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
              <div class="play-overlay">
                <button class="play-button" @click.stop="playMusic(music)">
                  <svg viewBox="0 0 24 24" fill="white" width="24" height="24"><path d="M8 5v14l11-7z"/></svg>
                </button>
                <button class="download-button" @click.stop="downloadMusic(music)" title="下载">
                  <svg viewBox="0 0 24 24" fill="white" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
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

      <section v-else-if="currentView === 'playlist'" class="playlist-section">
        <div class="header">
          <div class="playlist-cover">
            <img :src="currentPlaylist?.cover || 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'" :alt="currentPlaylist?.name">
          </div>
          <div class="playlist-info">
            <h2>{{ currentPlaylist?.name }}</h2>
            <p>{{ currentPlaylist?.music?.length || currentPlaylist?.media_count || 0 }} 首音乐</p>
          </div>
          <div class="playlist-actions" v-if="!currentPlaylist?.id || currentPlaylist?.music">
            <button @click="exportPlaylist(currentPlaylist)" class="playlist-action-btn" title="导出歌单">
              <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              <span>导出</span>
            </button>
          </div>
        </div>

        <div class="playlist-tracks">
          <div
            v-for="(music, index) in currentPlaylist?.music"
            :key="music.bvid"
            class="track-item"
            @click="playMusic(music)"
          >
            <div class="track-number">{{ index + 1 }}</div>
            <div class="track-info">
              <h4>{{ music.title }}</h4>
              <p>{{ music.author }}</p>
            </div>
            <div class="track-actions">
              <button class="track-download-btn" @click.stop="downloadMusic(music)" title="下载">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/></svg>
              </button>
            </div>
            <div class="track-duration">{{ parseDuration(music.duration) }}</div>
          </div>
        </div>
      </section>
    </main>

    <div v-if="currentTrack" class="player-bar">
      <div class="current-track">
        <img :src="currentTrack.cover" :alt="currentTrack.title" class="current-cover" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
        <div class="current-info">
          <h4>{{ currentTrack.title }}</h4>
          <p>{{ currentTrack.author }}</p>
        </div>
      </div>

      <div class="player-controls">
        <div class="control-buttons">
          <button @click="togglePlayMode" class="control-btn mode-btn" :class="{ active: playMode !== 'order' }" :title="getPlayModeLabel()">
            <span class="mode-icon">{{ getPlayModeIcon() }}</span>
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
            </div>
          </div>
          <span class="progress-time">{{ parseDuration(duration) }}</span>
        </div>
      </div>

      <div class="player-actions">
        <button @click="openAddToPlaylistModal" class="action-btn" title="添加到歌单">
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

    <div v-if="showPlayerPage && currentTrack" class="player-page" @click="showPlayerPage = false">
      <div class="player-page-content" @click.stop>
        <button class="back-btn" @click="showPlayerPage = false">
          <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>
          <span>返回</span>
        </button>

        <button v-if="currentSeries" class="series-toggle-btn" @click="toggleSeriesPanel">
          <span>📋 合集</span>
          <span class="series-count">{{ currentSeries.episodes.length }}</span>
        </button>

        <div class="album-art">
          <img :src="currentTrack.cover" :alt="currentTrack.title" @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'">
        </div>

        <div class="track-info">
          <h2>{{ currentTrack.title }}</h2>
          <h3>{{ currentTrack.author }}</h3>
        </div>

        <div class="big-control-buttons">
          <button @click="togglePlayMode" class="big-control-btn" :class="{ active: playMode !== 'order' }" :title="getPlayModeLabel()">
            <span class="mode-icon">{{ getPlayModeIcon() }}</span>
          </button>
          <button @click="playPrevious" class="big-control-btn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button @click="togglePlayPause" class="big-control-btn play">
            <svg v-if="isPlaying" viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            <svg v-else viewBox="0 0 24 24" fill="currentColor" width="32" height="32"><path d="M8 5v14l11-7z"/></svg>
          </button>
          <button @click="playNext" class="big-control-btn">
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
          </button>
        </div>

        <div class="big-progress">
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
          
          <!-- 下载缓存进度 -->
          <div v-if="isDownloading" class="download-progress">
            <div class="download-progress-bar">
              <div class="download-progress-fill" :style="{ width: downloadProgress + '%' }"></div>
            </div>
            <span class="download-progress-text">缓存中 {{ downloadProgress }}%</span>
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
              :key="episode.bvid"
              class="series-item"
              :class="{ active: episode.bvid === currentTrack?.bvid }"
              @click="playFromSeries(episode)"
            >
              <span class="series-index">{{ index + 1 }}</span>
              <span class="series-title">{{ episode.title || '第' + (index + 1) + '集' }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="showThemePanel" class="theme-panel">
      <h3>选择主题颜色</h3>
      <div class="theme-colors">
        <button
          v-for="color in colorOptions"
          :key="color.value"
          class="theme-color-btn"
          :class="['color-' + color.value, { active: currentColor === color.value }]"
          @click="setColor(color.value)"
          :title="color.label"
        ></button>
      </div>

      <h3>选择模式</h3>
      <div class="theme-modes">
        <button
          class="theme-mode-btn"
          :class="{ active: currentTheme.value === 'dark' }"
          @click="setTheme('dark')"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9 9-4.03 9-9c0-.46-.04-.92-.1-1.36-.98 1.37-2.58 2.26-4.4 2.26-2.98 0-5.4-2.42-5.4-5.4 0-1.81.89-3.42 2.26-4.4-.44-.06-.9-.1-1.36-.1z"/></svg>
          深色
        </button>
        <button
          class="theme-mode-btn"
          :class="{ active: currentTheme.value === 'light' }"
          @click="setTheme('light')"
        >
          <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z"/></svg>
          浅色
        </button>
      </div>
    </div>

    <!-- <div v-if="showLoginModal" class="modal-overlay" @click="showLoginModal = false">
      <div class="modal" @click.stop>
        <h2>登录 B 站</h2>
        <div class="qrcode-container">
          <img v-if="qrcodeImage" :src="qrcodeImage" alt="登录二维码">
          <div v-else class="loading">
            <div class="loading-spinner"></div>
          </div>
        </div>
        <p class="login-status" v-if="loginStatus">{{ loginStatus }}</p>
        <p class="login-error" v-if="loginError">{{ loginError }}</p>
        <button class="modal-btn cancel" @click="showLoginModal = false">
          关闭
        </button>
      </div>
    </div> -->

    <div v-if="showCreatePlaylistModal" class="modal-overlay" @click="cancelCreatePlaylist">
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

    <div v-if="showAddToPlaylistModal" class="modal-overlay" @click="showAddToPlaylistModal = false">
      <div class="modal" @click.stop>
        <h2>添加到歌单</h2>
        <div class="playlist-list-modal">
          <div
            v-for="playlist in userPlaylists"
            :key="playlist.id"
            class="playlist-modal-item"
            @click="addToPlaylist(playlist)"
          >
            <span>{{ playlist.name }}</span>
            <span class="playlist-count">{{ playlist.music.length }} 首</span>
          </div>
          <div v-if="userPlaylists.length === 0" class="empty-list">
            <p>暂无歌单，请先创建</p>
          </div>
        </div>
        <div class="modal-buttons">
          <button class="modal-btn cancel" @click="showAddToPlaylistModal = false">
            关闭
          </button>
        </div>
      </div>
    </div>
  </div>
</template>