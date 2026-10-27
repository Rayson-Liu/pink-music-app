import { defineStore } from 'pinia'
import { createPersistentStorage } from '@/utils/persistentStorage'
import { s, defineSchema } from '@/utils/schema'

// 登录态 UI 标记：原本散在 localStorage 的 'bilibili-login-cookie'
// 现在主存到 userData/app-data/login.json，localStorage 作 fallback
//
// TODO (2026-Q3): 接入 safeStorage 加密通道后，把 encrypt 改回 true。
// 当前：safeStorage 通道尚未实现，走明文 appData 落盘 + localStorage 双兜底。
//
// Schema v1：登录 cookie 至少含 SESSDATA（其他字段如 bili_jct、vip_status 不强校验）
const loginSchema = defineSchema({
  version: 1,
  fields: {
    SESSDATA: s.string(''),
    bili_jct: s.string(''),
    DedeUserID: s.string(''),
    // 任何扩展字段都保留在 unknown 桶
  }
})

const loginStorage = createPersistentStorage('login', {
  encrypt: false,           // TODO: 等 appDataEncrypted 通道实现后改回 true
  debounceMs: 0,            // 登录态不能 debounce：扫码成功/退出登录必须立刻落盘
  schema: loginSchema
})

export const useUserStore = defineStore('user', {
  state: () => ({
    userInfo: null,
    isLoggedIn: false,
    qrcodeUrl: '',
    qrcodeKey: '',
    qrcodeStatus: 'idle',
    qrcodeMessage: '',
    isPolling: false,
    isSyncingFavorites: false,
    _pollTimer: null,
    _lastFavError: ''
  }),
  getters: {
    /** 是否存在 B 站登录 cookie（主存储优先，缺失回退 localStorage） */
    hasLoginCookie(state) {
      if (state.isLoggedIn) return true
      // 主存储 peek（同步走 localStorage 缓存层）
      const peeked = loginStorage.peek(null)
      if (peeked && peeked.SESSDATA) return true
      // localStorage 老 key 兜底
      try {
        const raw = localStorage.getItem('bilibili-login-cookie')
        if (raw) {
          const parsed = JSON.parse(raw)
          return !!(parsed && parsed.SESSDATA)
        }
      } catch (e) { /* ignore */ }
      return false
    }
  },
  actions: {
    /**
     * 启动时调用：从主存储恢复登录 cookie 标记。
     * 注意：真正的 SESSDATA 仍在主进程 bilibili-cookies.json 里，
     * 这里只缓存 UI 用得到的简化版（用于 hasLoginCookie getter）。
     *
     * 不再写回老 localStorage key：createPersistentStorage 已经写 localStorage 新 key 兜底。
     * 老 key 'bilibili-login-cookie' 只在 hasLoginCookie getter 里读一次（历史兜底）。
     */
    async load() {
      await loginStorage.load(null)
    },
    setQrcodeStatus(status, message = '') {
      this.qrcodeStatus = status
      this.qrcodeMessage = message
    },
    async generateQrCode() {
      if (!window.electronAPI) return
      // 已登录时不重新生成二维码，避免覆盖已登录 UI
      if (this.hasLoginCookie) {
        return
      }
      this.setQrcodeStatus('loading', '正在生成二维码...')
      this.userInfo = null
      this.isLoggedIn = false
      this.qrcodeUrl = ''
      this.qrcodeKey = ''
      this.stopPolling()
      try {
        const result = await window.electronAPI.generateQrcode()
        if (result?.code === 0 && result.data) {
          this.qrcodeUrl = result.data.url
          this.qrcodeKey = result.data.qrcode_key
          this.setQrcodeStatus('waiting', '请使用 B 站手机客户端扫码登录')
          this.startPolling()
        } else {
          this.setQrcodeStatus('error', result?.message || '生成二维码失败')
        }
      } catch (error) {
        this.setQrcodeStatus('error', error.message || '生成二维码失败')
      }
    },
    startPolling() {
      this.stopPolling()
      this.isPolling = true
      this._pollTimer = setInterval(() => {
        this.pollOnce().catch(() => {})
      }, 2000)
      this.pollOnce().catch(() => {})
    },
    stopPolling() {
      if (this._pollTimer) {
        clearInterval(this._pollTimer)
        this._pollTimer = null
      }
      this.isPolling = false
    },
    async pollOnce() {
      if (!this.qrcodeKey || !window.electronAPI) return
      try {
        const result = await window.electronAPI.pollQrcode(this.qrcodeKey)
        if (result?.code !== 0) {
          this.setQrcodeStatus('error', result?.message || '轮询失败')
          this.stopPolling()
          return
        }
        const data = result.data?.data
        if (!data) return
        const code = data.code
        if (code === 0) {
          this.stopPolling()
          this.setQrcodeStatus('success', '登录成功')
          await this.fetchUserInfo()
        } else if (code === 86090) {
          this.setQrcodeStatus('scanned', '已扫码，请在手机上确认登录')
        } else if (code === 86038) {
          this.setQrcodeStatus('expired', '二维码已失效，请刷新')
          this.stopPolling()
        } else if (code === 86101) {
          this.setQrcodeStatus('waiting', '请使用 B 站手机客户端扫码登录')
        } else {
          this.setQrcodeStatus('error', data.message || '登录失败')
        }
      } catch (error) {
        this.setQrcodeStatus('error', error.message || '轮询失败')
        this.stopPolling()
      }
    },
    async fetchUserInfo() {
      if (!window.electronAPI) return
      try {
        // 同步把主进程持久化 cookie 写进主存储（loginStorage.save 内部已含 localStorage 双写）
        try {
          const cookieRes = await window.electronAPI.getBilibiliCookies()
          if (cookieRes?.code === 0 && cookieRes.data) {
            await loginStorage.save(cookieRes.data)
          }
        } catch (e) { /* ignore */ }
        const result = await window.electronAPI.getUserInfo()
        // B 站 nav 接口返回 { code, message, ttl, data: { isLogin, mid, uname, ... } }
        // IPC handler 直接 return 该对象，渲染进程收到 result = { code, message, data: {...} }
        if (result?.code === 0 && result.data && result.data.mid) {
          this.userInfo = result.data
          this.isLoggedIn = !!this.userInfo.mid
          return this.userInfo
        } else {
          // 未登录或 cookie 失效：清空主存储（loginStorage.remove 内部已含 localStorage 清理）
          try { await loginStorage.remove() } catch (_) {}
          this.userInfo = null
          this.isLoggedIn = false
          return null
        }
      } catch (error) {
        console.error('获取用户信息失败:', error)
        return null
      }
    },
    // 启动时检查主进程是否持有 B 站登录 cookie
    async restoreFromCookies() {
      if (!window.electronAPI) return false
      try {
        const res = await window.electronAPI.getBilibiliCookies()
        if (res?.code === 0 && res.data && res.data.SESSDATA) {
          // 主存储 + localStorage 双写（loginStorage.save 内部已含）
          await loginStorage.save(res.data)
          // 同时尝试拉取用户信息
          const info = await this.fetchUserInfo()
          return !!info?.mid
        }
      } catch (error) {
        console.error('restoreFromCookies 失败:', error)
      }
      return false
    },
    // 启动时检查 session 中是否仍有登录 cookie，若有则恢复登录态
    async restoreSession() {
      if (!window.electronAPI) return false
      try {
        const info = await this.fetchUserInfo()
        return !!info?.mid
      } catch (error) {
        return false
      }
    },
    /**
     * 关窗 flush 时调用：确保当前登录 cookie 已持久化到主存储 + localStorage。
     */
    async persist() {
      try {
        const cookieRes = await window.electronAPI?.getBilibiliCookies?.()
        if (cookieRes?.code === 0 && cookieRes.data) {
          await loginStorage.save(cookieRes.data)
        }
      } catch (e) {
        console.warn('[userStore] persist 失败:', e.message)
      }
    },

    async syncFavorites(playlistStore) {
      if (!this.userInfo?.mid || !window.electronAPI) return 0
      this.isSyncingFavorites = true
      try {
        const [createdRes, collectedRes] = await Promise.all([
          window.electronAPI.getFavFolderCreatedList(this.userInfo.mid, 1, 50),
          window.electronAPI.getFavFolderCollectedList(this.userInfo.mid, 1, 50)
        ])
        const list = []
        if (createdRes?.code === 0 && createdRes.data?.list) {
          createdRes.data.list.forEach(item => {
            if (item.state === 0) {
              list.push({
                id: item.id,
                title: item.title,
                cover: item.cover,
                media_count: item.media_count,
                source: 'created'
              })
            }
          })
        }
        if (collectedRes?.code === 0 && collectedRes.data?.list) {
          collectedRes.data.list.forEach(item => {
            if (item.state === 0) {
              list.push({
                id: item.id,
                title: item.title,
                cover: item.cover,
                media_count: item.media_count,
                source: 'collected'
              })
            }
          })
        }
        if (playlistStore && typeof playlistStore.mergeBiliFavorites === 'function') {
          return playlistStore.mergeBiliFavorites(list)
        }
        return list.length
      } catch (error) {
        console.error('同步收藏夹失败:', error)
        return 0
      } finally {
        this.isSyncingFavorites = false
      }
    },
    async logout() {
      this.stopPolling()
      if (window.electronAPI) {
        try {
          await window.electronAPI.logoutBilibili()
        } catch (error) {
          console.error('退出登录失败:', error)
        }
      }
      // loginStorage.remove 内部已含 localStorage 清理
      try { await loginStorage.remove() } catch (_) {}
      this.userInfo = null
      this.isLoggedIn = false
      this.qrcodeUrl = ''
      this.qrcodeKey = ''
      this.qrcodeStatus = 'idle'
      this.qrcodeMessage = ''
    },
    /**
     * 把 B 站收藏夹的 media 项转换成本地 music 字段。
     * 已存在（bvid 或 favId+favType 命中）的会跳过并补充缺失元数据；返回本次新增数。
     * - 过滤掉已失效稿件、追更（type=21 视频合集）、电影（type=24）等非音乐/视频稿件项
     *   B 站媒体类型：2 视频稿件 / 12 音频 / 21 视频合集（追更） / 24 电影
     */
    _appendFavMedias(playlist, medias) {
      if (!playlist) return 0
      if (!playlist.music) playlist.music = []
      let added = 0
      let skipped = 0
      medias.forEach(item => {
        if (!item) return

        // 过滤真正已失效/已下架的视频：
        // 1. 标题为"已失效视频"或"已失效稿件"
        // 2. state 为 -404 (已删除)
        // 3. attr 位掩码中 bit 0 为 1 表示已失效 ((item.attr & 1) === 1 或 item.attr === 9)
        // 注意：不可使用 item.attr !== 0，因为正常视频的 attr 可为 2(合集/合作)、4(充电)、16 等正常标志位！
        if (
          item.title === '已失效视频' ||
          item.title === '已失效稿件' ||
          item.state === -404 ||
          (typeof item.attr === 'number' && (item.attr & 1) === 1) ||
          item.attr === 9
        ) {
          skipped++
          return
        }

        // 跳过追更（视频合集）和电影类型
        // 2=视频稿件 12=音频 21=视频合集（追更） 24=电影
        if (item.type === 21 || item.type === 24) {
          skipped++
          return
        }

        const bvid = item.bvid || item.bv_id
        const hasBvid = !!bvid
        if (!hasBvid && !item.id) return

        const finalCid = item.cid || item.ugc?.first_cid || 0
        const finalCover = item.cover && (item.cover.startsWith('//') ? `https:${item.cover}` : item.cover)
        const finalAuthor = item.upper?.name || item.upper?.mid || item.author || '未知歌手'

        // 查重：若已存在则更新缺失的 cid/cover/duration/author
        const existing = playlist.music.find(m => m && (
          (hasBvid && m.bvid === bvid) ||
          (!hasBvid && m.favId === item.id && m.favType === item.type)
        ))

        if (existing) {
          if (!existing.cid && finalCid) existing.cid = finalCid
          if (!existing.cover && finalCover) existing.cover = finalCover
          if (!existing.duration && item.duration) existing.duration = item.duration
          if (!existing.author && finalAuthor) existing.author = finalAuthor
          return
        }

        playlist.music.push({
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
        })
        added++
      })
      if (skipped > 0) {
        console.log(`[pink-music] 跳过 ${skipped} 个失效或非音乐项`)
      }
      return added
    },

    /**
     * 拉取收藏夹全部内容：通过 /x/v3/fav/resource/list 分页拉取（每页 20 条）。
     * - onProgress({ stage, current, total, loaded, totalCount }) 用于 UI 实时显示进度
     * - 返回 { added, loaded, error }
     */
    async loadAllFavoriteResources(playlist, playlistStore, { onProgress } = {}) {
      if (!playlist || !window.electronAPI) return { added: 0, loaded: 0, error: '缺少环境接口' };
      const id = playlist.id;
      if (!id || !id.startsWith('bili-fav-')) return { added: 0, loaded: 0, error: '非 B 站收藏夹' };
      const mediaId = Number(id.replace('bili-fav-', ''));
      if (!mediaId) return { added: 0, loaded: 0, error: '无效收藏夹 ID' };
      this._lastFavError = '';

      let page = 1;
      let hasMore = true;
      let totalLoaded = 0;
      let totalAdded = 0;
      let totalCount = playlist.media_count || 0;
      const MAX_PAGES = 500; // 最多 500 页 (10000 首)，防止死循环

      while (hasMore && page <= MAX_PAGES) {
        const res = await window.electronAPI.getFavResourceList(mediaId, page, 20);
        if (res?.code !== 0) {
          this._lastFavError = res?.message || `code=${res?.code}`;
          console.error(`getFavResourceList 第 ${page} 页失败:`, this._lastFavError, "mediaId=", mediaId);
          break;
        }

        const data = res.data;
        if (data?.info?.media_count !== undefined) {
          totalCount = Number(data.info.media_count) || totalCount;
          playlist.media_count = totalCount;
        }

        const medias = Array.isArray(data?.medias) ? data.medias : [];
        if (medias.length === 0) {
          break;
        }

        totalLoaded += medias.length;
        totalAdded += this._appendFavMedias(playlist, medias);

        const totalPages = Math.max(1, Math.ceil(totalCount / 20));
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              stage: 'list',
              current: page,
              total: totalPages,
              loaded: totalLoaded,
              totalCount
            });
          } catch (_) {}
        }

        // 翻页判定：
        // 1. 若 B 站返回了 has_more 字段（布尔值或数字），以其为准
        // 2. 若缺少 has_more，只要已拉取数量 totalLoaded 少于总数 totalCount 且当前页非空，继续翻页
        // 3. 绝不能简单要求 medias.length >= 20，因为当前页若有已删除稿件被 B 站过滤，medias.length 可能为 18/19 但依然 has_more=true
        if (data?.has_more !== undefined) {
          hasMore = Boolean(data.has_more);
        } else if (totalCount > 0) {
          hasMore = totalLoaded < totalCount;
        } else {
          hasMore = medias.length >= 20;
        }

        page++;

        if (hasMore) {
          await new Promise(r => setTimeout(r, 80));
        }
      }

      if (playlistStore && typeof playlistStore.savePlaylists === 'function') {
        try { await playlistStore.savePlaylists(); } catch (e) {
          console.warn('[loadAllFavoriteResources] save failed:', e.message);
        }
      }
      return { added: totalAdded, loaded: totalLoaded, error: this._lastFavError };
    }


  }
})
