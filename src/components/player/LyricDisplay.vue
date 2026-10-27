<script setup>
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useLyricStore, usePlayerStore, useSettingsStore } from '@/stores'

const props = defineProps({
  currentTime: {
    type: Number,
    default: 0
  },
  onSeek: {
    type: Function,
    default: null
  },
  /**
   * 大屏模式：用于大屏播放页内，字号更大、行间距更宽
   * 大屏播放页布局需要更大的字体来填满右半区
   */
  large: {
    type: Boolean,
    default: false
  }
})

const lyricStore = useLyricStore()
const displayLyricError = computed(() => {
  const err = lyricStore.lyricError
  if (!err) return '沒有歌詞'
  if (['未找到歌词', '暂无歌词', '歌词为空', '获取歌词失败', 'empty lyric', 'no track', '没有歌词', '沒有歌詞'].includes(err) || err.includes('歌词') || err.includes('lyric')) {
    return '沒有歌詞'
  }
  return err
})
const playerStore = usePlayerStore()
const settingsStore = useSettingsStore()

// === 搜索面板状态 ===
const searchKeyword = ref('')
const searchResults = ref([])
const isSearching = ref(false)
const searchError = ref('')
const showSearchPanel = ref(false)
const selectedIndex = ref(0)
const selectingLyricId = ref(null)
// 歌词来源切换：netease | kugou
// 初始高亮取自「默认歌词源」设置；用户手动切换仍只影响当前搜索/当前曲目（per-track，不写回设置）
const searchSource = ref(settingsStore.lyricPreferredSource === 'netease' ? 'netease' : 'kugou')
const SOURCE_TABS = [
  { key: 'netease', label: '网易云' },
  { key: 'kugou', label: '酷狗' },
]
const searchInputRef = ref(null)

// === 手动滚动状态 ===
const isManualScrolling = ref(false)
let timeUpdateThrottle = null
let scrollReturnTimer = null

// === 歌词行布局参数（按 large 切换） ===
// 大屏模式：视区固定高度（不让 flex 撑过头把工具栏挤没）；
// 居中由 ResizeObserver 测得的实际视区高度驱动，喂给 trackStyle。
// 普通模式：紧凑列表，一屏可见 3-4 行
// 行高：要容纳"主行原文 + 最多两行附注（罗马音/翻译）"，按 3 行内容上限计算：
// 大屏 24px 主行×1.5 + 2×15px 附注×1.5 ≈ 78px，活跃行 32px×1.5 后 ≈ 90px，取 100px 留呼吸感；
// 普通 14px 主行 + 2×11px 附注 ≈ 50px，活跃 18px 后 ≈ 55px，取 60px。
// 行高统一，viewport / trackStyle / mask 全部自动按新行高重算，不用额外改。
const LINE_HEIGHT = computed(() => (props.large ? 100 : 60))
const VIEWPORT_HEIGHT = computed(() => (props.large ? 620 : 200))
const viewportRef = ref(null)
const actualViewportHeight = ref(props.large ? 620 : 200)
let viewportResizeObserver = null

// 大屏：让活跃行精确落在屏幕垂直中线（50vh）而不是视区中心。
// 推导：player-page-content 上下 padding 80/48 不对称 → 内容区中心 y = 50vh + 16；
// lyric-main 660px 在内容区中居中 → 视区中心 y = 50vh - 4；
// 视区在 lyric-main 顶部（无上边距），所以活跃行需相对视区中心再下移 4px 落到 50vh。
// 该值与屏幕高度无关，仅取决于 padding 与 lyric-main 高度（保持 660 / 80-48 时恒为 4）。
const LARGE_SCREEN_CENTER_OFFSET = 4

// === 手动模式超时（ms） ===
const MANUAL_TIMEOUT = 6000

// === 偏移步进 ===
const OFFSET_STEP = 500

// === 渲染窗口：所有行都在 track 中，用 translateY 居中 ===
const trackStyle = computed(() => {
  const lineH = LINE_HEIGHT.value
  // 优先用 ResizeObserver 测得的实际视区高度，保证居中准确
  const viewH = actualViewportHeight.value || VIEWPORT_HEIGHT.value
  // 大屏：补 4px 让活跃行落到屏幕垂直中线（50vh），而不是视区几何中心
  const screenCenterFix = props.large ? LARGE_SCREEN_CENTER_OFFSET : 0
  if (!lyricStore.hasLyric) {
    return { transform: 'translateY(0px)' }
  }
  const idx = lyricStore.currentLineIndex
  if (idx < 0) {
    return { transform: `translateY(${(viewH - lineH) / 2 + screenCenterFix}px)` }
  }
  const center = viewH / 2
  const lineCenter = idx * lineH + lineH / 2
  const offset = center - lineCenter + screenCenterFix
  return {
    transform: `translateY(${offset}px)`,
    transition: 'transform 0.45s cubic-bezier(0.25, 1, 0.5, 1)'
  }
})

const trackHeight = computed(() => {
  const lineH = LINE_HEIGHT.value
  if (!lyricStore.hasLyric) return 0
  return lyricStore.currentLyric.lyrics.length * lineH
})

// === 手动模式恢复 ===
function resumeAutoFollow() {
  isManualScrolling.value = false
  if (scrollReturnTimer) {
    clearTimeout(scrollReturnTimer)
    scrollReturnTimer = null
  }
  lyricStore.updateCurrentLine(props.currentTime)
}

function startScrollReturnTimer() {
  if (scrollReturnTimer) clearTimeout(scrollReturnTimer)
  scrollReturnTimer = setTimeout(() => {
    isManualScrolling.value = false
    lyricStore.updateCurrentLine(props.currentTime)
    scrollReturnTimer = null
  }, MANUAL_TIMEOUT)
}

// === 时间同步 ===
watch(() => props.currentTime, (newTime) => {
  if (isManualScrolling.value) return
  if (timeUpdateThrottle) return
  timeUpdateThrottle = true
  requestAnimationFrame(() => {
    lyricStore.updateCurrentLine(props.currentTime)
    timeUpdateThrottle = null
  })
})

// 歌词加载完成后立刻按当前进度定位（避免暂停时加载完高亮停在 -1）
watch(
  () => [lyricStore.currentLyric, lyricStore.loadedHash],
  () => {
    if (!lyricStore.hasLyric || isManualScrolling.value) return
    lyricStore.updateCurrentLine(props.currentTime)
  }
)

// === 切换歌曲 ===
// 用 immediate:true 防止"先点播、后开大屏"场景下 currentKey 永远为空，
// 导致微调/重置按钮静默失效。
// loadLyricForTrack 内部已做同 key 去重 + in-flight 合并，这里重复调用是安全的。
watch(
  () => playerStore.currentTrack,
  async (newTrack) => {
    if (!newTrack) return
    const newKey = lyricStore.getCacheKey(
      newTrack.bvid,
      newTrack.cid ?? 1,
      newTrack.title || '',
      newTrack.author || ''
    )
    if (lyricStore.currentKey === newKey && lyricStore.currentLyric && lyricStore.loadedHash === newKey) return
    await lyricStore.loadLyricForTrack(newTrack)
  },
  { immediate: true }
)

// === 歌词显示模式变更时重新加载歌词 ===
// 使用自定义事件确保跨组件可靠触发
// 歌词数据已在缓存中，模式切换仅需更新显示字段，无需重新请求网络。
function handleLyricModeChange() {
  // 无操作：lyricDisplayMode 是响应式的，
  // getSubLines() 会自动用新模式重新渲染每一行的附注
}

// === 歌词点击跳转 ===
function handleLyricClick(lyric) {
  if (!lyric || !props.onSeek) return
  const adjusted = lyric.time - lyricStore.currentOffset
  props.onSeek(adjusted / 1000)
}

// === 重试 ===
function handleRetry() {
  const track = playerStore.currentTrack
  if (!track) return
  lyricStore.loadLyricForTrack(track)
}

// === 滚轮手动滚动 ===
function onWheel(e) {
  if (!lyricStore.hasLyric) return
  const lines = lyricStore.currentLyric.lyrics
  const idx = lyricStore.currentLineIndex
  if (e.deltaY > 0 && idx < lines.length - 1) {
    lyricStore.setCurrentLineIndex(idx + 1)
    isManualScrolling.value = true
    startScrollReturnTimer()
  } else if (e.deltaY < 0 && idx > 0) {
    lyricStore.setCurrentLineIndex(idx - 1)
    isManualScrolling.value = true
    startScrollReturnTimer()
  }
}

// === 工具：偏移 ===
function adjustOffset(delta) {
  lyricStore.adjustLyricOffset(delta)
  // 调整后立即用新偏移重算当前行
  lyricStore.updateCurrentLine(props.currentTime)
}

function formatOffset(ms) {
  if (ms === 0) return '0s'
  const s = (ms / 1000).toFixed(1)
  return `${ms > 0 ? '+' : ''}${s}s`
}

// === 工具：时长（ms → m:ss） ===
function formatDuration(ms) {
  if (!ms || ms <= 0) return '--:--'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// === 搜索面板 ===
function openSearch() {
  showSearchPanel.value = true
  searchError.value = ''
  searchResults.value = []
  selectedIndex.value = 0
  // 总是回填当前曲名作为初始关键字
  const track = playerStore.currentTrack
  searchKeyword.value = track?.title || ''
  nextTick(() => {
    searchInputRef.value?.focus()
    searchInputRef.value?.select?.()
  })
}

function closeSearch() {
  showSearchPanel.value = false
  searchKeyword.value = ''
  searchResults.value = []
  searchError.value = ''
  selectedIndex.value = 0
}

async function handleSearch() {
  const kw = searchKeyword.value.trim()
  if (!kw) return
  isSearching.value = true
  searchResults.value = []
  searchError.value = ''
  selectedIndex.value = 0
  try {
    const result = await lyricStore.searchLyric(kw, searchSource.value)
    if (result.success && result.data) {
      searchResults.value = result.data
      if (result.data.length === 0) searchError.value = '未找到相关歌词'
    } else {
      searchError.value = result.error || '搜索失败'
    }
  } catch (error) {
    searchError.value = error.message || '搜索歌词失败'
  } finally {
    isSearching.value = false
  }
}

function onSearchKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    closeSearch()
    return
  }
  if (searchResults.value.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedIndex.value = (selectedIndex.value + 1) % searchResults.value.length
    scrollSelectedIntoView()
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedIndex.value =
      (selectedIndex.value - 1 + searchResults.value.length) % searchResults.value.length
    scrollSelectedIntoView()
  } else if (e.key === 'Enter') {
    if (selectedIndex.value >= 0 && selectedIndex.value < searchResults.value.length) {
      e.preventDefault()
      selectLyric(searchResults.value[selectedIndex.value])
    }
  }
}

function scrollSelectedIntoView() {
  nextTick(() => {
    const el = document.querySelector('.search-item.active')
    if (el && el.scrollIntoView) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  })
}

async function selectLyric(song) {
  if (!song) return
  const busyKey = `${song.source || 'netease'}-${song.id}`
  selectingLyricId.value = busyKey
  try {
    // IPC 走结构化克隆，不能直接传 Vue 响应式对象（Proxy 无法克隆会上报错）
    // 这里只挑主进程需要的字段构造普通对象；kugou 需 hash 定位 KRC
    const payload = { source: song.source || 'netease', id: song.id, hash: song.hash }
    const result = await window.electronAPI.getLyricById(payload)
    if (result?.code === 0 && result.data) {
      const lyric = lyricStore.parseLyric(result.data)
      lyricStore.setCurrentLyric(lyric)
      lyricStore.setLyricSource('manual')
      const track = playerStore.currentTrack
      lyricStore.cacheLyric(
        track?.bvid || '',
        track?.cid ?? 1,
        track?.title || '',
        track?.author || '',
        lyric,
        'manual'
      )
      // 手动换词后立刻按当前进度高亮
      lyricStore.updateCurrentLine(props.currentTime)
      closeSearch()
    } else {
      searchError.value = result?.message || '获取歌词失败'
    }
  } catch (error) {
    console.error('selectLyric error:', error)
    searchError.value = error?.message || '网络错误'
  } finally {
    selectingLyricId.value = null
  }
}
// 恢复默认歌词（清除手动选择）
async function handleResetManual() {
  const track = playerStore.currentTrack
  if (!track) return
  await lyricStore.resetManualLyric()
  await lyricStore.loadLyricForTrack(track)
}

onMounted(() => {
  lyricStore.loadCache()
  document.addEventListener('keydown', onGlobalKeydown)
  // 监听歌词显示模式变更事件
  window.addEventListener('pink-music:lyric-mode-changed', handleLyricModeChange)
  // 大屏：监听歌词视区实际高度，喂给 trackStyle 居中计算
  if (props.large && viewportRef.value) {
    actualViewportHeight.value = viewportRef.value.clientHeight || VIEWPORT_HEIGHT.value
    if (typeof ResizeObserver !== 'undefined') {
      viewportResizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const h = entry.contentRect.height
          if (h > 0 && Math.abs(h - actualViewportHeight.value) > 0.5) {
            actualViewportHeight.value = h
          }
        }
      })
      viewportResizeObserver.observe(viewportRef.value)
    }
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', onGlobalKeydown)
  if (scrollReturnTimer) clearTimeout(scrollReturnTimer)
  window.removeEventListener('pink-music:lyric-mode-changed', handleLyricModeChange)
})

// 全局快捷键：在歌词面板显示时按 / 唤起搜索
function onGlobalKeydown(e) {
  if (!lyricStore.showLyricPanel) return
  if (showSearchPanel.value) return
  if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
    e.preventDefault()
    openSearch()
  }
}

// 根据设置返回该行的附注行（罗马音/翻译，缺失则空数组）：
// 主行永远显示原文，模式只控制下方叠加哪行小字附注。
function getSubLines(line) {
  const mode = settingsStore.lyricDisplayMode
  if (mode === 'romaji') return line.romaji ? [line.romaji] : []
  if (mode === 'translation') return line.translation ? [line.translation] : []
  return []
}
</script>

<template>
  <div
    v-if="lyricStore.showLyricPanel"
    class="lyric-stage"
    :class="{ 'lyric-stage--large': large }"
    @wheel.prevent="onWheel"
  >
    <!-- ============ 歌词主视图（抽屉未打开时） ============ -->
    <div v-show="!showSearchPanel" class="lyric-main">
      <div v-if="lyricStore.isLyricLoading" class="lyric-state">
        <div class="spinner"></div>
        <p>正在匹配歌词…</p>
      </div>

      <div v-else-if="lyricStore.lyricError" class="lyric-state err">
        <p>{{ displayLyricError }}</p>
        <div class="err-actions">
          <button class="ebtn" @click="handleRetry">重试</button>
          <button class="ebtn" @click="openSearch">搜索歌词</button>
        </div>
      </div>

      <div v-else-if="lyricStore.hasLyric" class="lyric-lyrics">
        <!-- 手动模式提示条 -->
        <Transition name="manual-hint">
          <div v-if="isManualScrolling" class="manual-hint">
            <span class="mh-dot"></span>
            <span class="mh-text">手动浏览中 · {{ MANUAL_TIMEOUT / 1000 }}s 后自动跟随</span>
            <button class="mh-resume" @click="resumeAutoFollow">重新跟随 ↻</button>
          </div>
        </Transition>

        <!-- 歌词滑动区 -->
        <!-- 大屏模式不写死高度：由 CSS 撑满列高并在 660px 处封顶，
             矮窗口（如 1000×700）里视区自动收缩，工具栏不会被挤出窗口 -->
        <div
          ref="viewportRef"
          class="lyric-viewport"
          :style="large ? null : { height: VIEWPORT_HEIGHT + 'px' }"
          @wheel.stop="onWheel"
        >
          <div
            class="lyric-track"
            :style="{ ...trackStyle, height: trackHeight + 'px' }"
          >
            <!--
              已唱完的行（i < currentLineIndex）只在"自动跟随"模式下加 past class → 淡出。
              手动滚动（isManualScrolling=true）期间不生效，全部可见，方便回看上下文。
            -->
            <div
              v-for="(line, i) in lyricStore.currentLyric.lyrics"
              :key="i"
              class="line"
              :class="{
                active: i === lyricStore.currentLineIndex,
                past: i < lyricStore.currentLineIndex && !isManualScrolling
              }"
              :style="{ height: LINE_HEIGHT + 'px' }"
              @click="handleLyricClick(line)"
            >
              <span class="line-main">{{ line.text }}</span>
              <span v-for="(sub, si) in getSubLines(line)" :key="si" class="line-sub">{{ sub }}</span>
            </div>
          </div>
        </div>

        <!-- 工具栏 -->
        <div class="lyric-actions">
          <button
            class="action-btn"
            @click="adjustOffset(OFFSET_STEP)"
            :title="'歌词提前 0.5s'"
          >
            <span class="ab-arrow">«</span>
            <span>0.5s</span>
          </button>
          <button
            class="action-btn search-trigger"
            @click="openSearch"
            title="搜索歌词（/ 唤起）"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
          </button>
          <button
            class="action-btn"
            @click="adjustOffset(-OFFSET_STEP)"
            :title="'歌词延迟 0.5s'"
          >
            <span>0.5s</span>
            <span class="ab-arrow">»</span>
          </button>
          <button
            v-if="lyricStore.isManualSource"
            class="action-btn reset-source"
            @click="handleResetManual"
            title="恢复默认歌词"
          >
            <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14">
              <path d="M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.45 11h-2.1A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"/>
            </svg>
          </button>
        </div>

        <!-- 偏移 badge：固定在工具栏右侧，不挤占歌词区 -->
        <div
          v-if="lyricStore.currentOffset !== 0"
          class="offset-badge"
          @click="lyricStore.resetLyricOffset()"
        >
          {{ formatOffset(lyricStore.currentOffset) }} ↺
        </div>
      </div>

      <div v-else class="lyric-state">
        <p>沒有歌詞</p>
        <button class="ebtn" @click="openSearch">搜索歌词</button>
      </div>
    </div>

    <!-- ============ 抽屉式搜索面板（覆盖在主视图上） ============ -->
    <Transition name="drawer">
      <div
        v-if="showSearchPanel"
        class="search-drawer"
        tabindex="-1"
        @keydown="onSearchKeydown"
      >
        <div class="search-bar">
          <input
            ref="searchInputRef"
            v-model="searchKeyword"
            placeholder="搜索歌曲名..."
            @keyup.enter="handleSearch"
          />
          <button class="search-go" @click="handleSearch" :disabled="isSearching">搜索</button>
          <button class="search-close" @click="closeSearch" title="关闭（Esc）">✕</button>
        </div>
        <div class="source-tabs">
          <button
            v-for="tab in SOURCE_TABS"
            :key="tab.key"
            class="source-tab"
            :class="{ active: searchSource === tab.key }"
            @click="searchSource = tab.key"
          >{{ tab.label }}</button>
        </div>
        <div class="search-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>

        <div v-if="isSearching" class="search-state">搜索中…</div>
        <div v-else-if="searchError" class="search-state error">{{ searchError }}</div>
        <div v-else class="search-results">
          <button
            v-for="(song, i) in searchResults"
            :key="`${song.source || 'netease'}-${song.id}`"
            class="search-item"
            :class="{ active: selectedIndex === i, busy: selectingLyricId === `${song.source || 'netease'}-${song.id}` }"
            :disabled="selectingLyricId !== null"
            @click="selectLyric(song)"
            @mouseenter="selectedIndex = i"
          >
            <div class="si-main">
              <div class="si-name">{{ song.name }}</div>
              <div class="si-meta">
                <span class="si-artist">{{ song.artist }}</span>
                <span v-if="song.album" class="si-album">· 《{{ song.album }}》</span>
              </div>
            </div>
            <span class="si-duration">{{ formatDuration(song.duration) }}</span>
          </button>
          <div
            v-if="!isSearching && !searchError && searchResults.length === 0 && searchKeyword"
            class="search-state"
          >无结果</div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.lyric-stage {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.lyric-main {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  transition: opacity 0.3s ease, filter 0.3s ease;
}

/* ===== 手动模式提示条 ===== */
.manual-hint {
  position: absolute;
  top: 4px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  background: rgba(255, 165, 0, 0.12);
  border: 1px solid rgba(255, 165, 0, 0.3);
  border-radius: 999px;
  font-size: 11px;
  color: rgba(255, 200, 100, 0.95);
  z-index: 5;
  white-space: nowrap;
}
.mh-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 165, 0, 0.9);
  animation: pulse 1.2s ease-in-out infinite;
}
.mh-text { letter-spacing: 0.3px; }
.mh-resume {
  background: rgba(255, 165, 0, 0.2);
  border: 1px solid rgba(255, 165, 0, 0.4);
  color: rgba(255, 200, 100, 0.95);
  border-radius: 999px;
  padding: 1px 8px;
  font-size: 10px;
  cursor: pointer;
  transition: background 0.2s;
}
.mh-resume:hover { background: rgba(255, 165, 0, 0.35); }

.manual-hint-enter-active, .manual-hint-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.manual-hint-enter-from { opacity: 0; transform: translate(-50%, -6px); }
.manual-hint-leave-to   { opacity: 0; transform: translate(-50%, -6px); }

@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.8); }
  50%      { opacity: 1;   transform: scale(1.1); }
}

/* ===== 歌词滑动区 ===== */
.lyric-lyrics {
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  position: relative;
}

.lyric-viewport {
  width: 100%;
  position: relative;
  overflow: hidden;
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 40px,
    black calc(100% - 40px),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 40px,
    black calc(100% - 40px),
    transparent 100%
  );
}

.lyric-track {
  position: relative;
  width: 100%;
  will-change: transform;
}

.line {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* 行高是固定值：内容一律夹在本行盒子里，不得溢到相邻行或工具栏 */
  overflow: hidden;
  gap: 2px;
  color: var(--text-secondary);
  font-size: 14px;
  text-align: center;
  cursor: pointer;
  padding: 0 12px;
  max-width: 90%;
  margin: 0 auto;
  line-height: 1.4;
  user-select: none;
  /* 频谱条现在只占底部 18%，不与歌词重叠，不再需要 text-shadow */
  /* opacity 0.45s：与"active → past"过渡同步，让已唱完的行平滑淡出而不是硬切。
     手滚动模式（isManualScrolling=true）下 past class 不生效，opacity 自动回到 1。 */
  transition: color 0.25s ease, font-size 0.3s ease, transform 0.3s ease, opacity 0.45s ease;
}
/* 主行（原文）：继承 .line 的字号/字重规则 */
.line-main {
  /* 最多两行，多出的以省略号收掉：固定行高里主行只给 2 行预算 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  max-width: 100%;
  max-height: 100%;
  overflow-wrap: anywhere;
  word-break: normal;
}
/* 附注行（罗马音/翻译）：小字号弱化，不抢主行焦点 */
.line-sub {
  display: block;
  max-width: 100%;
  font-size: 11px;
  line-height: 1.35;
  color: var(--text-muted);
  opacity: 0.85;
  /* 附注行固定单行截断：行高预算里只容得下一行附注 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: normal;
}
.line:hover { color: var(--text-primary); }
.line:hover .line-sub { color: var(--text-secondary); }
/* 浅色模式下，非 Apple Music 主题的歌词未唱行改为与 Apple Music 一致的近黑色。
   :not(.active) 让活跃行保持主题色高亮，不受本规则影响 */
[data-theme="light"]:not([data-color="apple-music"]) .line:not(.active) {
  color: rgba(0, 0, 0, 0.65);
}
[data-theme="light"]:not([data-color="apple-music"]) .line:not(.active):hover {
  color: var(--text-primary);
}
[data-theme="light"]:not([data-color="apple-music"]) .line:not(.active) .line-sub {
  color: rgba(0, 0, 0, 0.4);
}
[data-theme="light"]:not([data-color="apple-music"]) .line:not(.active):hover .line-sub {
  color: rgba(0, 0, 0, 0.65);
}
.line.active {
  color: var(--primary-color);
  font-size: 18px;
  font-weight: 600;
  /* 活跃行轻微放大，加强焦点感 */
  transform: scale(1.02);
}
.line.active .line-sub {
  color: rgba(var(--primary-color-rgb), 0.7);
  opacity: 1;
}
/* 已唱完的行：在自动跟随模式下完全淡出，但保留槽位高度避免布局跳动。
   pointer-events: none 防止误点到"看不见"的行触发跳转。 */
.line.past {
  opacity: 0;
  pointer-events: none;
}

/* 大屏播放页内的歌词（large prop 触发）
   - 字体：Outfit（项目已有的圆润无衬线），无衬线 + 偏粗字重
   - 普通行主行 24px / 600，行高 1.5；LINE_HEIGHT 100 足够容纳主行 + 两行附注（罗马音/翻译）
   - 活跃行主行 32px / 800，颜色高亮；附注 15px 弱化
   - 整体在 player-page-right 中垂直居中；视区 620px，actions 在底部
   - 视区几何中心 y = 50vh - 4（受 player-page-content 上下 padding 80/48 影响），
     通过 trackStyle 追加 LARGE_SCREEN_CENTER_OFFSET = 4px 把活跃行校正到屏幕正中 (50vh)
   - 一屏可见 5-6 行（620 / 100 ≈ 6.2，配合 past 行隐藏后视觉上更"干净"） */
.lyric-stage--large {
  /* height: 100%（继承 .lyric-stage 基础规则）现在能真正解析 = 行高 = 播放页剩余高度，
     所以这一列是"撑满列高"的；align-self / max-height 留作兜底（行高确定后不再起作用）。 */
  align-self: center;
  max-height: 100%;
}
.lyric-stage--large .lyric-main {
  /* 660 = 原 VIEWPORT(620) + actions margin(12) + actions(~28)，只作设计上限保留。
     可用高度不再用 "100vh - 220px" 这种写死的页面 chrome 预算去猜：
     .player-page-layout 已加 grid-template-rows: minmax(0, 1fr)，
     行高 = 真实剩余高度（1470×930 → 802，1000×700 → 588），
     .player-page-right(height:100%) → .lyric-stage(height:100%) 的百分比链因此成立，
     这里的 100% 就是该剩余高度，窗口有多矮歌词列就收缩多少。
     -24px（--lyric-badge-reserve）= offset-badge 挂在工具栏下沿 bottom:-22px 的外挂空间 + 2px 余量；
     不留这段，工具栏贴到列底时 badge 会被 .lyric-stage 的 overflow:hidden 裁掉（Windows 上"微调"看不见）。 */
  height: min(660px, calc(100% - var(--lyric-badge-reserve, 24px)));
  max-height: 100%;
  min-height: 0;
}
/* 歌词区吃满剩余高度，视区高度由 CSS 决定（ResizeObserver 会测到真实高度，
   居中计算的 actualViewportHeight 自动跟随） */
.lyric-stage--large .lyric-lyrics {
  flex: 1 1 auto;
  min-height: 0;
}
.lyric-stage--large .lyric-viewport {
  flex: 1 1 auto;
  min-height: 0;
  height: auto;
}
.lyric-stage--large .lyric-viewport {
  /* 加大上下渐隐蒙版，避免字号增大后边缘被裁切 */
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 60px,
    black calc(100% - 60px),
    transparent 100%
  );
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black 60px,
    black calc(100% - 60px),
    transparent 100%
  );
}
.lyric-stage--large .line {
  font-family: var(--font-display);
  font-size: 24px;
  line-height: 1.5;
  font-weight: 600;
  letter-spacing: -0.3px;
  /* 主行与附注行可换行：解除 max-width:90% 限制，让行宽跟随列宽 */
  max-width: 100%;
}
.lyric-stage--large .line.active {
  font-size: 32px;
  font-weight: 800;
  /* 不用 scale：text-box 高度变化会让居中计算漂移 */
  transform: none;
  letter-spacing: -0.5px;
}
/* 大屏附注行：15px 弱化，活跃时 16px 微亮 */
.lyric-stage--large .line-sub {
  font-size: 15px;
  font-weight: 400;
  letter-spacing: 0;
  opacity: 0.8;
}
.lyric-stage--large .line.active .line-sub {
  font-size: 16px;
  opacity: 1;
}

/* ===== 工具栏 ===== */
.lyric-actions {
  /* 工具栏永不被压缩；列宽不足时换行而不是溢出（按钮不会消失） */
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
  row-gap: 6px;
  margin-top: 12px;
  position: relative;
  z-index: 1;
}

/* 所有可点元素显式 no-drag */
.lyric-stage button {
  -webkit-app-region: no-drag;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  background: rgba(var(--primary-color-rgb), 0.1);
  border: 1px solid rgba(var(--primary-color-rgb), 0.2);
  color: var(--primary-color);
  padding: 5px 9px;
  border-radius: 5px;
  font-size: 11px;
  cursor: pointer;
  line-height: 1;
  transition: all 0.2s;
}
.action-btn:hover {
  background: rgba(var(--primary-color-rgb), 0.22);
  color: var(--primary-color);
}
.action-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.action-btn.search-trigger { padding: 5px 7px; }
.action-btn.reset-source { padding: 5px 7px; }
.ab-arrow {
  font-weight: 700;
  font-size: 12px;
  line-height: 1;
}

/* ===== 偏移 badge：放在工具栏右侧（不挤占歌词区） ===== */
.offset-badge {
  position: absolute;
  right: 0;
  bottom: -22px;
  /* 偏移文案过长时自身截断，不横向长到工具栏按钮上 */
  max-width: 45%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  z-index: 2;
  font-size: 10px;
  color: rgba(255, 200, 50, 0.85);
  background: rgba(255, 200, 50, 0.1);
  padding: 2px 7px;
  border-radius: 3px;
  cursor: pointer;
  transition: all 0.2s;
  user-select: none;
}
.offset-badge:hover {
  background: rgba(255, 200, 50, 0.2);
  color: rgba(255, 200, 50, 1);
}

/* ===== 状态/空态 ===== */
.lyric-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  min-height: 120px;
}
.lyric-state p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}
.lyric-state.err p { color: rgba(255, 100, 100, 0.85); }
.err-actions { display: flex; gap: 8px; }
.ebtn {
  background: rgba(var(--primary-color-rgb), 0.1);
  border: 1px solid rgba(var(--primary-color-rgb), 0.2);
  color: var(--primary-color);
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.ebtn:hover {
  background: rgba(var(--primary-color-rgb), 0.22);
  color: var(--primary-color);
}

.spinner {
  width: 28px;
  height: 28px;
  border: 2px solid rgba(var(--primary-color-rgb), 0.2);
  border-top-color: var(--primary-color);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* =====================================================
   抽屉式搜索面板 —— 从右侧滑入，背景歌词仍可见
   ===================================================== */
.search-drawer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-overlay);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 14px;
  z-index: 10;
  outline: none;
}
.drawer-enter-active, .drawer-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.drawer-enter-from { opacity: 0; transform: translateY(20px); }
.drawer-leave-to   { opacity: 0; transform: translateY(20px); }

.search-bar {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  margin-bottom: 8px;
  min-height: 0;
}
.search-bar input {
  flex: 1;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  padding: 8px 10px;
  font-size: 13px;
  outline: none;
  min-width: 0;
  transition: border-color 0.2s;
}
.search-bar input::placeholder { color: var(--text-muted); }
.search-bar input:focus { border-color: var(--primary-color); }
.search-bar button {
  border: none;
  color: var(--text-primary);
  padding: 7px 12px;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  transition: opacity 0.2s, background 0.2s;
}
.search-go {
  background: var(--primary-color);
  color: var(--text-primary);
}
.search-go:disabled { opacity: 0.5; cursor: not-allowed; }
.search-close {
  background: var(--bg-card);
  border: 1px solid var(--border-color) !important;
  color: var(--text-primary) !important;
  width: 32px;
  padding: 7px 8px !important;
}
.search-close:hover { background: var(--bg-card-hover); }

.search-hint {
  font-size: 10px;
  color: var(--text-muted);
  margin-bottom: 6px;
  letter-spacing: 0.3px;
}

/* ===== 歌词来源切换 tab ===== */
.source-tabs {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  margin-bottom: 6px;
}
.source-tab {
  border: 1px solid var(--border-color);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.15s ease;
}
.source-tab:hover { color: var(--text-primary); }
.source-tab.active {
  background: var(--primary-color);
  border-color: var(--primary-color);
  color: var(--text-primary);
}

.search-state {
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  padding: 20px;
}
.search-state.error { color: var(--error-color); }

.search-results {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 2px;
}

.search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--bg-surface);
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}
.search-item:hover, .search-item.active {
  background: var(--bg-card-hover);
  border-color: var(--border-color-hover);
}
.search-item.busy { opacity: 0.6; cursor: wait; }
.search-item:disabled { cursor: not-allowed; }

.si-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.si-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-meta {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.si-album { color: var(--text-muted); }

.si-duration {
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
</style>
