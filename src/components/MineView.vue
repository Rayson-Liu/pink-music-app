<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import CustomBackgroundSettings from './CustomBackgroundSettings.vue'
import { useUserStore, usePlayerStore, usePlaylistStore, useSettingsStore, useThemeStore, useUpdateStore } from '../stores'
import { parseDuration } from '../utils/bilibili'
import { EQ_BANDS, EQ_PRESET_KEYS, EQ_PRESET_LABELS, EQ_DB_MIN, EQ_DB_MAX } from '../utils/audioEQ'

const userStore = useUserStore()
const playerStore = usePlayerStore()
const playlistStore = usePlaylistStore()
const settingsStore = useSettingsStore()
const themeStore = useThemeStore()
const updateStore = useUpdateStore()

// ============== 版本更新检查 ==============
const showUpdateModal = ref(false)

async function checkUpdate() {
  console.log('[checkUpdate] electronAPI.checkForUpdate 可用:', !!window.electronAPI?.checkForUpdate)
  const res = await updateStore.check(true)
  if (res && res.code === 0 && res.hasUpdate) {
    showUpdateModal.value = true
  } else if (res && res.code === 0) {
    alert('已是最新版本')
  } else if (res) {
    alert(updateStore.error || '检查更新失败，请稍后重试')
  } else {
    // 并发检查中（上一次尚未结束）或异常返回，避免点击后毫无反馈
    alert(updateStore.error || '正在检查中，请稍候')
  }
}

function openReleasePage() {
  showUpdateModal.value = false
  updateStore.openReleases()
}

function formatPublishedAt(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// ============== 桌面歌词全局快捷键：录制与设置 ==============
const DESKTOP_LYRICS_HOTKEY_DEFAULT = 'CommandOrControl+D'   // 与 main.js / schema v7 默认值互指
const HOTKEY_MODIFIERS = new Set(['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super'])
const IS_MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform || '')

const hotkeyRecording = ref(false)
const hotkeyPreview = ref('')
const hotkeyConflict = ref(false)
const hotkeyNeedModifier = ref(false)
let draftMods = []
let draftKey = ''

function normalizeKeyName(e) {
  const k = e.key
  if (/^[a-zA-Z]$/.test(k)) return k.toUpperCase()
  if (/^[0-9]$/.test(k)) return k
  const fMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(k)
  if (fMatch) return k
  const named = {
    ' ': 'Space', 'Escape': 'Esc', 'Enter': 'Return', 'ArrowUp': 'Up',
    'ArrowDown': 'Down', 'ArrowLeft': 'Left', 'ArrowRight': 'Right',
    'Backspace': 'Backspace', 'Delete': 'Delete', 'Insert': 'Insert',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
    'Tab': 'Tab', '+': 'Plus'
  }
  return named[k] || null
}

/** Electron accelerator → 平台友好显示 */
function formatHotkey(accel) {
  if (!accel) return ''
  const prettyKey = (part) => {
    if (!IS_MAC) return part === 'CommandOrControl' || part === 'CmdOrCtrl' ? 'Ctrl' : part
    switch (part) {
      case 'CommandOrControl': case 'CmdOrCtrl': case 'Command': case 'Cmd': case 'Control': case 'Ctrl':
        return '⌘'
      case 'Alt': case 'Option':
        return '⌥'
      case 'Shift':
        return '⇧'
      case 'Super':
        return '⌘'
      default:
        return part
    }
  }
  const parts = accel.split('+')
  const key = parts.pop()
  return parts.map(prettyKey).join(IS_MAC ? '' : '+') + (IS_MAC ? '' : '+') + key
}

/** 把当前按下的修饰键/按键组装成 accelerator 字符串与友好预览 */
function buildAccelString() {
  const parts = []
  if (draftMods.includes('Meta')) parts.push(IS_MAC ? 'CommandOrControl' : 'Super')
  if (draftMods.includes('Control') && !(draftMods.includes('Meta'))) {
    // mac 上 ⌘ 已映射为 CommandOrControl；mac 实体 Ctrl 单独映射 Control
    parts.push(IS_MAC ? 'Control' : 'CommandOrControl')
  }
  if (draftMods.includes('Alt')) parts.push('Alt')
  if (draftMods.includes('Shift')) parts.push('Shift')
  const unique = [...new Set(parts)]
  if (!draftKey) {
    return {
      accel: '',
      preview: unique.length ? formatHotkey(unique.join('+') + '+…') : ''
    }
  }
  const accel = unique.join('+') + '+' + draftKey
  return { accel, preview: formatHotkey(accel) }
}

function updateHotkeyPreview() {
  const { preview } = buildAccelString()
  hotkeyPreview.value = preview
}

async function onHotkeyKeydown(e) {
  e.preventDefault()
  e.stopPropagation()
  if (e.key === 'Escape') { stopHotkeyRecording(); return }

  // 收集按下的修饰键（keydown 期间持续跟踪）
  draftMods = []
  if (e.metaKey) draftMods.push('Meta')
  if (e.ctrlKey) draftMods.push('Control')
  if (e.altKey) draftMods.push('Alt')
  if (e.shiftKey) draftMods.push('Shift')

  const isModifierOnly = ['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Fn'].includes(e.key)
  if (isModifierOnly) {
    draftKey = ''
    hotkeyNeedModifier.value = false
    updateHotkeyPreview()
    return
  }

  const keyName = normalizeKeyName(e)
  if (!keyName) { updateHotkeyPreview(); return }   // 不支持的按键，仅刷新预览
  draftKey = keyName

  // 校验：至少一个修饰键（与服务端 validateAccelerator 同规则）
  const { accel } = buildAccelString()
  const hasModifier = accel.split('+').slice(0, -1).some(p => HOTKEY_MODIFIERS.has(p))
  if (!hasModifier) {
    hotkeyNeedModifier.value = true
    updateHotkeyPreview()
    return
  }
  hotkeyNeedModifier.value = false
  await commitHotkey(accel)
}

async function commitHotkey(accel) {
  try {
    const res = await window.desktopLyricsAPI?.setLyricsHotkey?.(accel)
    if (res && res.ok) {
      settingsStore.setDesktopLyricsHotkey(res.accel || accel)
      hotkeyConflict.value = false
      stopHotkeyRecording()
    } else {
      // 冲突或非法：主进程已回滚旧键，提示并退出录制态
      hotkeyConflict.value = true
      stopHotkeyRecording()
    }
  } catch (_) {
    hotkeyConflict.value = true
    stopHotkeyRecording()
  }
}

function startHotkeyRecording() {
  hotkeyConflict.value = false
  hotkeyNeedModifier.value = false
  draftMods = []
  draftKey = ''
  hotkeyPreview.value = ''
  hotkeyRecording.value = true
  window.addEventListener('keydown', onHotkeyKeydown, true)
  window.addEventListener('blur', stopHotkeyRecording)
}
function stopHotkeyRecording() {
  hotkeyRecording.value = false
  window.removeEventListener('keydown', onHotkeyKeydown, true)
  window.removeEventListener('blur', stopHotkeyRecording)
}
async function resetHotkey() {
  await commitHotkey(DESKTOP_LYRICS_HOTKEY_DEFAULT)
  hotkeyConflict.value = false
}

// 主题模式与主题颜色：与侧边栏的旧主题面板合并迁移到此处
// 切换即写 localStorage + 更新 <html data-theme / data-color>，与 themeStore 保持唯一来源
const themeOptions = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' }
]
// Apple Music 主题通过 data-color="apple-music" 识别，
// 在浅色模式下用纯白底+纯黑文字+红色描边，深色模式下用纯黑底+白色文字+红色描边
const colorOptions = [
  { value: 'pink', label: '粉色', color: '#FF69B4' },
  { value: 'purple', label: '紫色', color: '#9C27B0' },
  { value: 'blue', label: '蓝色', color: '#2196F3' },
  { value: 'green', label: '绿色', color: '#4CAF50' },
  { value: 'orange', label: '橙色', color: '#FF9800' },
  { value: 'apple-music', label: 'Apple Music', color: '#FC3C44' }
]
function selectTheme(t) {
  themeStore.setTheme(t)
}
function selectColor(c) {
  themeStore.setColor(c)
}
// 当前选中颜色的中文标签（显示在色板右侧，辅助用户确认）
const currentColorLabel = computed(() => {
  const found = colorOptions.find(c => c.value === themeStore.currentColor)
  return found ? found.label : ''
})

const activeTab = ref('profile')
const cacheSize = ref(0)
const isCalculatingCache = ref(false)
const isClearingCache = ref(false)
const downloadDirectory = ref('')
const showClearCacheConfirm = ref(false)

// 音频可视化激进度：草稿值。拖动滑块只改这里，点"应用"才提交到 store。
// 这样在大屏播放页打开时调整激进度不会一边拖一边变（避免反复触发视觉变化）。
const pendingIntensity = ref(settingsStore.audioVisualizerIntensity)
// 四舍五入到 0.01 后比较，避免浮点误差导致的"没变化但按钮可用"
const intensityDirty = computed(
  () => Math.round(pendingIntensity.value * 100) !== Math.round(settingsStore.audioVisualizerIntensity * 100)
)
function applyIntensity() {
  if (!intensityDirty.value) return
  settingsStore.setAudioVisualizerIntensity(pendingIntensity.value)
}
function resetIntensity() {
  pendingIntensity.value = settingsStore.audioVisualizerIntensity
}
// 如果 store 在外部被改（比如多窗口同步、设置导入），同步到草稿
watch(
  () => settingsStore.audioVisualizerIntensity,
  (v) => { pendingIntensity.value = v }
)

// 均衡器：滑块采用 draft + apply 模式（与可视化激进度一致）。
// 拖动只改 pendingBands，点击"应用"才把 10 段一次性提交到 store + 音频引擎。
// 预置/重置是 live 动作（立即提交），但会同步把 store 值灌进 pendingBands，让滑块和实际生效值保持一致。
const pendingBands = ref(settingsStore.eqBands.slice())
// 浮点比较：slider step=0.5，所以严格 === 是安全的（不会因浮点误差误判 dirty）
const eqDirty = computed(() => {
  const a = pendingBands.value
  const b = settingsStore.eqBands
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return true
  }
  return false
})
const presetKeys = EQ_PRESET_KEYS
const presetLabels = EQ_PRESET_LABELS
// 滑块 + dB 数值标签都绑定 draft（pendingBands），点击"应用"才提交到 store

function onBandInput(index, event) {
  const v = parseFloat(event.target.value)
  // 数组整体替换以保证 Vue 响应式检测到变化
  const next = pendingBands.value.slice()
  next[index] = v
  pendingBands.value = next
}
function onPresetChange(event) {
  const key = event.target.value
  if (!key) return
  // 预置是 live 动作：直接 commit 到 store + 音频，同时同步 draft
  settingsStore.applyEQPreset(key)
  pendingBands.value = settingsStore.eqBands.slice()
}
function onResetEQ() {
  // 重置是 live 动作：commit 后同步 draft
  settingsStore.resetEQ()
  pendingBands.value = settingsStore.eqBands.slice()
}
function applyEQ() {
  if (!eqDirty.value) return
  settingsStore.commitEQBands(pendingBands.value)
  // commit 后 store 和 draft 一致，无需手动同步
}
function revertEQ() {
  pendingBands.value = settingsStore.eqBands.slice()
}
// store 被外部修改时（多窗口同步、设置导入等），把 draft 拉回 store 当前值
watch(
  () => settingsStore.eqBands,
  (v) => { pendingBands.value = v.slice() }
)
function formatDb(v) {
  // 显示格式：+1.5 / 0 / -3
  if (v === 0) return '0'
  return (v > 0 ? '+' : '') + v.toFixed(1).replace(/\.0$/, '')
}

const tabs = [
  { key: 'profile', label: '我的' },
  { key: 'history', label: '历史' },
  { key: 'settings', label: '设置' }
]

const playHistory = computed(() => playerStore.playHistory || [])
const hasUser = computed(() => !!userStore.userInfo)

function formatFileSize(bytes) {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

async function calculateCacheSize() {
  if (!window.electronAPI) return
  isCalculatingCache.value = true
  try {
    const result = await window.electronAPI.getCacheSize()
    if (result.code === 0) {
      cacheSize.value = result.size
    }
  } catch (error) {
    console.error('计算缓存大小失败:', error)
  } finally {
    isCalculatingCache.value = false
  }
}

async function clearCache() {
  if (!window.electronAPI) return
  isClearingCache.value = true
  try {
    const result = await window.electronAPI.clearCache()
    if (result.code === 0) {
      // 重新从磁盘查询真实大小，避免 UI 显示 0 与实际不符
      // （主进程里某些清理步骤可能失败但被 try/catch 吞了，硬写 0 就不准）
      try {
        const sizeRes = await window.electronAPI.getCacheSize()
        cacheSize.value = sizeRes.code === 0 ? sizeRes.size : 0
      } catch (_) {
        cacheSize.value = 0
      }
    }
  } catch (error) {
    console.error('清理缓存失败:', error)
  } finally {
    isClearingCache.value = false
    showClearCacheConfirm.value = false
  }
}

async function selectDownloadDirectory() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.selectDownloadDirectory()
    if (result.code === 0) {
      downloadDirectory.value = result.path
      await window.electronAPI.setDownloadDirectory(result.path)
    }
  } catch (error) {
    console.error('选择下载目录失败:', error)
  }
}

async function getCurrentDownloadDirectory() {
  if (!window.electronAPI) return
  try {
    const result = await window.electronAPI.getDownloadDirectory()
    if (result.code === 0) {
      downloadDirectory.value = result.path
    }
  } catch (error) {
    console.error('获取下载目录失败:', error)
  }
}

function clearPlayHistory() {
  playerStore.clearPlayHistory()
}

function playFromHistory(music) {
  // 不自动进大屏播放页：只在底部播放栏播放，与其它播放入口行为一致
  // 派发自定义事件让父组件播放
  const evt = new CustomEvent('pink-music:play-track', { detail: music })
  window.dispatchEvent(evt)
}

function openLogin() {
  // 通知父组件打开登录面板
  window.dispatchEvent(new CustomEvent('pink-music:open-login'))
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

function openGitHub() {
  if (window.electronAPI) {
    window.electronAPI.openGitHub()
  }
}

function openDownloadManager() {
  // 通过全局事件打开下载管理器
  const evt = new CustomEvent('pink-music:open-download')
  window.dispatchEvent(evt)
}

defineExpose({
  setActiveTab(tab) {
    activeTab.value = tab
  }
})

onMounted(() => {
  getCurrentDownloadDirectory()
  calculateCacheSize()
  updateStore.loadVersion()
  checkDiscordStatus()
  // 监听顶栏"主题设置"按钮派发的全局事件：切到 settings tab
  window.addEventListener('pink-music:open-settings', handleOpenSettings)
})

onBeforeUnmount(() => {
  window.removeEventListener('pink-music:open-settings', handleOpenSettings)
  // 快捷键录制监听兜底清理（组件卸载时若仍在录制）
  if (hotkeyRecording.value) stopHotkeyRecording()
})

function handleOpenSettings() {
  activeTab.value = 'settings'
}

// ============== Discord Rich Presence ==============
const discordStatusText = ref('检查中...')

async function checkDiscordStatus() {
  if (!window.electronAPI?.discord) {
    discordStatusText.value = 'Web 预览模式（Discord RPC 仅在 Electron 桌面端生效）'
    return
  }
  try {
    const res = await window.electronAPI.discord.getStatus()
    if (res?.data?.connected) {
      discordStatusText.value = '已连接到本地 Discord 客户端'
    } else {
      discordStatusText.value = '未检测到 Discord 客户端（请确认电脑已启动 Discord）'
    }
  } catch (_) {
    discordStatusText.value = '连接异常'
  }
}

function toggleDiscordRpc(enabled) {
  themeStore.setDiscordRpcEnabled(enabled)
  checkDiscordStatus()
}
</script>

<template>
  <section class="mine-view">
    <div class="mine-header">
      <h2 class="mine-title text-gradient">我的</h2>
      <div class="mine-tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.key"
          class="mine-tab"
          :class="{ active: activeTab === tab.key }"
          @click="activeTab = tab.key"
          role="tab"
          :aria-selected="activeTab === tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <!-- 三个二级 tab 切换：用 <Transition name="page" mode="out-in"> 复用 App.vue 主页切页同款动画
         （0.35s cubic-bezier(0.16, 1, 0.3, 1) + translateY 16px / 8px），保持"全应用一套节奏" -->
    <Transition name="page" mode="out-in">
    <!-- 我的 标签 -->
    <div v-if="activeTab === 'profile'" key="profile" class="mine-content">
      <div class="profile-card glass-card">
        <div v-if="hasUser" class="profile-info">
          <img
            :src="userStore.userInfo.face"
            class="profile-avatar"
            :alt="userStore.userInfo.uname"
            @error="$event.target.style.display='none'" loading="lazy" decoding="async" />
          <div class="profile-detail">
            <h3>{{ userStore.userInfo.uname }}</h3>
            <p>UID: {{ userStore.userInfo.mid }}</p>
            <div class="profile-actions">
              <button class="btn-primary" @click="openLogin">切换账号</button>
              <button class="btn-secondary" @click="handleSyncFavorites">同步收藏夹</button>
            </div>
          </div>
        </div>
        <div v-else class="profile-empty">
          <div class="profile-avatar profile-avatar-placeholder">
            <svg viewBox="0 0 24 24" fill="currentColor" width="32" height="32">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          </div>
          <div class="profile-detail">
            <h3>未登录</h3>
            <p>登录后可同步你的 B 站收藏夹</p>
            <div class="profile-actions">
              <button class="btn-primary" @click="openLogin">登录 B 站</button>
            </div>
          </div>
        </div>
      </div>

      <div class="quick-actions">
        <button class="quick-action glass-card" @click="activeTab = 'history'">
          <div class="quick-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z"/>
            </svg>
          </div>
          <div class="quick-info">
            <h4>播放历史</h4>
            <p>{{ playHistory.length }} 首</p>
          </div>
        </button>

        <button class="quick-action glass-card" @click="activeTab = 'settings'">
          <div class="quick-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.39-1.08-.7-1.66-.94l-.38-2.65c-.03-.24-.24-.42-.48-.42h-4c-.24 0-.45.18-.48.42l-.38 2.65c-.58.24-1.14.55-1.66.94l-2.49-1c-.22-.08-.49 0-.61.22l-2 3.46c-.12.22-.07.49.12.64l2.11 1.65c-.04.32-.07.64-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.39 1.08.7 1.66.94l.38 2.65c.03.24.24.42.48.42h4c.24 0 .45-.18.48-.42l.38-2.65c.58-.24 1.14-.55 1.66-.94l2.49 1c.22.08.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zm-7.43 2.52c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
            </svg>
          </div>
          <div class="quick-info">
            <h4>设置</h4>
            <p>主题、音质、缓存</p>
          </div>
        </button>

        <button class="quick-action glass-card" @click="openDownloadManager">
          <div class="quick-icon">
            <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
              <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
            </svg>
          </div>
          <div class="quick-info">
            <h4>下载管理</h4>
            <p>管理已下载音乐</p>
          </div>
        </button>
      </div>
    </div>

    <!-- 历史 标签 -->
    <div v-else-if="activeTab === 'history'" key="history" class="mine-content">
      <div class="history-header">
        <h3>播放历史</h3>
        <button v-if="playHistory.length > 0" class="btn-secondary" @click="clearPlayHistory">
          清空历史
        </button>
      </div>
      <div v-if="playHistory.length === 0" class="empty-state">
        <p>暂无播放历史</p>
      </div>
      <div v-else class="history-list">
        <div
          v-for="(music, index) in playHistory"
          :key="`${music.bvid}-${index}`"
          class="history-item glass-card"
          @click="playFromHistory(music)"
        >
          <span class="history-index">{{ index + 1 }}</span>
          <img
            :src="music.cover"
            :alt="music.title"
            class="history-cover"
            @error="$event.target.src='https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=100'" loading="lazy" decoding="async" />
          <div class="history-info">
            <h4>{{ music.title }}</h4>
            <p>{{ music.author }}</p>
          </div>
          <span class="history-duration">{{ parseDuration(music.duration) }}</span>
        </div>
      </div>
    </div>

    <!-- 设置 标签 -->
    <div v-else-if="activeTab === 'settings'" key="settings" class="mine-content">
      <!-- 主题设置：迁移自侧边栏的旧主题面板。
           模式（深/浅）+ 颜色（含 Apple Music）双层选择。 -->
      <div class="settings-section glass-card">
        <h3>主题设置</h3>
        <div class="setting-item">
          <label>主题模式</label>
          <div class="setting-value">
            <div class="theme-mode-buttons">
              <button
                v-for="t in themeOptions"
                :key="t.value"
                type="button"
                class="theme-mode-btn"
                :class="{ active: themeStore.currentTheme === t.value }"
                @click="selectTheme(t.value)"
              >
                {{ t.label }}
              </button>
            </div>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>主题颜色</label>
            <span class="setting-hint">选择 Apple Music 主题可启用封面模糊背景</span>
          </div>
          <div class="setting-value">
            <div class="color-picker">
              <div class="color-options-grid">
                <button
                  v-for="c in colorOptions"
                  :key="c.value"
                  type="button"
                  class="color-swatch-btn"
                  :class="['color-' + c.value, { active: themeStore.currentColor === c.value }]"
                  :style="{ backgroundColor: c.color }"
                  :title="c.label"
                  :aria-label="c.label"
                  @click="selectColor(c.value)"
                >
                  <svg v-if="themeStore.currentColor === c.value" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="14" height="14">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </button>
              </div>
              <span class="color-current-label">{{ currentColorLabel }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 自定义背景设置 -->
      <div class="settings-section glass-card">
        <h3>自定义背景</h3>
        <CustomBackgroundSettings />
      </div>

      <div class="settings-section glass-card">
        <h3>播放设置</h3>
        <div class="setting-item">
          <label>默认播放音质</label>
          <select
            v-model="settingsStore.audioQuality"
            @change="settingsStore.setAudioQuality(settingsStore.audioQuality)"
            class="quality-select"
          >
            <option value="auto">自动（最高可用）</option>
            <option value="lossless">无损</option>
            <option value="high">高音质</option>
            <option value="medium">中音质</option>
            <option value="low">低音质</option>
          </select>
        </div>
        <div class="setting-item">
          <label>大屏播放页频谱可视化</label>
          <div class="setting-value">
            <label
              class="switch"
              :title="settingsStore.audioVisualizerEnabled ? '关闭可视化' : '开启可视化'"
            >
              <input
                type="checkbox"
                :checked="settingsStore.audioVisualizerEnabled"
                @change="settingsStore.setAudioVisualizerEnabled($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="setting-item" :class="{ 'is-disabled': !settingsStore.audioVisualizerEnabled }">
          <div class="setting-label-with-hint">
            <label>可视化激进度</label>
            <span class="setting-hint">控制波纹模糊强度、密度、触发阈值</span>
          </div>
          <div class="setting-value slider-value">
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              :disabled="!settingsStore.audioVisualizerEnabled"
              :value="Math.round(pendingIntensity * 100)"
              @input="pendingIntensity = $event.target.value / 100"
              class="intensity-slider"
            >
            <span class="intensity-percent">{{ Math.round(pendingIntensity * 100) }}%</span>
            <button
              type="button"
              class="btn-apply"
              :class="{ 'is-active': intensityDirty }"
              :disabled="!settingsStore.audioVisualizerEnabled || !intensityDirty"
              :title="intensityDirty ? '应用新的激进度' : '已是当前生效值'"
              @click="applyIntensity"
            >
              应用
            </button>
            <button
              v-if="intensityDirty"
              type="button"
              class="btn-reset"
              title="放弃更改，恢复到当前生效值"
              @click="resetIntensity"
            >
              撤销
            </button>
          </div>
        </div>
      </div>

      <div class="settings-section glass-card">
        <h3>音频均衡器</h3>
        <div class="setting-item">
          <label>启用均衡器</label>
          <div class="setting-value">
            <label
              class="switch"
              :title="settingsStore.eqEnabled ? '关闭均衡器' : '开启均衡器'"
            >
              <input
                type="checkbox"
                :checked="settingsStore.eqEnabled"
                @change="settingsStore.setEQEnabled($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="eq-body" :class="{ 'is-disabled': !settingsStore.eqEnabled }">
          <div class="eq-toolbar">
            <div class="setting-label-with-hint">
              <label>预置曲线</label>
              <span class="setting-hint">快速切换常用 EQ 风格</span>
            </div>
            <div class="setting-value">
              <select
                class="quality-select eq-preset-select"
                :disabled="!settingsStore.eqEnabled"
                :value="settingsStore.eqPreset"
                @change="onPresetChange"
              >
                <option v-for="k in presetKeys" :key="k" :value="k">
                  {{ presetLabels[k] }}
                </option>
              </select>
              <button
                type="button"
                class="btn-secondary"
                :disabled="!settingsStore.eqEnabled"
                title="重置所有频段到 0dB"
                @click="onResetEQ"
              >
                重置
              </button>
              <button
                type="button"
                class="btn-apply"
                :class="{ 'is-active': eqDirty }"
                :disabled="!settingsStore.eqEnabled || !eqDirty"
                :title="eqDirty ? '把滑块当前值应用到音频' : '已是当前生效值'"
                @click="applyEQ"
              >
                应用
              </button>
              <button
                v-if="eqDirty"
                type="button"
                class="btn-reset"
                title="放弃更改，恢复到当前生效值"
                @click="revertEQ"
              >
                撤销
              </button>
            </div>
          </div>
          <div class="eq-bands">
            <div
              v-for="(band, i) in EQ_BANDS"
              :key="band.freq"
              class="eq-band"
            >
              <span class="eq-db" :class="pendingBands[i] > 0 ? 'is-pos' : pendingBands[i] < 0 ? 'is-neg' : ''">
                {{ formatDb(pendingBands[i]) }}
              </span>
              <div class="eq-slider-wrap">
                <div class="eq-track-zero"></div>
                <input
                  type="range"
                  orient="vertical"
                  :min="EQ_DB_MIN"
                  :max="EQ_DB_MAX"
                  step="0.5"
                  :disabled="!settingsStore.eqEnabled"
                  :value="pendingBands[i]"
                  :data-pos="pendingBands[i] > 0 ? 'pos' : pendingBands[i] < 0 ? 'neg' : 'zero'"
                  class="eq-slider"
                  @input="onBandInput(i, $event)"
                >
              </div>
              <span class="eq-freq">{{ band.label }}<span v-if="band.label.endsWith('K')">Hz</span></span>
            </div>
          </div>
        </div>
      </div>

      <div class="settings-section glass-card">
        <h3>窗口设置</h3>
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>窗口控制按钮</label>
            <span class="setting-hint">在右上角显示最小化、最大化、关闭按钮（macOS 使用系统交通灯）</span>
          </div>
          <div class="setting-value">
            <label
              class="switch"
              :title="settingsStore.windowControlsEnabled ? '关闭窗口控件' : '开启窗口控件'"
            >
              <input
                type="checkbox"
                :checked="settingsStore.windowControlsEnabled"
                @change="settingsStore.setWindowControlsEnabled($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>

      <div class="settings-section glass-card">
        <h3>歌词设置</h3>
        <div class="setting-item">
          <label>歌词显示模式</label>
          <div class="setting-value">
            <select
              v-model="settingsStore.lyricDisplayMode"
              @change="settingsStore.setLyricDisplayMode(settingsStore.lyricDisplayMode)"
              class="quality-select"
            >
              <option value="original">原文（无翻译）</option>
              <option value="romaji">原文 + 罗马音</option>
              <option value="translation">原文 + 中文翻译</option>
            </select>
          </div>
        </div>

        <!-- 默认歌词源：优先使用该源，取词失败时自动回退到另一个源（不是"唯一来源"） -->
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>默认歌词源</label>
            <span class="setting-hint">优先从该源取词，失败时自动回退到另一个源；已缓存的歌词与进度偏移不受影响</span>
          </div>
          <div class="setting-value">
            <select
              v-model="settingsStore.lyricPreferredSource"
              @change="settingsStore.setLyricPreferredSource(settingsStore.lyricPreferredSource)"
              class="quality-select"
            >
              <option value="kugou">酷狗（KRC，默认）</option>
              <option value="netease">网易云</option>
            </select>
          </div>
        </div>

        <!-- 桌面歌词全局快捷键 -->
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>桌面歌词快捷键</label>
            <span class="setting-hint">全局生效，应用未聚焦时也可开关桌面歌词；需包含至少一个修饰键（如 Shift）</span>
          </div>
          <div class="setting-value hotkey-control">
            <template v-if="!hotkeyRecording">
              <kbd class="hotkey-display" :class="{ 'is-conflict': hotkeyConflict }">{{ formatHotkey(settingsStore.desktopLyricsHotkey) }}</kbd>
              <button class="btn-secondary" @click="startHotkeyRecording">修改</button>
              <button
                v-if="settingsStore.desktopLyricsHotkey !== 'CommandOrControl+D'"
                class="btn-secondary"
                @click="resetHotkey"
              >恢复默认</button>
            </template>
            <template v-else>
              <kbd class="hotkey-display is-recording">{{ hotkeyPreview || '按下新组合…' }}</kbd>
              <span class="hotkey-tip">Esc 取消{{ hotkeyNeedModifier ? ' · 需要至少一个修饰键' : '' }}</span>
            </template>
          </div>
        </div>

        <!-- 高对比模式：浅色壁纸/浅色主题下歌词窗改用白字描边，避免歌词发虚 -->
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>高对比模式</label>
            <span class="setting-hint">浅色壁纸/浅色主题下改用白字描边，避免歌词发虚</span>
          </div>
          <div class="setting-value">
            <label class="switch" :title="settingsStore.desktopLyricsHighContrast ? '关闭高对比（恢复跟随主题的配色）' : '开启高对比（白字描边）'">
              <input
                type="checkbox"
                :checked="settingsStore.desktopLyricsHighContrast"
                @change="settingsStore.setDesktopLyricsHighContrast($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <p v-if="hotkeyConflict" class="setting-hint hotkey-error">该快捷键可能已被其他应用占用，已保留原快捷键，请换一个组合。</p>
        <p class="setting-hint">主行始终显示原文，选中的罗马音/翻译以小字附注在原文下方。部分歌曲可能没有罗马音或翻译数据，将自动只显示原文。桌面歌词同样跟随此设置。</p>
      </div>

      <div class="settings-section glass-card">
        <h3>本地音乐</h3>
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>收录「需转码」格式</label>
            <span class="setting-hint">wma / ape / dsf 等 Chromium 无法直接播放的格式也导入本地库（列表标记为需转码，不参与直接播放）</span>
          </div>
          <div class="setting-value">
            <label class="switch" :title="settingsStore.localIncludeUnplayable ? '关闭后导入时跳过这些格式' : '开启后一并导入并标记'">
              <input
                type="checkbox"
                :checked="settingsStore.localIncludeUnplayable"
                @change="settingsStore.setLocalIncludeUnplayable($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>启动时检测本地文件</label>
            <span class="setting-hint">启动后自动校验本地音乐文件是否仍存在，失效的曲目会被标记（不会自动删除记录或文件）</span>
          </div>
          <div class="setting-value">
            <label class="switch" :title="settingsStore.localCheckMissingOnStartup ? '关闭启动检测' : '开启启动检测'">
              <input
                type="checkbox"
                :checked="settingsStore.localCheckMissingOnStartup"
                @change="settingsStore.setLocalCheckMissingOnStartup($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>导入后自动匹配云端封面</label>
            <span class="setting-hint">导入本地音乐后，自动为缺少封面的曲目匹配云端封面（来源 iTunes / LrcApi / 网易云，单张 600×600）。有歌手时严格校对；无歌手时按歌名取第一个结果</span>
          </div>
          <div class="setting-value">
            <label class="switch" :title="settingsStore.localAutoFetchCover ? '关闭自动匹配' : '开启自动匹配'">
              <input
                type="checkbox"
                :checked="settingsStore.localAutoFetchCover"
                @change="settingsStore.setLocalAutoFetchCover($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- Discord Rich Presence 状态显示 -->
      <div class="settings-section glass-card">
        <h3>Discord Rich Presence (动态状态)</h3>
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>在 Discord 上显示正在播放</label>
            <span class="setting-hint">启用后将在 Discord 个人资料中实时显示当前歌曲、歌手、播放进度与专辑封面 (应用 ID: 1564248069632037035)</span>
          </div>
          <div class="setting-value">
            <label class="switch" :title="themeStore.discordRpcEnabled ? '关闭 Discord 状态同步' : '开启 Discord 状态同步'">
              <input
                type="checkbox"
                :checked="themeStore.discordRpcEnabled"
                @change="toggleDiscordRpc($event.target.checked)"
              >
              <span class="slider"></span>
            </label>
          </div>
        </div>
        <div class="setting-item">
          <div class="setting-label-with-hint">
            <label>连接状态</label>
            <span class="setting-hint">{{ discordStatusText }}</span>
          </div>
          <div class="setting-value">
            <button type="button" class="btn-secondary" @click="checkDiscordStatus">刷新状态</button>
          </div>
        </div>
      </div>

      <div class="settings-section glass-card">
        <h3>下载设置</h3>
        <div class="setting-item">
          <label>下载目录</label>
          <div class="setting-value">
            <span class="path-text">{{ downloadDirectory || '未设置' }}</span>
            <button class="btn-secondary" @click="selectDownloadDirectory">浏览</button>
          </div>
        </div>
      </div>

      <div class="settings-section glass-card">
        <h3>缓存管理</h3>
        <div class="setting-item">
          <label>当前缓存大小</label>
          <div class="setting-value">
            <span v-if="isCalculatingCache" class="loading-text">计算中...</span>
            <span v-else>{{ formatFileSize(cacheSize) }}</span>
            <button
              class="btn-danger"
              @click="showClearCacheConfirm = true"
              :disabled="isClearingCache"
            >
              {{ isClearingCache ? '清理中...' : '清理缓存' }}
            </button>
          </div>
        </div>
      </div>

      <div class="settings-section glass-card">
        <h3>关于</h3>
        <div class="about-content">
          <div class="about-header">
            <span class="logo-text">Pink Music</span>
            <span class="version">v{{ updateStore.currentVersion || '—' }}</span>
          </div>
          <p class="about-desc">一款优雅的 B 站音乐播放器，让你发现并享受喜欢的音乐。</p>
          <div class="update-row">
            <button
              class="btn-secondary"
              :disabled="updateStore.status === 'checking'"
              @click="checkUpdate"
            >
              {{ updateStore.status === 'checking' ? '检查中...' : '检查更新' }}
            </button>
            <button
              v-if="updateStore.hasUpdate"
              class="btn-primary"
              @click="showUpdateModal = true"
            >
              查看新版本 v{{ updateStore.latestVersion }}
            </button>
            <span
              v-if="updateStore.statusText"
              class="update-status"
              :class="{ 'is-available': updateStore.hasUpdate, 'is-error': updateStore.status === 'error' }"
            >{{ updateStore.statusText }}</span>
          </div>
          <div class="setting-item">
            <div class="setting-label-with-hint">
              <label>启动时自动检查更新</label>
              <span class="setting-hint">应用启动后自动检查是否有新版本</span>
            </div>
            <div class="setting-value">
              <label
                class="switch"
                :title="settingsStore.checkUpdateOnStartup ? '关闭自动检查' : '开启自动检查'"
              >
                <input
                  type="checkbox"
                  :checked="settingsStore.checkUpdateOnStartup"
                  @change="settingsStore.setCheckUpdateOnStartup($event.target.checked)"
                >
                <span class="slider"></span>
              </label>
            </div>
          </div>
          <button class="btn-secondary" @click="openGitHub">
            <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
            </svg>
            GitHub
          </button>
          <p class="developer-info">Developed by Rayson Liu</p>
        </div>
      </div>
    </div>
    </Transition>

    <!-- 清理缓存确认 -->
    <!-- Teleport 到 body：.main-content 是 position:relative + z-index:var(--z-base) 的层叠上下文，
         弹窗留在页面内部会被困在 z=1 这一层，Dock(--z-dock:70) 会压在弹窗与页脚按钮之上。 -->
    <Teleport to="body">
      <div v-if="showClearCacheConfirm" class="modal-overlay" @click="showClearCacheConfirm = false">
        <div class="modal small-modal" @click.stop>
          <h2>确认清理缓存</h2>
          <p>清理缓存将删除已缓存的音频、应用临时文件与网络缓存，<b>不会影响你的下载文件</b>，此操作不可恢复。</p>
          <div class="modal-buttons">
            <button class="btn-secondary" @click="showClearCacheConfirm = false">取消</button>
            <button class="btn-danger" @click="clearCache">确认清理</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 新版本发行说明 -->
    <Teleport to="body">
      <div v-if="showUpdateModal" class="modal-overlay" @click="showUpdateModal = false">
        <div class="modal update-modal" @click.stop>
          <h2>发现新版本 v{{ updateStore.latestVersion }}</h2>
          <p class="update-modal-meta">
            <span>当前版本 v{{ updateStore.currentVersion }}</span>
            <span v-if="formatPublishedAt(updateStore.publishedAt)">发布于 {{ formatPublishedAt(updateStore.publishedAt) }}</span>
          </p>
          <div class="release-notes" v-html="updateStore.notesHtml"></div>
          <div class="modal-buttons">
            <button class="btn-secondary" @click="showUpdateModal = false">稍后</button>
            <button class="btn-primary" @click="openReleasePage">前往下载</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>
