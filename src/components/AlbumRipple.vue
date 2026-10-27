<script setup>
/**
 * 大屏播放页 · 封面周围扩散的音频波纹
 *
 * 视觉：
 * - 多个同心圆从封面中心向外扩散
 * - 整层 canvas 用 ctx.filter blur 模糊化，和封面/歌词形成"前后景分层"的感觉
 * - 激进度（intensity prop）控制：模糊强度、透明度、环密度、触发阈值
 *
 * 性能：
 * - 单 canvas 绘制，requestAnimationFrame 节奏
 * - 最多 MAX_RINGS 并发环，环形队列复用，无 GC 压力
 * - ctx.filter blur 在每帧重设，开销可接受（现代 GPU 加速）
 */
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { getAnalyser, isAnalyserReady } from '@/utils/audioAnalyser'

const props = defineProps({
  // 激进度 0-1，由 settingsStore.audioVisualizerIntensity 提供
  // 0 极保守（弱触发、低模糊），1 极激进（强触发、强模糊）
  intensity: {
    type: Number,
    default: 0.6
  }
})

const domCanvas = ref(null)

let ctx = null
let WIDTH = 0
let HEIGHT = 0
let dpr = 1
let isDark = true
let themeColor = ''
let isAppleMusic = false

function readTheme() {
  const style = getComputedStyle(document.documentElement)
  themeColor = (style.getPropertyValue('--primary-color') || '#FF69B4').trim()
  isDark = document.documentElement.getAttribute('data-theme') !== 'light'
  isAppleMusic = document.documentElement.getAttribute('data-color') === 'apple-music'
}

// === 基础环参数（与 intensity 解耦的常量）===
const RING_LIFE = 1.6        // 环寿命（秒）
const SPAWN_COOLDOWN = 0.25  // 生成冷却（秒）
const RIPPLE_MAX_RADIUS = 220 // 环最大半径（px）

/**
 * 根据激进度派生所有视觉参数。
 *
 * 激进度影响四个维度（每个 1% 滑块都对应肉眼可见的变化）：
 * 1. 模糊强度 blurPx:        1.5 → 16 px（曲线 t^0.7，低段更敏感）
 * 2. 触发阈值 spawnThreshold: 0.6 → 0.15（曲线 sqrt(t)，低段更敏感：1%→10% 阈值从 0.6→0.46）
 * 3. 透明度倍率 alphaBoost:  0.4 → 1.6（线性）
 * 4. 环数量 maxRings:         2 → 10（取整，所以低段连续多 % 才 +1）
 *
 * 模糊封顶 16px：ctx.filter=blur(20+) 在 600x600 canvas 上会让 GPU 吃紧、出现闪屏。
 *
 * 设计原则：
 * - 低段（0-30%）参数变化快，给用户"细腻控制"的反馈
 * - 高段（70-100%）逐步逼近极限，但视觉差异仍然可感
 * - 0% 和 100% 差异要足够戏剧性（模糊 10x、环数 5x、阈值 4x）
 */
function getDerivedParams() {
  const t = Math.max(0, Math.min(1, props.intensity || 0))
  const blurT = Math.pow(t, 0.7)        // 低段模糊变化更陡
  const thresholdT = Math.sqrt(t)        // 低段阈值变化更陡
  return {
    blurPx: 1.5 + blurT * 14.5,          // 1.5 → 16
    spawnThreshold: 0.6 - thresholdT * 0.45,  // 0.6 → 0.15
    alphaBoost: 0.4 + t * 1.2,           // 0.4 → 1.6
    maxRings: Math.round(2 + t * 8)      // 2 → 10
  }
}

// 环形队列
const rings = []
let lastSpawnTime = -Infinity
let lastEnergy = 0
let themeObserver = null
let resizeObserver = null
let animationId = null
let startTimestamp = 0
let isActive = false
let dataArray = null

function resizeCanvas() {
  const canvas = domCanvas.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  dpr = Math.min(window.devicePixelRatio || 1, 2)
  canvas.width = Math.max(1, Math.floor(rect.width * dpr))
  canvas.height = Math.max(1, Math.floor(rect.height * dpr))
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  WIDTH = rect.width
  HEIGHT = rect.height
}

function spawnRing(intensity) {
  const { maxRings } = getDerivedParams()
  // 复用最旧的环（环形队列）
  const ring = rings.length < maxRings
    ? { startTime: performance.now() / 1000, intensity }
    : rings.shift()
  ring.startTime = performance.now() / 1000
  ring.intensity = intensity
  rings.push(ring)
}

function getLowFreqEnergy() {
  const analyser = getAnalyser()
  if (!analyser) return 0
  const bins = analyser.frequencyBinCount
  if (!dataArray || dataArray.length !== bins) {
    dataArray = new Uint8Array(bins)
  }
  analyser.getByteFrequencyData(dataArray)
  // 取前 8 个 bin（最低频，鼓点所在）
  let sum = 0
  const N = Math.min(8, bins)
  for (let i = 0; i < N; i++) sum += dataArray[i]
  return (sum / N) / 255
}

function drawFrame(timestamp) {
  if (!ctx || !WIDTH) {
    animationId = null
    return
  }
  if (!startTimestamp) startTimestamp = timestamp
  const tNow = performance.now() / 1000

  // 派生激进度参数
  const { blurPx, spawnThreshold, alphaBoost } = getDerivedParams()

  // === 1. 读取音频 + 判断是否生成新环 ===
  const analyser = getAnalyser()
  if (analyser && dataArray) {
    const energy = getLowFreqEnergy()
    // 用"低频上升沿"触发新环：本次能量比上次高且超过阈值
    if (
      energy > spawnThreshold &&
      energy > lastEnergy + 0.05 &&
      tNow - lastSpawnTime > SPAWN_COOLDOWN
    ) {
      spawnRing(energy)
      lastSpawnTime = tNow
    }
    lastEnergy = energy
  }

  // === 2. 清屏 + 绘制所有活跃环 ===
  ctx.clearRect(0, 0, WIDTH, HEIGHT)
  const cx = WIDTH / 2
  const cy = HEIGHT / 2

  // 整层 canvas 模糊化：让所有环糊在一起、和封面/歌词形成"前后景分层"
  // （设了 filter 后所有后续绘制都会被 blur）
  ctx.filter = `blur(${blurPx}px)`
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  for (let i = 0; i < rings.length; i++) {
    const ring = rings[i]
    const age = tNow - ring.startTime
    if (age >= RING_LIFE) continue

    // 生命曲线 0 → 1：前 25% 加速扩散，后 75% 匀速
    const lifeT = age / RING_LIFE // 0-1
    const radius = lifeT < 0.25
      ? RIPPLE_MAX_RADIUS * (lifeT * 2.4) // 0 → 0.6 半径
      : RIPPLE_MAX_RADIUS * (0.6 + (lifeT - 0.25) * 0.57) // 0.6 → 1.0 半径

    // 透明度：1 → 0，二次曲线 + 激进度倍率
    const baseAlpha = Math.pow(1 - lifeT, 1.4) * ring.intensity * alphaBoost
    const alpha = baseAlpha * (isDark ? 0.9 : 0.55)

    // 线宽：开始时细，扩散时变粗再变细；激进度越高线越粗
    const widthBoost = (Math.sin(lifeT * Math.PI) * 2 + 1.5) * (0.8 + alphaBoost * 0.4)
    ctx.lineWidth = widthBoost
    ctx.strokeStyle = themeColor
    ctx.globalAlpha = alpha

    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(0, radius), 0, Math.PI * 2)
    ctx.stroke()
  }

  // 重置 filter 和 alpha（防止影响其他 canvas 操作）
  ctx.filter = 'none'
  ctx.globalAlpha = 1

  // 清理过期环
  for (let i = rings.length - 1; i >= 0; i--) {
    if (tNow - rings[i].startTime >= RING_LIFE) rings.splice(i, 1)
  }

  if (isActive) animationId = requestAnimationFrame(drawFrame)
}

function start() {
  if (animationId) return
  if (!getAnalyser()) return
  // 初始化 dataArray
  const analyser = getAnalyser()
  if (analyser) {
    dataArray = new Uint8Array(analyser.frequencyBinCount)
  }
  isActive = true
  startTimestamp = 0
  animationId = requestAnimationFrame(drawFrame)
}

function stop() {
  isActive = false
  if (animationId) {
    cancelAnimationFrame(animationId)
    animationId = null
  }
}

let checkInterval = null
function watchAnalyser() {
  if (checkInterval) return
  checkInterval = setInterval(() => {
    if (!isAnalyserReady()) return
    clearInterval(checkInterval)
    checkInterval = null
    if (!isActive) start()
  }, 200)
}

onMounted(() => {
  readTheme()
  const canvas = domCanvas.value
  if (!canvas) return
  ctx = canvas.getContext('2d')
  resizeCanvas()

  resizeObserver = new ResizeObserver(() => resizeCanvas())
  resizeObserver.observe(canvas)

  themeObserver = new MutationObserver(() => readTheme())
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-color']
  })

  if (isAnalyserReady()) start()
  else watchAnalyser()
})

onBeforeUnmount(() => {
  stop()
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null }
  if (themeObserver) { themeObserver.disconnect(); themeObserver = null }
  if (checkInterval) { clearInterval(checkInterval); checkInterval = null }
})
</script>

<template>
  <div :class="['album-ripple', { 'is-dark': isDark, 'is-light': !isDark, 'is-apple-music': isAppleMusic }]">
    <canvas ref="domCanvas" class="album-ripple-canvas"></canvas>
  </div>
</template>

<style scoped>
/* 父容器：放在 .album-art-zone 里，绝对定位 + 居中变换 */
.album-ripple {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 600px;
  height: 600px;
  transform: translate(-50%, -50%);
  pointer-events: none;
  z-index: 0; /* 在封面之下（封面 z-index: 1） */
}

.album-ripple-canvas {
  display: block;
  width: 100%;
  height: 100%;
  /* hint：让浏览器把 canvas 提到独立 GPU 层，避免每次 ctx.filter 变化触发
     整页重绘导致波纹"闪" */
  will-change: filter;
  transform: translateZ(0);
}

/* Apple Music 主题：隐藏波纹（Apple Music 原生没有这种视觉效果） */
.album-ripple.is-apple-music {
  display: none !important;
}
</style>
