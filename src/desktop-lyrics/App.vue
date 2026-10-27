<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { findLineIndexAtTime } from '@/utils/lrcParser'

// ───────── 来自主窗口的状态（经 desktop-lyrics-state 消息流） ─────────
const lines = ref([])
const offsetMs = ref(0)
const trackTitle = ref('')
const trackArtist = ref('')
const displayMode = ref('original')   // original | romaji | translation，与大屏播放页设置一致
const locked = ref(false)
const hotkeyLabel = ref('')           // 解锁快捷键标签（如 ⌘D）：随 style 消息下发，锁定提示要用
const highContrast = ref(false)       // 高对比模式：主行白字 + 深色描边，副行同步提对比

// ───────── 主题色（主窗口解析后的 CSS 变量随 style 消息下发） ─────────
const primaryColor = ref('#FF69B4')
const primaryGradient = ref('')       // 可能为 linear-gradient(...) 或纯色值（apple-music 主题）

// ───────── 插值时间基准 ─────────
// 主窗口推送 { currentTime, isPlaying, sentAt(Date.now) } 快照；
// 本窗口用本地单调钟 performance.now() 锚定 sentAt 后逐帧推进。
const baseTime = ref(0)        // 秒
const isPlaying = ref(false)
let anchorPerfNow = 0          // 收到快照瞬间对应的本地 performance.now()
let rafId = 0
let lineDirty = true           // 是否有新快照需要重算行号（未播放时省掉逐帧重算）
const interpolatedTime = ref(0)

// ───────── UI 状态 ─────────
// 工具条常驻 DOM 且常驻占位（显隐只切 opacity），避免出现/消失造成布局跳动与遮挡。
const hovered = ref(false)
const currentLineIndex = ref(-1)

const trackLabel = computed(() => trackTitle.value + (trackArtist.value ? ' · ' + trackArtist.value : ''))
const trackTooltip = computed(() => trackTitle.value + ' - ' + trackArtist.value)
const hasLyric = computed(() => lines.value.length > 0)
const currentLine = computed(() =>
  currentLineIndex.value >= 0 ? lines.value[currentLineIndex.value] : null
)

/** 副行文本：按显示模式取罗马音/翻译（与主行同时显示） */
function subTextOf(line) {
  if (!line || displayMode.value === 'original') return ''
  if (displayMode.value === 'romaji') return line.romaji || ''
  if (displayMode.value === 'translation') return line.translation || ''
  return ''
}
const currentSub = computed(() => subTextOf(currentLine.value))

// ───────── 长行自适应字号 ─────────
// 行盒高度始终由基准字号（--dl-line-size）撑起：.dl-line 自己保持基准字号，被缩放的只有内层
// .dl-line-text。于是缩小只改变文字的视觉尺寸，行盒高度与基线不动 —— 切行不产生纵向跳动，
// 副行与工具条也完全不受影响。
const FIT_STEPS = [1, 0.88, 0.78, 0.7]   // 逐档缩放比例
const MIN_LINE_FONT = 12                 // 字号下限（px）
const rootRef = ref(null)
const bodyRef = ref(null)               // 歌词区：可用宽度只取自它，不依赖随 :key 重建的行元素
const measureRef = ref(null)            // 隐藏测量元素（同字体 + 基准字号 + nowrap）
const lineFontPx = ref(0)               // 0 = 还没测过，沿用基准字号
let resizeObserver = null
let fitFrame = 0

/** 零尺寸测量盒 + Range：宽度取自排版结果本身，不依赖盒子尺寸、也不撑大任何滚动区 */
function measureTextWidth(meas) {
  try {
    const range = document.createRange()
    range.selectNodeContents(meas)
    return range.getBoundingClientRect().width
  } catch (_) {
    return meas.getBoundingClientRect().width
  }
}

/** 按档位挑第一个「缩完不超宽」的字号；都不行才落到下限 */
function applyLineFit() {
  const meas = measureRef.value
  const body = bodyRef.value
  if (!meas || !body) return
  // 测量文字由这里直接写入（不靠模板插值），量到的永远是当前行，不受 patch 时序影响
  const text = currentLine.value?.text || ''
  if (meas.textContent !== text) meas.textContent = text
  const base = parseFloat(getComputedStyle(meas).fontSize) || 0
  if (!base) return
  const bodyStyle = getComputedStyle(body)
  const available = body.clientWidth - parseFloat(bodyStyle.paddingLeft) - parseFloat(bodyStyle.paddingRight)
  const natural = measureTextWidth(meas)
  let px = Math.max(MIN_LINE_FONT, base * FIT_STEPS[FIT_STEPS.length - 1])
  for (const step of FIT_STEPS) {
    const cand = Math.max(MIN_LINE_FONT, base * step)
    if (natural * (cand / base) <= available + 0.5) { px = cand; break }
  }
  px = Math.round(px * 10) / 10
  if (Math.abs(px - lineFontPx.value) > 0.05) lineFontPx.value = px
}

// 换行后先量一次（flush: post），再补一帧兜底；两次都在同一帧绘制前完成，用户看不到中间态
function scheduleLineFit() {
  applyLineFit()
  if (fitFrame) cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => { fitFrame = 0; applyLineFit() })
}

watch(currentLine, () => scheduleLineFit(), { flush: 'post', immediate: true })

// ───────── 样式：字号交给 CSS（随窗口高度收缩），颜色跟随主题 ─────────
/** 统一转成渐变写法：官方 --primary-gradient 若是纯色（apple-music），包一层同色渐变 */
const gradientCss = computed(() => {
  const g = primaryGradient.value.trim()
  if (/^linear-gradient/i.test(g)) return g
  const c = g || primaryColor.value
  return 'linear-gradient(135deg, ' + c + ' 0%, ' + c + ' 100%)'
})

/**
 * 主行文字：1 层投影 + 1px 文字描边。
 * 旧实现是 3 层 drop-shadow（2px / 8px / 10px 三张离屏模糊），透明窗逐帧重绘时 blur 半径越大
 * 越贵；合并成 1 层后边缘对比度由 1px 描边接手 —— 描边是字形轮廓绘制，不产生离屏模糊缓冲。
 */
const mainTextStyle = computed(() => highContrast.value
  ? {
      background: 'none',
      webkitBackgroundClip: 'border-box',
      backgroundClip: 'border-box',
      webkitTextFillColor: '#fff',
      color: '#fff',
      webkitTextStroke: '1.5px rgba(0, 0, 0, 0.92)',
      // 纯色填充 + paint-order：描边落在填充之下，白字厚度完全保留（渐变填充做不到，见 REPORT）
      paintOrder: 'stroke fill',
      filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.8))'
    }
  : {
      background: gradientCss.value,
      webkitBackgroundClip: 'text',
      backgroundClip: 'text',
      webkitTextFillColor: 'transparent',
      webkitTextStroke: '1px rgba(0, 0, 0, 0.22)',
      filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6))'
    })

/** 高对比副行：纯白 + 细描边；非高对比不加内联样式，完全维持 CSS 现状 */
const subTextStyle = computed(() => highContrast.value
  ? { color: '#fff', webkitTextStroke: '0.6px rgba(0, 0, 0, 0.75)', paintOrder: 'stroke fill', filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.85))' }
  : null)

const lineTextStyle = computed(() => (lineFontPx.value ? { fontSize: lineFontPx.value + 'px' } : null))

// ───────── 锁定提示 ─────────
// 锁定后整窗点击穿透，用户在本窗没有任何入口知道怎么解锁 —— 所以锁定瞬间必须自报快捷键。
const LOCK_TOAST_MS = 3000
const LOCK_TOAST_LEAVE_MS = 180
const lockToastText = ref('')
const lockToastVisible = ref(false)
const lockToastLeaving = ref(false)
let lockToastTimer = 0
let lockToastLeaveTimer = 0

function showLockToast() {
  const label = String(hotkeyLabel.value || '').trim()
  lockToastText.value = label ? '已锁定 · ' + label + ' 解锁' : '已锁定 · 按快捷键解锁'
  lockToastLeaving.value = false
  lockToastVisible.value = true
  clearTimeout(lockToastTimer)
  clearTimeout(lockToastLeaveTimer)
  lockToastTimer = setTimeout(() => {
    lockToastLeaving.value = true
    lockToastLeaveTimer = setTimeout(() => {
      lockToastVisible.value = false
      lockToastLeaving.value = false
    }, LOCK_TOAST_LEAVE_MS)
  }, LOCK_TOAST_MS)
}

function hideLockToast() {
  clearTimeout(lockToastTimer)
  clearTimeout(lockToastLeaveTimer)
  lockToastVisible.value = false
  lockToastLeaving.value = false
}

// ───────── 消息协议 ─────────
let unsubState = null

function applyProgress(payload) {
  baseTime.value = Number(payload.currentTime) || 0
  isPlaying.value = !!payload.isPlaying
  anchorPerfNow = performance.now() - Math.max(0, Date.now() - (Number(payload.sentAt) || Date.now()))
  lineDirty = true
}

function applyStyle(style) {
  if (!style || typeof style !== 'object') return
  if (typeof style.displayMode === 'string') displayMode.value = style.displayMode
  if (typeof style.primaryColor === 'string' && style.primaryColor) primaryColor.value = style.primaryColor
  if (typeof style.primaryGradient === 'string') primaryGradient.value = style.primaryGradient
  // hotkeyLabel 必须在 locked 之前落库：锁定提示的文案取自同一条 style 消息
  if (typeof style.hotkeyLabel === 'string') hotkeyLabel.value = style.hotkeyLabel
  if (typeof style.highContrast === 'boolean') highContrast.value = style.highContrast
  if (typeof style.locked === 'boolean' && style.locked !== locked.value) {
    locked.value = style.locked
    syncIgnoreMouse()
    if (locked.value) showLockToast()
    else hideLockToast()
  }
}

function syncIgnoreMouse() {
  try {
    window.desktopLyricsAPI?.setIgnoreMouseEvents?.(locked.value)
  } catch (_) {}
}

function sendCommand(action, payload = {}) {
  try {
    window.desktopLyricsAPI?.pushState?.({ type: 'command', action, ...payload })
  } catch (_) {}
}

// ───────── 工具条动作 ─────────
function toggleLock() {
  sendCommand('lock', { locked: true })   // 解锁只能从主窗口进（锁定后本窗收不到事件）
}
function closeWindow() {
  sendCommand('close')
}
function seekTo(line) {
  if (!line || locked.value) return
  // 与主窗口 handleLyricClick 一致：seek 目标要扣掉用户微调的 offset
  const adjusted = (Number(line.time) || 0) - (Number(offsetMs.value) || 0)
  sendCommand('seek', { time: Math.max(0, adjusted / 1000) })
}

// ───────── 插值循环 ─────────
function tick() {
  if (isPlaying.value) {
    interpolatedTime.value = baseTime.value + Math.max(0, performance.now() - anchorPerfNow) / 1000
  } else if (!lineDirty) {
    // 未播放且没有新进度/样式/歌词到达：时间与行号都不会变，不必逐帧重算
    rafId = requestAnimationFrame(tick)
    return
  } else {
    interpolatedTime.value = baseTime.value
  }
  lineDirty = false
  const idx = findLineIndexAtTime(lines.value, interpolatedTime.value, offsetMs.value)
  if (idx !== currentLineIndex.value) currentLineIndex.value = idx
  rafId = requestAnimationFrame(tick)
}

onMounted(() => {
  unsubState = window.desktopLyricsAPI?.onState?.((payload) => {
    if (!payload || !payload.type) return
    switch (payload.type) {
      case 'progress': applyProgress(payload); break
      case 'track':
        trackTitle.value = payload.title || ''
        trackArtist.value = payload.artist || ''
        break
      case 'lyrics':
        lines.value = Array.isArray(payload.lines) ? payload.lines : []
        offsetMs.value = Number(payload.offsetMs) || 0
        currentLineIndex.value = -1
        lineDirty = true
        break
      case 'style': applyStyle(payload); lineDirty = true; break
    }
  })
  syncIgnoreMouse()
  // 就绪握手：让主窗口立即重推全量快照，避免开窗瞬间消息早于本页加载而丢失
  try { window.desktopLyricsAPI?.notifyReady?.() } catch (_) {}
  rafId = requestAnimationFrame(tick)
  applyLineFit()
  // 窗口尺寸变化（--dl-line-size 跟着 vh 变）后重新测宽
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => applyLineFit())
    if (rootRef.value) resizeObserver.observe(rootRef.value)
  }
})

onUnmounted(() => {
  if (rafId) cancelAnimationFrame(rafId)
  resizeObserver?.disconnect()
  if (fitFrame) cancelAnimationFrame(fitFrame)
  hideLockToast()
  try { unsubState?.() } catch (_) {}
})
</script>

<template>
  <div ref="rootRef" class="dl-root" :class="{ locked, 'tb-open': hovered, 'is-hc': highContrast }"
       :data-track="trackLabel"
       @mouseenter="hovered = true" @mouseleave="hovered = false">
    <!-- 拖拽层：铺满窗口、位于所有可交互元素之下，只有空白像素会命中它 -->
    <div class="dl-drag" aria-hidden="true"></div>

    <!-- 顶部控制带：常驻占位，工具条与锁定角标都在带内，永不与歌词争夺同一块空间 -->
    <div class="dl-toolbar-band">
      <div class="dl-toolbar">
        <span class="tb-track" :title="trackTooltip">{{ trackLabel }}</span>
        <span class="tb-spacer"></span>
        <div class="tb-actions">
          <button class="tb-btn" title="锁定（在主窗口或 Ctrl/Cmd+D 解锁）" @click="toggleLock">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M17 8h-1V6a4 4 0 10-8 0v2H7a2 2 0 00-2 2v9a2 2 0 002 2h10a2 2 0 002-2v-9a2 2 0 00-2-2m-7-2a2 2 0 114 0v2h-4z"/></svg>
          </button>
          <button class="tb-btn tb-close" title="关闭桌面歌词" @click="closeWindow">
            <svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
          </button>
        </div>
      </div>
      <!-- 锁定角标：锁定后整窗点击穿透（主进程 setIgnoreMouseEvents），本窗不再提供可点元素 -->
      <div v-if="locked" class="dl-lock-badge" title="已锁定 · 在主窗口或 Ctrl/Cmd+D 解锁">已锁定</div>
    </div>

    <!-- 歌词主体：当前行 + 翻译/罗马音副行（长行逐档缩字号，缩到下限仍超宽才省略） -->
    <div ref="bodyRef" class="dl-body">
      <div v-if="!hasLyric" class="dl-empty">♪ 沒有歌詞<template v-if="trackTitle"> · {{ trackTitle }}</template></div>
      <template v-else>
        <p :key="'line-' + currentLineIndex" class="dl-line clickable" :style="mainTextStyle"
           title="点击跳转"
           @click="seekTo(currentLine)">
          <span class="dl-line-text" :style="lineTextStyle">{{ currentLine?.text }}</span>
        </p>
        <p v-if="currentSub" :key="'sub-' + currentLineIndex" class="dl-sub" :style="subTextStyle">{{ currentSub }}</p>
      </template>
      <!-- 宽度测量专用：同字体 + 基准字号 + nowrap + 零尺寸不可见；文字由 applyLineFit 直接写入 -->
      <span ref="measureRef" class="dl-measure" aria-hidden="true"></span>
      <!-- 锁定提示：锁定后整窗点击穿透，这是用户在本窗唯一能看到的解锁指引 -->
      <div v-if="lockToastVisible" class="dl-lock-toast" :class="{ 'is-leaving': lockToastLeaving }" role="status">{{ lockToastText }}</div>
    </div>
  </div>
</template>

<style scoped>
/*
 * 布局契约（修复重叠/越界的根因）
 * 1. 纵向两带 flex：控制带(34px) + 歌词带(flex:1, min-height:0)。
 *    旧版工具条是 absolute 覆盖在 34px 内边距上：pill 高 34px 从 top:4 排到 38px，而歌词带从
 *    34px 起，任何尺寸都固定叠 4px；300×60 时歌词带只剩 14px，30px 文字被 root 的
 *    overflow:hidden 直接裁掉，pill 里的按钮也被压成 15px 宽。改成流式两带后两者不可能相交。
 * 2. 字号交给 clamp + vh：窗口越矮字越小（默认 900×160 仍是 30px/15px/22px，视觉不变）。
 * 3. 拖拽层 .dl-drag 铺满窗口但 z-index:2，控制带(3)/工具条(4)/歌词行(3) 全在它之上：
 *    按钮与歌词永远命中 no-drag 元素，不会被 -webkit-app-region: drag 吞掉点击；控制带不被
 *    拖拽层覆盖，鼠标总能进入控制带唤出工具条（旧版整窗 drag，hover 事件被窗口拖拽区吞掉）。
 */
.dl-root {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100vw;
  height: 100vh;
  box-sizing: border-box;
  padding: 4px 0 12px;          /* 上 4px 让 pill 落在 y=4，与原 top:4 一致 */
  overflow: hidden;
  --dl-line-size: clamp(15px, 18.75vh, 30px);
  --dl-sub-size: clamp(11px, 9.375vh, 15px);
  --dl-empty-size: clamp(13px, 13.75vh, 22px);
  --dl-row-gap: 3px;
  font-family: 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  cursor: default;
  /* 文字不可选中：鼠标滑动不产生选区 */
  user-select: none;
  -webkit-user-select: none;
}

/* ── 拖拽层 ── */
.dl-drag {
  position: absolute;
  inset: 0;
  z-index: 2;
  -webkit-app-region: drag;
}
/* 锁定后整窗点击穿透，拖拽区不再有意义（也不再把鼠标事件转成窗口拖动） */
.dl-root.locked .dl-drag { -webkit-app-region: no-drag; }

/* ── 顶部控制带 ── */
.dl-toolbar-band {
  position: relative;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  height: 34px;
}

/* ── 工具条 ── */
.dl-toolbar {
  position: relative;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 2px;
  box-sizing: border-box;
  width: max-content;
  max-width: 100%;
  height: 34px;
  padding: 3px 8px;
  border-radius: 999px;
  background: rgba(20, 20, 28, 0.72);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  white-space: nowrap;
  /* 隐藏态：整条仍占位，只是不可见且不接收点击（避免"看不见却能点"的假按钮） */
  opacity: 0;
  transform: translateY(-6px);
  pointer-events: none;
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.dl-root.tb-open:not(.locked) .dl-toolbar {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}
.dl-root.locked .dl-toolbar {
  opacity: 0;
  transform: translateY(-6px);
  pointer-events: none;
}

/* 曲目名：唯一的可伸缩元素；按钮永远 flex:0 0 auto，任何宽度都不会被挤没 */
.tb-track {
  flex: 1 1 auto;
  min-width: 0;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: rgba(255, 255, 255, 0.65);
  margin-right: 4px;
}
/* 曲目名与按钮之间的最小间距：可压缩到 0，但按钮自身永不压缩。
   width 让它在 max-content 计算时贡献 12px（空元素的 max-content 宽度是 0），
   使 pill 宽度与原版完全一致。 */
.tb-spacer {
  flex: 0 1 12px;
  width: 12px;
  min-width: 0;
}
/*
 * 动作条：常规宽度下按内容撑开（flex:0 0 auto 的按钮永不被压缩）；
 * 极端情况（按钮总宽超过窗口）下它会收缩成一条横向溢出区：按钮尺寸不变、pill 不越出窗口、
 * 也不遮挡歌词——即"收进溢出区"这一档，不需要弹层即可保证窗口边界不被突破。
 */
.tb-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.tb-actions::-webkit-scrollbar { display: none; }
.tb-btn {
  -webkit-app-region: no-drag;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: rgba(255, 255, 255, 0.82);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.tb-btn:hover { background: rgba(255, 255, 255, 0.16); color: #fff; }
.tb-close:hover { background: rgba(255, 80, 110, 0.55); }

/* ── 锁定角标 ── */
.dl-lock-badge {
  position: absolute;
  top: 2px;                 /* 控制带顶端 4px + 2px = 原 top:6 */
  right: 10px;
  z-index: 4;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11px;
  letter-spacing: 1px;
  color: rgba(255, 255, 255, 0.55);
  background: rgba(20, 20, 28, 0.35);
  pointer-events: none;
}

/* ── 歌词主体 ── */
.dl-body {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--dl-row-gap);
  flex: 1 1 auto;
  min-height: 0;
  /* 底部 -4px：控制带比旧版内边距多占 4px，这里还回去，歌词视觉中心与原版一致
     （600×160 时行框 y=72.3，与修复前逐像素相同） */
  padding: 0 20px 4px;
  overflow: hidden;
}
.dl-line {
  position: relative;
  z-index: 3;
  margin: 0;
  font-size: var(--dl-line-size);
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dl-line.clickable { cursor: pointer; }
/*
 * 行切换过渡：只在「换行」这一个动作上淡入 + 轻微上移（纵向 4px，无任何横向位移）。
 * 行元素随 :key 重建，动画自然重播；fill: both 保证首帧不会先闪现全文。
 * 位移只发生在 .dl-body 内部（overflow: hidden 裁掉越界部分），不可能碰到控制带。
 */
.dl-line, .dl-sub { animation: dl-row-in 140ms ease-out both; }
@keyframes dl-row-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.dl-sub {
  position: relative;
  z-index: 3;
  margin: 0;
  font-size: var(--dl-sub-size);
  font-weight: 500;
  line-height: 1.25;
  text-align: center;
  max-width: 100%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(255, 255, 255, 0.85);
  filter: drop-shadow(0 1px 1.5px rgba(0, 0, 0, 0.55));
}
.dl-empty {
  position: relative;
  z-index: 3;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--dl-empty-size);
  font-weight: 600;
  color: rgba(255, 255, 255, 0.75);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.6));
}

/*
 * 测量元素：与 .dl-line 同字体同字重、恒定基准字号、nowrap。
 * 盒子被压成 0×0 且 overflow:hidden —— 既不参与 flex 布局、不绘制，也不会撑大任何滚动区；
 * 文字宽度由 Range.getBoundingClientRect() 取出（排版结果本身，不受盒子裁剪影响）。
 */
.dl-measure {
  position: absolute;
  top: 0;
  left: 0;
  z-index: 0;
  width: 0;
  height: 0;
  overflow: hidden;
  margin: 0;
  font-size: var(--dl-line-size);
  font-weight: 700;
  line-height: 1.25;
  white-space: pre;
  visibility: hidden;
  pointer-events: none;
}

/* 锁定提示：贴歌词区底部 —— 控制带之外，常规尺寸下压在歌词块下方的空白里，不压歌词与工具条 */
.dl-lock-toast {
  position: absolute;
  bottom: 4px;
  left: 50%;
  z-index: 6;
  max-width: calc(100% - 8px);
  padding: 3px 12px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: rgba(20, 20, 28, 0.82);
  color: #fff;
  font-size: clamp(10px, 2.2vh, 13px);
  font-weight: 600;
  letter-spacing: 0.5px;
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  animation: dl-toast-in 140ms ease-out both;
}
.dl-lock-toast.is-leaving {
  animation: none;
  opacity: 0;
  transition: opacity 0.18s linear;
}
@keyframes dl-toast-in {
  from { opacity: 0; transform: translate(-50%, 4px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}

/*
 * 降级阶梯 1：窄窗先隐藏曲目名，只留图标（300px 宽时按钮仍有完整 26px 点击区）
 * 降级阶梯 2：更窄时缩小图标与内边距
 */
@media (max-width: 520px) {
  .tb-track { display: none; }
}
@media (max-width: 359px) {
  .dl-toolbar { padding: 3px 6px; }
  .dl-toolbar, .tb-actions { gap: 0; }
  .tb-btn { width: 24px; height: 24px; }
}

/*
 * 矮窗（≤119px，含 300×60 最小尺寸）：控制带与歌词并排成一行。
 * 工具条在这一档常显——窗口只有几十像素高时，藏在 hover 后的按钮等于不可达。
 */
@media (max-height: 119px) {
  .dl-root {
    flex-direction: row;
    align-items: center;
    gap: 8px;
    padding: 0 10px;
    --dl-line-size: clamp(12px, 26vh, 22px);
    --dl-sub-size: clamp(10px, 12vh, 13px);
    --dl-empty-size: clamp(12px, 26vh, 18px);
  }
  .dl-toolbar-band {
    order: 2;
    /* 可收缩：极端按钮数量下由 band 承担，pill 不会把整行撑出窗口 */
    flex: 0 1 auto;
    min-width: 0;
    height: auto;
    gap: 6px;
  }
  .dl-root:not(.locked) .dl-toolbar {
    opacity: 1;
    transform: none;
    pointer-events: auto;
  }
  .dl-body {
    order: 1;
    /* basis 0：超长歌词不参与挤压控制带（否则长歌词会把 pill 挤到只剩几像素） */
    flex: 1 1 0;
    /* 歌词至少保留 96px（≈5 个汉字 + 省略号），更窄时由动作条自己横向滚动 */
    min-width: 96px;
    padding: 0;
  }
  .dl-lock-badge {
    position: static;
    top: auto;
    right: auto;
    flex: 0 0 auto;
  }
}

@media (prefers-reduced-motion: reduce) {
  .dl-toolbar, .tb-btn { transition: none; }
  /* 行切换与锁定提示的动效一并关闭：直接呈现终态 */
  .dl-line, .dl-sub, .dl-lock-toast { animation: none; }
}
</style>
