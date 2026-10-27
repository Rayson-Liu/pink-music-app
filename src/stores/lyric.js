import { defineStore } from 'pinia'
import { createPersistentStorage } from '@/utils/persistentStorage'
import { s, defineSchema } from '@/utils/schema'
import { parseLyric as parseLyricPure } from '@/utils/lrcParser'
import { useSettingsStore } from '@/stores/settings'

// ───────── 持久化结构改造 ─────────
// 老版本把歌词数据分 3 个 localStorage key：
//   pink-music-lyric-cache / pink-music-lyric-offsets / pink-music-lyric-sources
// 新版本统一存到主存储的 'lyrics' 一个文件里：
//   { cache: { key: { data, timestamp, source } }, offsets: { key: number }, sources: { key: string } }
//   ↓ 一次原子写，三个字段同步更新，彻底杜绝"半新半旧"
//
// localStorage 兜底：第一次启动时 storage.load() 会自动从老 3 key 拼起来迁到主存储。

// Schema v1：歌词数据 3 个 map
// cache/offsets/sources 都是 { [key: string]: any }，不强校验内部结构（保留扩展性）
const lyricsSchema = defineSchema({
  version: 1,
  fields: {
    cache: s.object({}, false),    // 嵌套 object 走 any 字段
    offsets: s.object({}, false),
    sources: s.object({}, false)
  }
})

const storage = createPersistentStorage('lyrics', { schema: lyricsSchema, debounceMs: 0 })

const FALLBACK_CACHE = 'pink-music-lyric-cache'
const FALLBACK_OFFSETS = 'pink-music-lyric-offsets'
const FALLBACK_SOURCES = 'pink-music-lyric-sources'

// 同步 peek：主存储 peek 不到时，从 3 个老 key 拼装一份
function peekLyrics() {
  const main = storage.peek(null)
  if (main && typeof main === 'object' && (main.cache || main.offsets || main.sources)) {
    return main
  }
  // 回退 3 个老 key
  let cache = {}, offsets = {}, sources = {}
  try { const r = localStorage.getItem(FALLBACK_CACHE); if (r) cache = JSON.parse(r) } catch (_) {}
  try { const r = localStorage.getItem(FALLBACK_OFFSETS); if (r) offsets = JSON.parse(r) } catch (_) {}
  try { const r = localStorage.getItem(FALLBACK_SOURCES); if (r) sources = JSON.parse(r) } catch (_) {}
  if (Object.keys(cache).length === 0 && Object.keys(offsets).length === 0 && Object.keys(sources).length === 0) {
    return null
  }
  return { cache, offsets, sources }
}

const initial = peekLyrics() || { cache: {}, offsets: {}, sources: {} }

// 并发加载去重（模块级，不进 Pinia state / 持久化）
let _inflightKey = ''
let _inflight = null

// 启动期串行化：load() 记录自身 promise，persist() 在它未完成前先等它，
// 避免 load 读回的旧快照覆盖掉内存里的新写入（如刚调整的歌词偏移）
let _loadPromise = null

export const useLyricStore = defineStore('lyric', {
  state: () => ({
    currentLyric: null,
    loadedHash: '',
    currentLineIndex: -1,
    isLyricLoading: false,
    lyricError: '',
    lyricSource: '',
    showLyricPanel: true,
    // 由 getCacheKey(bvid, cid, author, title) 索引
    lyricCache: initial.cache || {},
    // 用户调整的每首歌偏移量（"歌词进度"）
    lyricOffsets: initial.offsets || {},
    // 记录"用户手动指定"的来源（netease cache / manual），便于重置
    lyricSources: initial.sources || {},
    // 当前正在浏览的 track
    currentKey: ''
  }),
  getters: {
    hasLyric() {
      return this.currentLyric && this.currentLyric.lyrics && this.currentLyric.lyrics.length > 0
    },
    currentLyricText() {
      if (!this.hasLyric || this.currentLineIndex < 0) return ''
      return this.currentLyric.lyrics[this.currentLineIndex]?.text || ''
    },
    lyricSourceLabel() {
      const labels = { netease: '网易云', kugou: '酷狗', manual: '手动选择', local: '本地 LRC' }
      return labels[this.lyricSource] || ''
    },
    currentOffset() {
      if (!this.currentKey) return 0
      const raw = this.lyricOffsets[this.currentKey]
      const n = Number(raw)
      return Number.isFinite(n) ? n : 0
    },
    isManualSource() {
      return this.lyricSource === 'manual'
    }
  },
  actions: {
    /**
     * 启动时调用：从主存储拉取最新的 cache/offsets/sources（缺失时回退 localStorage 老 3 key 并自动迁移）。
     */
    async load() {
      const task = storage.load(null).then((data) => {
        if (data && typeof data === 'object') {
          if (data.cache && typeof data.cache === 'object') this.lyricCache = data.cache
          if (data.offsets && typeof data.offsets === 'object') this.lyricOffsets = data.offsets
          if (data.sources && typeof data.sources === 'object') this.lyricSources = data.sources
        }
      })
      _loadPromise = task
      try {
        await task
      } finally {
        _loadPromise = null
      }
    },

    /** 规范化歌词行：time 强制 number、过滤非法行、按 time 升序（保证二分查找正确） */
    normalizeLyric(lyric) {
      if (!lyric || typeof lyric !== 'object') return null
      const src = Array.isArray(lyric.lyrics) ? lyric.lyrics : []
      const lyrics = src
        .map((line) => {
          const time = Number(line?.time)
          if (!Number.isFinite(time)) return null
          return {
            ...line,
            time,
            text: line.text != null ? String(line.text) : '',
            romaji: line.romaji || '',
            translation: line.translation || ''
          }
        })
        .filter(Boolean)
        .sort((a, b) => a.time - b.time)
      return {
        ...lyric,
        lyrics,
        // 必须是恒等 true：缺失该标记 = 旧解析器产物（无 romaji/translation），
        // 判为过期让 getCachedLyric 丢弃并重新抓取
        _lyricV3: lyric._lyricV3 === true,
        // 解析器版本：解析规则扩展时递增，旧产物按 0 处理（同样判为过期）
        _lyricParserV: Number(lyric._lyricParserV) || 0
      }
    },

    setCurrentLyric(lyric) {
      const normalized = this.normalizeLyric(lyric)
      this.currentLyric = normalized
      this.currentLineIndex = -1
      this.lyricError = ''
      if (!normalized) this.lyricSource = ''
    },
    setLoadedHash(hash) { this.loadedHash = hash },
    setCurrentLineIndex(index) { this.currentLineIndex = index },
    setIsLyricLoading(loading) { this.isLyricLoading = loading },
    setLyricError(error) { this.lyricError = error },
    toggleLyricPanel() { this.showLyricPanel = !this.showLyricPanel },
    setShowLyricPanel(show) { this.showLyricPanel = show },

    // —— per-track offset ——
    setLyricOffset(offset) {
      if (!this.currentKey) {
        console.warn('[lyricStore] setLyricOffset: currentKey 为空')
        return
      }
      const n = Number(offset)
      this.lyricOffsets[this.currentKey] = Number.isFinite(n) ? n : 0
      this.persist()
    },
    adjustLyricOffset(delta) {
      if (!this.currentKey) {
        console.warn('[lyricStore] adjustLyricOffset: currentKey 为空')
        return
      }
      const base = Number(this.lyricOffsets[this.currentKey]) || 0
      const next = base + (Number(delta) || 0)
      this.lyricOffsets[this.currentKey] = next
      this.persist()
    },
    resetLyricOffset() { this.setLyricOffset(0) },

    // —— per-track source ——
    setLyricSource(source) {
      this.lyricSource = source
      if (this.currentKey) {
        this.lyricSources[this.currentKey] = source
        this.persist()
      }
    },

    // —— cache key ——
    // 第一个参数历史上是 bvid；本地曲改用稳定 id（bvid 为空会与其它曲撞 key）
    getCacheKey(bvid, cid, title = '', artist = '') {
      const safeTitle = String(title || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 40)
      const safeArtist = String(artist || '').replace(/[^\p{L}\p{N}]/gu, '').slice(0, 20)
      // cid 统一字符串化，避免 number/string 双形态导致缓存键不一致
      return `${bvid ?? ''}-${cid ?? 1}-${safeArtist}-${safeTitle}`
    },
    getCachedLyric(bvid, cid, title, artist) {
      const key = this.getCacheKey(bvid, cid, title, artist)
      const cached = this.lyricCache[key]
      if (!cached) return null
      // 用户手动指定的歌词永久有效：7 天 TTL 只约束自动抓取的缓存，
      // 否则用户费力搜到的词会被当作过期丢弃，并被自动源覆盖。
      const source = this.lyricSources[key] || cached.source || ''
      const isManual = source === 'manual'
      const fresh = cached.timestamp && Date.now() - cached.timestamp < 7 * 24 * 60 * 60 * 1000
      if (!isManual && !fresh) return null
      const data = this.normalizeLyric(cached.data)
      // 两个版本标记都过关才算命中：
      //   _lyricV3 缺失 = 旧解析器产物（romaji/translation 缺失）
      //   _lyricParserV < 4 = 旧解析规则产物（无时间戳变体 / 多时间戳 / [offset]）
      if (data && data.lyrics.length > 0 && data._lyricV3 === true && data._lyricParserV >= 4) {
        return data
      }
      return null
    },
    cacheLyric(bvid, cid, title, artist, lyric, source = '') {
      const key = this.getCacheKey(bvid, cid, title, artist)
      const normalized = this.normalizeLyric(lyric)
      this.lyricCache[key] = { data: normalized, timestamp: Date.now(), source }
      this.cleanupCache()
      if (source) this.lyricSources[key] = source
      this.persist()
    },
    cleanupCache() {
      const keys = Object.keys(this.lyricCache)
      if (keys.length > 1000) {
        const sorted = keys.sort((a, b) => (this.lyricCache[b].timestamp - this.lyricCache[a].timestamp))
        const toRemove = sorted.slice(1000)
        toRemove.forEach(key => delete this.lyricCache[key])
      }
    },

    /**
     * 统一持久化：把 cache / offsets / sources 三件套作为一份 JSON 原子写。
     */
    async persist() {
      // load 还没落地就先等它，保证写入发生在状态装载之后
      if (_loadPromise) {
        try { await _loadPromise } catch (_) {}
      }
      const payload = {
        cache: this.lyricCache,
        offsets: this.lyricOffsets,
        sources: this.lyricSources
      }
      await storage.save(payload)
    },

    /** 兼容老 API 同步签名 */
    persistSync() { this.persist().catch(e => console.warn('[lyricStore] persist failed:', e.message)) },
    saveCache() { this.persistSync() },
    saveOffsets() { this.persistSync() },
    saveSources() { this.persistSync() },

    async loadCache() {
      await this.load()
    },

    clearLyricCache() {
      this.lyricCache = {}
      this.lyricOffsets = {}
      this.lyricSources = {}
      this.persist()
    },

    async resetManualLyric() {
      const key = this.currentKey
      if (!key) return { success: false, error: 'no currentKey' }
      if (this.lyricCache[key]) this.lyricCache[key].source = 'auto'
      delete this.lyricSources[key]
      this.persist()
      this.lyricSource = ''
      this.loadedHash = ''
      return { success: true }
    },

    /**
     * 按 track 加载歌词。
     * - 同 key 已有歌词 → 直接复用（避免 playMusic + LyricDisplay 双触发把歌词抹掉）
     * - 同 key 加载中 → 合并为同一次请求
     * - 切歌（key 变化）才清空当前歌词
     */
    async loadLyricForTrack(track) {
      if (!track) return { success: false, error: 'no track' }
      const isLocal = track.source === 'local' || !!track.filePath
      // 本地曲用稳定 id 作身份；B 站曲沿用 bvid
      const bvid = isLocal ? (track.id || track.filePath || '') : track.bvid
      const cid = isLocal ? 0 : (track.cid ?? 1)
      const title = track.title || ''
      const artist = track.author || ''
      const key = this.getCacheKey(bvid, cid, title, artist)

      if (this.currentKey === key && this.currentLyric && this.loadedHash === key) {
        return { success: true, fromCache: true, deduped: true }
      }
      if (_inflightKey === key && _inflight) {
        return _inflight
      }

      this.currentKey = key
      if (this.loadedHash !== key) {
        this.setCurrentLyric(null)
        this.setLoadedHash('')
        this.lyricError = ''
      }

      const task = this.fetchLyric(bvid, cid, title, artist, {
        isLocal,
        lyricPath: track.lyricPath || ''
      })
      _inflightKey = key
      _inflight = task.finally(() => {
        if (_inflightKey === key) {
          _inflightKey = ''
          _inflight = null
        }
      })
      return _inflight
    },

    async fetchLyric(bvid, cid, title, artist, { isLocal = false, lyricPath = '' } = {}) {
      const cacheKey = this.getCacheKey(bvid, cid, title, artist)
      // 本地曲：同名 .lrc 是唯一事实源，每次都从磁盘重读（用户改了歌词立即生效，不缓存）
      const cached = isLocal ? null : this.getCachedLyric(bvid, cid, title, artist)
      if (cached) {
        // 过期响应防护：期间已切歌则丢弃
        if (this.currentKey !== cacheKey) {
          return { success: false, error: 'stale' }
        }
        this.setCurrentLyric(cached)
        this.setLoadedHash(cacheKey)
        const source = this.lyricSources[cacheKey] || cached.source || 'auto'
        this.lyricSource = source === 'manual' ? 'manual' : 'auto'
        return { success: true, fromCache: true }
      }

      this.setIsLyricLoading(true)
      try {
        // 本地曲优先读同目录 .lrc（纯本地，零网络）
        if (isLocal && lyricPath) {
          const localRes = await window.electronAPI?.local?.readLrc?.(lyricPath)
          if (localRes?.code === 0 && localRes.data) {
            if (this.currentKey !== cacheKey) return { success: false, error: 'stale' }
            const lyric = this.normalizeLyric(this.parseLyric(localRes.data))
            if (lyric && lyric.lyrics.length) {
              this.setCurrentLyric(lyric)
              this.setLyricSource('local')
              this.setLoadedHash(cacheKey)
              // 本地曲不写歌词缓存（.lrc 为唯一事实源）
              return { success: true, fromCache: false, fromLrc: true }
            }
          }
        }

        // 默认歌词源偏好：主进程据此决定多源尝试顺序（偏好源优先，失败自动回退另一个源）；
        // 必须在调用点读，用户改设置后下一次取词立即生效
        const preferredSource = useSettingsStore().lyricPreferredSource === 'netease' ? 'netease' : 'kugou'
        const result = await window.electronAPI.getLyric({ bvid, cid, title, artist, preferredSource })
        // 网络返回前用户可能已切歌：key 不一致则整段丢弃，避免 A 歌词盖到 B 上
        if (this.currentKey !== cacheKey) {
          return { success: false, error: 'stale' }
        }
        if (result?.code === 0 && result.data) {
          const lyric = this.normalizeLyric(this.parseLyric(result.data))
          if (!lyric || !lyric.lyrics.length) {
            this.setLyricError('沒有歌詞')
            return { success: false, error: 'empty lyric' }
          }
          // 主进程多源 fallback（netease → kugou），记录实际命中的来源
          const source = result.source || 'netease'
          this.setCurrentLyric(lyric)
          this.setLyricSource(source)
          this.setLoadedHash(cacheKey)
          this.cacheLyric(bvid, cid, title, artist, lyric, source)
          return { success: true, fromCache: false }
        } else {
          this.setLyricError('沒有歌詞')
          return { success: false, error: result?.message }
        }
      } catch (error) {
        if (this.currentKey === cacheKey) {
          this.setLyricError('沒有歌詞')
        }
        return { success: false, error: error.message }
      } finally {
        // 只有仍是当前 key 时才关 loading，避免后发请求把先发的 loading 提前关掉
        if (this.currentKey === cacheKey) {
          this.setIsLyricLoading(false)
        }
      }
    },

    async searchLyric(keyword, source = 'netease') {
      try {
        const result = await window.electronAPI.searchLyric(keyword, source)
        if (result?.code === 0 && result.data) {
          return { success: true, data: result.data }
        }
        return { success: false, error: result?.message }
      } catch (error) {
        return { success: false, error: error.message }
      }
    },

    parseLyric(rawLyric) {
      return this.normalizeLyric(parseLyricPure(rawLyric))
    },

    /**
     * 二分定位当前行。歌词已按 time 升序（normalizeLyric 保证）。
     * offset / time 都做 Number 归一，避免历史脏数据（字符串）导致定位错乱。
     */
    updateCurrentLine(currentTime) {
      if (!this.hasLyric) { this.currentLineIndex = -1; return }
      const lyrics = this.currentLyric.lyrics
      if (!lyrics.length) { this.currentLineIndex = -1; return }

      const t = Number(currentTime)
      if (!Number.isFinite(t)) { this.currentLineIndex = -1; return }

      const offset = Number(this.currentOffset) || 0
      const target = t * 1000 + offset + 500
      let lo = 0
      let hi = lyrics.length - 1
      let index = -1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const lineTime = Number(lyrics[mid]?.time)
        if (Number.isFinite(lineTime) && lineTime <= target) {
          index = mid
          lo = mid + 1
        } else {
          hi = mid - 1
        }
      }
      this.currentLineIndex = index
    }
  }
})

