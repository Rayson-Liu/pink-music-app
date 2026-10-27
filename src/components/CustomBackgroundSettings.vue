<script setup>
import { ref } from 'vue'
import { useThemeStore } from '@/stores'

const themeStore = useThemeStore()
const fileInputRef = ref(null)
const customUrlInput = ref('')
const uploadError = ref('')

const PRESET_WALLPAPERS = [
  {
    name: '星空霓虹',
    url: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=1920&auto=format&fit=crop',
    preview: 'https://images.unsplash.com/photo-1518709268805-4e9042af9f23?q=80&w=300&auto=format&fit=crop'
  },
  {
    name: '日落霞光',
    url: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?q=80&w=1920&auto=format&fit=crop',
    preview: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?q=80&w=300&auto=format&fit=crop'
  },
  {
    name: '音乐质感',
    url: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=1920&auto=format&fit=crop',
    preview: 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?q=80&w=300&auto=format&fit=crop'
  }
]

const POSITION_PRESETS = [
  { key: 'center', label: '居中' },
  { key: 'top', label: '置顶' },
  { key: 'bottom', label: '置底' },
  { key: 'left', label: '靠左' },
  { key: 'right', label: '靠右' }
]

const BLUR_PRESETS = [
  { value: 0, label: '清晰 (0px)' },
  { value: 8, label: '微弱 (8px)' },
  { value: 16, label: '柔和 (16px)' },
  { value: 30, label: '深度 (30px)' }
]

const UI_OPACITY_PRESETS = [
  { value: 0.3, label: '極致通透 (30%)' },
  { value: 0.6, label: '半透明 (60%)' },
  { value: 0.85, label: '標準 (85%)' },
  { value: 1.0, label: '不透明 (100%)' }
]

const isElectron = ref(typeof window !== 'undefined' && !!window.electronAPI?.setWindowOpacity)

function triggerFileSelect() {
  if (fileInputRef.value) {
    fileInputRef.value.value = ''
    fileInputRef.value.click()
  }
}

async function handleFileChange(event) {
  const file = event.target?.files?.[0]
  if (!file) return
  uploadError.value = ''

  if (!file.type.startsWith('image/')) {
    uploadError.value = '请选择有效的图片文件 (PNG, JPG, WebP 等)'
    return
  }

  try {
    const dataUrl = await compressImageFile(file)
    themeStore.setCustomBgUrl(dataUrl)
    themeStore.setCustomBgEnabled(true)
  } catch (err) {
    console.error('图片加载失败:', err)
    uploadError.value = '图片加载失败，请重试'
  }
}

function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      const img = new Image()
      img.onload = () => {
        const maxWidth = 1920
        const maxHeight = 1080
        let { width, height } = img
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, width, height)
        // 采用高质量 JPEG 压缩保持清晰同时压缩到 ~200KB 避免存储超出
        const dataUrl = canvas.toDataURL('image/jpeg', 0.88)
        resolve(dataUrl)
      }
      img.onerror = () => reject(new Error('无法解析图片'))
      img.src = e.target.result
    }
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

function applyCustomUrl() {
  const url = customUrlInput.value.trim()
  if (!url) return
  uploadError.value = ''
  themeStore.setCustomBgUrl(url)
  themeStore.setCustomBgEnabled(true)
  customUrlInput.value = ''
}

function selectPreset(preset) {
  uploadError.value = ''
  themeStore.setCustomBgUrl(preset.url)
  themeStore.setCustomBgEnabled(true)
}

function clearBackground() {
  themeStore.clearCustomBg()
  uploadError.value = ''
}

function resetParameters() {
  themeStore.resetCustomBgParams()
}
</script>

<template>
  <div class="custom-bg-settings">
    <!-- 主开关 -->
    <div class="setting-item">
      <div class="setting-label-with-hint">
        <label>启用自定义背景</label>
        <span class="setting-hint">可自订任意图片作为背景，并调整透明度、模糊与位置</span>
      </div>
      <div class="setting-value">
        <label class="switch" :title="themeStore.customBgEnabled ? '关闭自定义背景' : '开启自定义背景'">
          <input
            type="checkbox"
            :checked="themeStore.customBgEnabled"
            @change="themeStore.setCustomBgEnabled($event.target.checked)"
          >
          <span class="slider"></span>
        </label>
      </div>
    </div>

    <!-- 背景详细调节区（仅当启用或有图片时展开） -->
    <div v-if="themeStore.customBgEnabled" class="custom-bg-controls">
      <!-- 1. 背景图片选择 -->
      <div class="setting-item bg-upload-item">
        <div class="setting-label-with-hint">
          <label>背景图片</label>
          <span class="setting-hint">支持本地文件或在线图片 URL</span>
        </div>
        <div class="setting-value bg-upload-value">
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*"
            class="hidden-file-input"
            @change="handleFileChange"
          >
          <div class="bg-upload-actions">
            <button type="button" class="btn-primary-sm" @click="triggerFileSelect">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span>选择本地图片</span>
            </button>
            <button
              v-if="themeStore.customBgUrl"
              type="button"
              class="btn-danger-sm"
              @click="clearBackground"
              title="清除当前自定义背景"
            >
              清除背景
            </button>
          </div>
        </div>
      </div>

      <!-- 图片 URL 输入与预设推荐 -->
      <div class="bg-url-row">
        <input
          v-model="customUrlInput"
          type="text"
          placeholder="或在此输入网络图片地址 (https://...)"
          class="bg-url-input"
          @keyup.enter="applyCustomUrl"
        >
        <button type="button" class="btn-apply-url" @click="applyCustomUrl">应用链接</button>
      </div>

      <!-- 推荐壁纸快捷选择 -->
      <div class="preset-wallpapers-section">
        <span class="preset-title">精选壁纸推荐：</span>
        <div class="preset-grid">
          <button
            v-for="p in PRESET_WALLPAPERS"
            :key="p.name"
            type="button"
            class="preset-card"
            :class="{ active: themeStore.customBgUrl === p.url }"
            :style="{ backgroundImage: `url(${p.preview})` }"
            @click="selectPreset(p)"
          >
            <span class="preset-name">{{ p.name }}</span>
          </button>
        </div>
      </div>

      <div v-if="uploadError" class="upload-error-tip">{{ uploadError }}</div>

      <!-- 当前背景缩略图预览卡片 -->
      <div v-if="themeStore.customBgUrl" class="bg-preview-card">
        <div class="bg-preview-thumb" :style="{ backgroundImage: `url(${themeStore.customBgUrl})` }"></div>
        <div class="bg-preview-info">
          <span class="bg-status-tag">当前背景已就绪</span>
          <span class="bg-hint-text">可通过下方滑块即时微调视觉表现</span>
        </div>
      </div>

      <!-- 2. 背景透明度调整 -->
      <div class="setting-item">
        <div class="setting-label-with-hint">
          <label>背景图片透明度</label>
          <span class="setting-hint">控制背景图片显现程度</span>
        </div>
        <div class="setting-value slider-value">
          <input
            type="range"
            min="10"
            max="100"
            step="1"
            :value="Math.round(themeStore.customBgOpacity * 100)"
            class="param-slider"
            @input="themeStore.setCustomBgOpacity($event.target.value / 100)"
          >
          <span class="param-badge">{{ Math.round(themeStore.customBgOpacity * 100) }}%</span>
        </div>
      </div>

      <!-- 2.1 界面透明度调整 -->
      <div class="setting-item">
        <div class="setting-label-with-hint">
          <label>界面透明度</label>
          <span class="setting-hint">控制侧边栏、播放栏与卡片面板透光度，让背景更通透</span>
        </div>
        <div class="setting-value slider-value">
          <input
            type="range"
            min="10"
            max="100"
            step="1"
            :value="Math.round((themeStore.uiOpacity ?? 0.85) * 100)"
            class="param-slider"
            @input="themeStore.setUiOpacity($event.target.value / 100)"
          >
          <span class="param-badge">{{ Math.round((themeStore.uiOpacity ?? 0.85) * 100) }}%</span>
        </div>
      </div>

      <!-- 界面透明度快捷档位 -->
      <div class="quick-preset-chips">
        <button
          v-for="op in UI_OPACITY_PRESETS"
          :key="op.value"
          type="button"
          class="chip-btn"
          :class="{ active: Math.round((themeStore.uiOpacity ?? 0.85) * 100) === Math.round(op.value * 100) }"
          @click="themeStore.setUiOpacity(op.value)"
        >
          {{ op.label }}
        </button>
      </div>

      <!-- 2.2 视窗整体透明度（仅 Electron 桌面端） -->
      <div v-if="isElectron" class="setting-item">
        <div class="setting-label-with-hint">
          <label>桌面视窗透明度</label>
          <span class="setting-hint">调节整个应用程序视窗透明度，可透出系统桌面壁纸</span>
        </div>
        <div class="setting-value slider-value">
          <input
            type="range"
            min="30"
            max="100"
            step="1"
            :value="Math.round((themeStore.windowOpacity ?? 1) * 100)"
            class="param-slider"
            @input="themeStore.setWindowOpacity($event.target.value / 100)"
          >
          <span class="param-badge">{{ Math.round((themeStore.windowOpacity ?? 1) * 100) }}%</span>
        </div>
      </div>

      <!-- 3. 模糊度调整 -->
      <div class="setting-item">
        <div class="setting-label-with-hint">
          <label>模糊程度 (毛玻璃)</label>
          <span class="setting-hint">模糊背景可让界面元素更加清晰</span>
        </div>
        <div class="setting-value slider-value">
          <input
            type="range"
            min="0"
            max="40"
            step="1"
            :value="themeStore.customBgBlur"
            class="param-slider"
            @input="themeStore.setCustomBgBlur(Number($event.target.value))"
          >
          <span class="param-badge">{{ themeStore.customBgBlur }}px</span>
        </div>
      </div>

      <!-- 模糊度快捷档位 -->
      <div class="quick-preset-chips">
        <button
          v-for="b in BLUR_PRESETS"
          :key="b.value"
          type="button"
          class="chip-btn"
          :class="{ active: themeStore.customBgBlur === b.value }"
          @click="themeStore.setCustomBgBlur(b.value)"
        >
          {{ b.label }}
        </button>
      </div>

      <!-- 4. 缩放大小调整 -->
      <div class="setting-item">
        <div class="setting-label-with-hint">
          <label>缩放大小</label>
          <span class="setting-hint">调整背景图片的放大或缩小比例</span>
        </div>
        <div class="setting-value slider-value">
          <input
            type="range"
            min="50"
            max="200"
            step="5"
            :value="Math.round(themeStore.customBgScale * 100)"
            class="param-slider"
            @input="themeStore.setCustomBgScale($event.target.value / 100)"
          >
          <span class="param-badge">{{ Math.round(themeStore.customBgScale * 100) }}%</span>
        </div>
      </div>

      <!-- 适应模式选择 -->
      <div class="setting-item">
        <div class="setting-label-with-hint">
          <label>适应模式</label>
          <span class="setting-hint">图片在视窗中的填充方式</span>
        </div>
        <div class="setting-value">
          <div class="mode-buttons">
            <button
              type="button"
              class="mode-btn"
              :class="{ active: themeStore.customBgFit === 'cover' }"
              @click="themeStore.setCustomBgFit('cover')"
            >
              填充裁剪 (Cover)
            </button>
            <button
              type="button"
              class="mode-btn"
              :class="{ active: themeStore.customBgFit === 'contain' }"
              @click="themeStore.setCustomBgFit('contain')"
            >
              完整适应 (Contain)
            </button>
            <button
              type="button"
              class="mode-btn"
              :class="{ active: themeStore.customBgFit === 'custom' }"
              @click="themeStore.setCustomBgFit('custom')"
            >
              自订尺寸
            </button>
          </div>
        </div>
      </div>

      <!-- 5. 位置调整 (Preset + X/Y Sliders) -->
      <div class="setting-item">
        <div class="setting-label-with-hint">
          <label>背景位置</label>
          <span class="setting-hint">选择预设方位或通过滑块精准微调</span>
        </div>
        <div class="setting-value">
          <div class="mode-buttons">
            <button
              v-for="p in POSITION_PRESETS"
              :key="p.key"
              type="button"
              class="mode-btn"
              :class="{ active: themeStore.customBgPosition === p.key }"
              @click="themeStore.setCustomBgPosition(p.key)"
            >
              {{ p.label }}
            </button>
          </div>
        </div>
      </div>

      <!-- X / Y 轴微调 -->
      <div class="pos-sliders-grid">
        <div class="pos-slider-group">
          <span class="pos-label">水平 (X): {{ themeStore.customBgPosX }}%</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            :value="themeStore.customBgPosX"
            class="param-slider"
            @input="themeStore.setCustomBgPosX(Number($event.target.value))"
          >
        </div>
        <div class="pos-slider-group">
          <span class="pos-label">垂直 (Y): {{ themeStore.customBgPosY }}%</span>
          <input
            type="range"
            min="0"
            max="100"
            step="1"
            :value="themeStore.customBgPosY"
            class="param-slider"
            @input="themeStore.setCustomBgPosY(Number($event.target.value))"
          >
        </div>
      </div>

      <!-- 6. 遮罩暗度 -->
      <div class="setting-item">
        <div class="setting-label-with-hint">
          <label>遮罩暗度</label>
          <span class="setting-hint">叠加深色半透明层，确保白色文字与歌词清晰可读</span>
        </div>
        <div class="setting-value slider-value">
          <input
            type="range"
            min="0"
            max="80"
            step="5"
            :value="Math.round(themeStore.customBgMaskOpacity * 100)"
            class="param-slider"
            @input="themeStore.setCustomBgMaskOpacity($event.target.value / 100)"
          >
          <span class="param-badge">{{ Math.round(themeStore.customBgMaskOpacity * 100) }}%</span>
        </div>
      </div>

      <!-- 底部重置与辅助按钮 -->
      <div class="bg-footer-actions">
        <button type="button" class="btn-reset-params" @click="resetParameters">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
            <polyline points="1 4 1 10 7 10"/>
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
          </svg>
          <span>恢复默认背景参数</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.custom-bg-settings {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.custom-bg-controls {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
  padding: var(--spacing-md);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.hidden-file-input {
  display: none;
}

.bg-upload-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.btn-primary-sm {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: var(--text-sm);
  font-weight: 500;
  color: #fff;
  background: var(--primary-color);
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.btn-primary-sm:hover {
  opacity: 0.9;
  transform: translateY(-1px);
}

.btn-danger-sm {
  padding: 6px 12px;
  font-size: var(--text-sm);
  color: #ff5577;
  background: rgba(255, 85, 119, 0.12);
  border: 1px solid rgba(255, 85, 119, 0.25);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-danger-sm:hover {
  background: rgba(255, 85, 119, 0.22);
}

.bg-url-row {
  display: flex;
  gap: var(--spacing-sm);
  margin-top: 4px;
}

.bg-url-input {
  flex: 1;
  padding: 7px 12px;
  font-size: var(--text-sm);
  color: var(--text-primary);
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  outline: none;
  transition: border-color var(--transition-fast);
}

.bg-url-input:focus {
  border-color: var(--primary-color);
}

.btn-apply-url {
  padding: 7px 14px;
  font-size: var(--text-sm);
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  white-space: nowrap;
}

.btn-apply-url:hover {
  background: rgba(255, 255, 255, 0.15);
  border-color: var(--primary-color);
}

.preset-wallpapers-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}

.preset-title {
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--spacing-sm);
}

.preset-card {
  position: relative;
  height: 52px;
  border-radius: var(--radius-sm);
  border: 2px solid transparent;
  background-size: cover;
  background-position: center;
  cursor: pointer;
  overflow: hidden;
  transition: all var(--transition-fast);
}

.preset-card:hover {
  transform: translateY(-2px);
  border-color: var(--primary-light);
}

.preset-card.active {
  border-color: var(--primary-color);
  box-shadow: 0 0 10px var(--accent-glow);
}

.preset-name {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 2px 6px;
  font-size: 11px;
  color: #fff;
  background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.8) 100%);
  text-align: center;
}

.upload-error-tip {
  font-size: var(--text-xs);
  color: #ff5577;
  padding: 4px 8px;
  background: rgba(255, 85, 119, 0.1);
  border-radius: var(--radius-xs);
}

.bg-preview-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm);
  background: rgba(0, 0, 0, 0.25);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  margin-top: 4px;
}

.bg-preview-thumb {
  width: 72px;
  height: 48px;
  border-radius: var(--radius-xs);
  background-size: cover;
  background-position: center;
  border: 1px solid rgba(255, 255, 255, 0.15);
  flex-shrink: 0;
}

.bg-preview-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.bg-status-tag {
  font-size: var(--text-xs);
  font-weight: 600;
  color: #4CAF50;
}

.bg-hint-text {
  font-size: 11px;
  color: var(--text-muted);
}

.slider-value {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  width: 220px;
}

.param-slider {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.15);
  accent-color: var(--primary-color);
  cursor: pointer;
}

.param-badge {
  min-width: 44px;
  font-size: var(--text-xs);
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--text-primary);
  text-align: right;
}

.quick-preset-chips {
  display: flex;
  gap: 6px;
  margin-top: -4px;
  margin-bottom: 4px;
}

.chip-btn {
  padding: 3px 8px;
  font-size: 11px;
  color: var(--text-muted);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.chip-btn:hover {
  color: var(--text-primary);
  border-color: var(--primary-light);
}

.chip-btn.active {
  color: #fff;
  background: var(--primary-dark);
  border-color: var(--primary-color);
}

.mode-buttons {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.mode-btn {
  padding: 5px 10px;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.mode-btn:hover {
  color: var(--text-primary);
  border-color: var(--primary-light);
}

.mode-btn.active {
  color: #fff;
  background: var(--primary-color);
  border-color: var(--primary-color);
}

.pos-sliders-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-md);
  padding: var(--spacing-sm);
  background: rgba(0, 0, 0, 0.15);
  border-radius: var(--radius-sm);
}

.pos-slider-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pos-label {
  font-size: 11px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.bg-footer-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: var(--spacing-xs);
}

.btn-reset-params {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  font-size: 11px;
  color: var(--text-muted);
  background: transparent;
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-reset-params:hover {
  color: var(--text-primary);
  border-color: var(--text-secondary);
}
</style>
