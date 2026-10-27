<script setup>
import CustomBackgroundSettings from './CustomBackgroundSettings.vue'
import { onMounted } from 'vue'
import { useSettingsStore, useThemeStore } from '@/stores'

const settingsStore = useSettingsStore()
const themeStore = useThemeStore()

onMounted(() => {
  settingsStore.loadDownloadDirectory()
  settingsStore.loadCacheSize()
})

function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

function closeSettings() {
  settingsStore.setShowSettings(false)
}

function switchTab(tab) {
  settingsStore.setActiveSettingsTab(tab)
}
</script>

<template>
  <div v-if="settingsStore.showSettings" class="settings-panel">
    <div class="settings-panel-content">
      <div class="settings-header">
        <h2>设置</h2>
        <button class="close-btn" @click="closeSettings">
          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
          </svg>
        </button>
      </div>

      <div class="settings-tabs">
        <button 
          class="settings-tab" 
          :class="{ active: settingsStore.activeSettingsTab === 'general' }"
          @click="switchTab('general')"
        >
          通用
        </button>
        <button 
          class="settings-tab" 
          :class="{ active: settingsStore.activeSettingsTab === 'appearance' }"
          @click="switchTab('appearance')"
        >
          外观
        </button>
        <button 
          class="settings-tab" 
          :class="{ active: settingsStore.activeSettingsTab === 'about' }"
          @click="switchTab('about')"
        >
          关于
        </button>
      </div>

      <div class="settings-content">
        <div v-if="settingsStore.activeSettingsTab === 'general'" class="settings-section">
          <h3>播放设置</h3>
          <div class="setting-item">
            <label class="setting-label">默认播放音质</label>
            <div class="setting-value">
              <select v-model="settingsStore.audioQuality" @change="settingsStore.setAudioQuality(settingsStore.audioQuality)" class="quality-select">
                <option value="auto">自动（最高可用）</option>
                <option value="lossless">无损</option>
                <option value="high">高音质</option>
                <option value="medium">中音质</option>
                <option value="low">低音质</option>
              </select>
            </div>
          </div>

          <h3>下载设置</h3>
          <div class="setting-item">
            <label class="setting-label">下载目录</label>
            <div class="setting-value">
              <span class="download-path">{{ settingsStore.downloadDirectory || '未设置' }}</span>
              <button class="browse-btn" @click="settingsStore.selectDownloadDirectory">浏览</button>
            </div>
          </div>

          <h3>缓存管理</h3>
          <div class="setting-item">
            <label class="setting-label">缓存大小</label>
            <span class="cache-size">{{ formatFileSize(settingsStore.cacheSize) }}</span>
          </div>
          <button class="clear-cache-btn" @click="settingsStore.clearCache()">
            清除缓存
          </button>
        </div>

        <div v-if="settingsStore.activeSettingsTab === 'appearance'" class="settings-section">
          <h3>主题模式</h3>
          <div class="theme-options">
            <button 
              v-for="theme in ['dark', 'light']" 
              :key="theme" 
              class="theme-btn" 
              :class="{ active: themeStore.currentTheme === theme }" 
              @click="themeStore.setTheme(theme)"
            >
              {{ theme === 'dark' ? '深色模式' : '浅色模式' }}
            </button>
          </div>

          <h3>主题颜色</h3>
          <div class="color-options">
            <button 
              v-for="color in ['pink', 'purple', 'blue', 'green', 'orange']" 
              :key="color" 
              class="color-btn" 
              :class="{ active: themeStore.currentColor === color }" 
              :style="{ backgroundColor: color === 'pink' ? '#FF69B4' : color === 'purple' ? '#9C27B0' : color === 'blue' ? '#2196F3' : color === 'green' ? '#4CAF50' : '#FF9800' }" 
              @click="themeStore.setColor(color)"
            />
          </div>

          <h3 style="margin-top: var(--spacing-lg);">自定义背景</h3>
          <CustomBackgroundSettings />
        </div>

        <div v-if="settingsStore.activeSettingsTab === 'about'" class="settings-section">
          <h3>关于 Pink Music</h3>
          <div class="about-info">
            <p class="version">版本: 2.0.2</p>
            <p class="description">基于 Electron 和 Vue 3 构建的 B 站音乐播放器</p>
            <button class="about-btn" @click="settingsStore.openGitHub()">
              <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
              </svg>
              <span>GitHub</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div v-if="settingsStore.showSettings" class="modal-overlay" @click="closeSettings"></div>
</template>

<style scoped>
.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
}

.setting-label {
  font-size: 14px;
  color: var(--text-secondary);
}

.setting-value {
  display: flex;
  align-items: center;
  gap: 12px;
}

.download-path {
  font-size: 13px;
  color: var(--text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.browse-btn {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--primary-color);
  background: transparent;
  border: 1px solid var(--primary-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.browse-btn:hover {
  background: var(--primary-color);
  color: white;
}

.cache-size {
  font-size: 14px;
  color: var(--text-primary);
}

.quality-select {
  padding: 6px 12px;
  font-size: 13px;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  outline: none;
}

.quality-select:focus {
  border-color: var(--primary-color);
}

.clear-cache-btn {
  width: 100%;
  padding: 12px;
  margin-top: 16px;
  font-size: 14px;
  color: #e81123;
  background: transparent;
  border: 1px solid #e81123;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.clear-cache-btn:hover:not(:disabled) {
  background: #e81123;
  color: white;
}

.clear-cache-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.theme-options {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.theme-btn {
  flex: 1;
  padding: 12px;
  font-size: 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.theme-btn.active {
  background: var(--primary-color);
  color: white;
  border-color: var(--primary-color);
}

.color-options {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.color-btn {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.color-btn.active {
  border-color: var(--text-primary);
  transform: scale(1.1);
}

.about-info {
  padding-top: 12px;
}

.version {
  font-size: 14px;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
}

.about-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  font-size: 14px;
  color: var(--primary-color);
  background: transparent;
  border: 1px solid var(--primary-color);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.about-btn:hover {
  background: var(--primary-color);
  color: white;
}
</style>