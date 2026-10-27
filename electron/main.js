const { app, BrowserWindow, ipcMain, session, shell, dialog, Menu, screen, globalShortcut, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const axios = require('axios');
const crypto = require('crypto');
const { searchKugou, getKugouLyric } = require('./lyricSources');
const { resolveLyricSourceOrder } = require('./lyricSourceOrder');
const { resolveLyricsWindowPosition } = require('./lyricsWindowBounds');
const { discordRpcManager } = require('./discordRpc');

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = app.isPackaged ? 'production' : 'development';
}

// 显式固定 userData 目录，使开发版（npm run electron:dev）和
// 打包版（electron-builder）走同一个目录，B 站登录 cookie 互通、长期保持登录态。
// 默认情况下，Electron 在开发模式用 package.json#name、打包后用 productName，
// 二者 userData 路径不同，会导致 cookie 互相隔离。
function getFixedUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'pink-music');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'pink-music');
  }
  return path.join(home, '.config', 'pink-music');
}
if (typeof app.setPath === 'function') {
  try { app.setPath('userData', getFixedUserDataDir()); } catch (e) { /* ignore */ }
}

const cacheManager = require('./cacheManager');
const updateChecker = require('./updateChecker');
const localLibrary = require('./localLibrary');
const coverSources = require('./coverSources');

// ───────── 本地音乐自定义协议 ─────────
// 本地音频/封面要喂给 <audio crossOrigin="anonymous"> + WebAudio Analyser，
// 用 file:// 会因跨域拿不到频谱数据。自定义协议声明为 secure + corsEnabled
// 后，Chromium 才允许把它当同源资源做频域分析。
// 必须在 app ready 之前调用 registerSchemesAsPrivileged。
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pinkmusic-local',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
]);

// 生产环境关闭热路径大对象日志（JSON.stringify 本身就有 CPU/内存成本）
const isDevLog = !app.isPackaged || process.env.NODE_ENV === 'development';
function dlog(...args) {
  if (isDevLog) console.log(...args);
}

// ============== 主存：appData 原子写 + .bak + 损坏自愈 ==============
// 文件落地路径：<userData>/app-data/<key>.json
// 升级/重装软件时，userData 目录由 Electron 保留，数据天然不丢
const APP_DATA_DIR = path.join(app.getPath('userData'), 'app-data')
try { fs.mkdirSync(APP_DATA_DIR, { recursive: true }) } catch (_) {}

/**
 * 主存文件路径生成。
 * 防御性：key 必须是安全的 [a-z0-9_-]，防止 IPC 入参被路径注入。
 */
function appDataFilePath(key) {
  const safe = String(key).replace(/[^a-z0-9_-]/gi, '_')
  return path.join(APP_DATA_DIR, `${safe}.json`)
}

/**
 * 原子写：先写 .tmp，再 rename 覆盖；保留上一次完整快照为 .bak。
 * - 写失败 → .tmp 残留不污染 .json
 * - 写过程中崩溃 → 下次启动发现 .json 损坏，自动从 .bak 恢复
 */
function atomicWriteJson(filePath, data) {
  const tmp = `${filePath}.tmp`
  const bak = `${filePath}.bak`
  const json = JSON.stringify(data, null, 2)
  // 1) 写 .tmp
  fs.writeFileSync(tmp, json, 'utf-8')
  // 2) 把旧 .json 备份成 .bak（如果存在）
  if (fs.existsSync(filePath)) {
    try { fs.copyFileSync(filePath, bak) } catch (_) {}
  }
  // 3) rename .tmp → .json
  fs.renameSync(tmp, filePath)
  return true
}

/**
 * 读 JSON：先看主文件，损坏尝试 .bak，两个都坏返回 null。
 * 主文件损坏时用 .bak 恢复并立即原子写回 .json，避免下次还触发恢复。
 */
function readJsonWithFallback(filePath) {
  if (!fs.existsSync(filePath)) return null
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw)
  } catch (e) {
    // 损坏：尝试从 .bak 恢复
    const bak = `${filePath}.bak`
    if (fs.existsSync(bak)) {
      try {
        const rawBak = fs.readFileSync(bak, 'utf-8')
        const data = JSON.parse(rawBak)
        console.warn(`[appData] ${path.basename(filePath)} 损坏，已从 .bak 恢复`)
        // 立即把 .bak 重新原子写回 .json
        atomicWriteJson(filePath, data)
        return data
      } catch (e2) {
        console.error(`[appData] ${path.basename(filePath)} .bak 也损坏:`, e2.message)
      }
    }
    return null
  }
}

// ============== 下载目录：纯 IPC 内存态（不落盘） ==============
// 设计：downloadDir 走纯 IPC，主进程持有内存态 currentDownloadDir，
// 渲染层通过 get/set-download-directory 同步，变更时主进程主动 broadcast 推送。
// 不落盘的理由：避免与渲染层 createPersistentStorage('settings') 的 settings.json 路径冲突。
let currentDownloadDir = path.join(app.getPath('userData'), 'downloads')
try { fs.mkdirSync(currentDownloadDir, { recursive: true }) } catch (_) {}

function broadcastDownloadDir() {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('download-dir-changed', currentDownloadDir) } catch (_) {}
  }
}

// —— EPIPE 防御 ——
// 当 Electron 进程被以 `&` 后台启动、父 shell 退出后，stdout/stderr 管道会被关闭。
// 此后任何 `console.log/error` 写入都会触发 EPIPE，Node 会把这种 stream 错误升级为
// Uncaught Exception 并在后续 IPC 调用时反复抛出。吞掉 EPIPE，让控制台日志失败不再致命。
const swallowEpipe = (err) => {
  if (err && err.code === 'EPIPE') return;
  // 其它错误仍然抛回（不静默吞掉）
  throw err;
};
process.stdout.on('error', swallowEpipe);
process.stderr.on('error', swallowEpipe);

// 顺手也加个全局兜底，防止任意 unhandled error 直接干掉渲染链路
process.on('uncaughtException', (err) => {
  if (err && err.code === 'EPIPE') return;
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  if (reason && reason.code === 'EPIPE') return;
  console.error('[unhandledRejection]', reason);
});

const BILIBILI_BASE = 'https://api.bilibili.com';
const BILIBILI_WEB = 'https://passport.bilibili.com';

const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// B 站风控 wbi 签名：/x/v3/fav/* 等接口必须带 wts + w_rid。
// 参考 biu-master 的 wbi-sign.ts 改写为 Node.js 实现（用内置 crypto 算 md5）。
const mixinKeyEncTab = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52
];
function getMixinKey(orig) {
  return mixinKeyEncTab.map(n => orig[n]).join('').slice(0, 32);
}
function wbiSignParams(params, imgKey, subKey) {
  if (!imgKey || !subKey) return { ...params };
  const mixinKey = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const enriched = { ...params, wts };
  const keys = Object.keys(enriched).filter(k => enriched[k] !== undefined && enriched[k] !== null && enriched[k] !== '').sort();
  const chrFilter = /[!'()*]/g;
  const query = keys.map(k => {
    const v = String(enriched[k]).replace(chrFilter, '');
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join('&');
  const crypto = require('crypto');
  const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return { ...enriched, w_rid: wRid };
}
function extractWbiKeys(wbiImg) {
  if (!wbiImg) return { imgKey: '', subKey: '' };
  const { img_url, sub_url } = wbiImg;
  const extract = (u) => u ? u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.')) : '';
  return { imgKey: extract(img_url), subKey: extract(sub_url) };
}

let wbiKeysCache = { imgKey: '', subKey: '', updatedAt: 0 };
function updateWbiKeys(wbiImg) {
  if (!wbiImg) return;
  const keys = extractWbiKeys(wbiImg);
  if (keys.imgKey && keys.subKey) {
    wbiKeysCache = { ...keys, updatedAt: Date.now() };
  }
}

class BilibiliAPI {
  constructor() {
    this.cookies = {};
    this.axios = axios.create({
      timeout: 30000,
      withCredentials: false,
      headers: {
        'User-Agent': UserAgent,
        'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    // 请求拦截器：每次请求前自动注入最新 Cookie + 给 fav 路径加 wbi 签名
    this.axios.interceptors.request.use((config) => {
      try {
        const cookies = this.cookies || {};
        const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
        if (cookieHeader) {
          config.headers = config.headers || {};
          config.headers.Cookie = cookieHeader;
        }
        // 路径匹配 fav 系列：自动加 wbi 签名
        if (config.url && config.url.includes('/x/v3/fav/')) {
          config.params = config.params || {};
          config.params = wbiSignParams(config.params, wbiKeysCache.imgKey, wbiKeysCache.subKey);
        }
      } catch (e) { /* ignore */ }
      return config;
    });
  }

  async refreshCookiesFromSession() {
    // 三源合并：JSON 持久化（冷启动） < session 内存（热路径）< 文件最新落盘值
    let fileCookies = {};
    try {
      if (fs.existsSync(COOKIE_STORE_PATH)) {
        const raw = fs.readFileSync(COOKIE_STORE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') fileCookies = parsed;
      }
    } catch (e) { /* ignore */ }

    let sessionCookies = {};
    const target = bilibiliSession || (session && session.defaultSession);
    if (target && target.cookies) {
      try {
        const list = await target.cookies.get({ domain: '.bilibili.com' });
        list.forEach(c => { sessionCookies[c.name] = c.value; });
      } catch (error) {
        console.error('[debug] 从 session 读 cookies 失败:', error);
      }
    }

    // session 覆盖 file（session 是热路径值更新），但 file 中已存在且 session 没有的仍保留
    this.cookies = { ...fileCookies, ...sessionCookies };
    // 落盘（保持 JSON 是当前真实状态的镜像）
    try { fs.writeFileSync(COOKIE_STORE_PATH, JSON.stringify(this.cookies, null, 2), 'utf-8'); } catch (e) {}
    console.log('[debug] refreshCookiesFromSession merged =', Object.keys(this.cookies).join(','));
  }

  async request(url, options = {}) {
    // Cookie 注入和 wbi 签名由 axios interceptor 自动处理
    // （interceptor 从 this.cookies 取最新值；fav/* 路径自动加 wts+w_rid）
    try {
      const response = await this.axios({
        url,
        ...options
      });
      return response.data;
    } catch (error) {
      console.error('API请求失败:', url, error.message);
      throw error;
    }
  }

  async searchMusic(keyword, page = 1, pageSize = 20) {
    try {
      console.log('搜索音乐:', keyword, page, pageSize);
      const data = await this.request(`${BILIBILI_BASE}/x/web-interface/search/all/v2`, {
        params: {
          keyword,
          page,
          page_size: pageSize
        }
      });
      console.log('搜索结果:', JSON.stringify(data, null, 2));
      return data;
    } catch (error) {
      console.error('搜索失败:', error);
      return { code: -1, message: error.message };
    }
  }

  /**
   * 音乐区推荐（参考 biu-master 的 getRegionFeedRcmd）
   * 仅返回 tid=1003（音乐区）的内容，避免被全站搜索误导到擦边视频
   */
  async getMusicRegionFeed(displayId = 1, requestCnt = 15) {
    try {
      console.log('[debug] getMusicRegionFeed: page=', displayId, 'cnt=', requestCnt);
      const data = await this.request(`${BILIBILI_BASE}/x/web-interface/region/feed/rcmd`, {
        params: {
          display_id: displayId,
          request_cnt: requestCnt,
          from_region: 1003, // 音乐区
          device: 'web',
          plat: 30,
          web_location: '333.40138'
        }
      });
      console.log('[debug] getMusicRegionFeed ok, archives:', data?.data?.archives?.length);
      return data;
    } catch (error) {
      console.error('音乐区推荐获取失败:', error);
      return { code: -1, message: error.message, data: { archives: [] } };
    }
  }

  async getMusicInfo(bvid) {
    try {
      dlog('获取音乐信息:', bvid);
      const data = await this.request(`${BILIBILI_BASE}/x/web-interface/view`, {
        params: { bvid }
      });
      dlog('音乐信息 code:', data?.code, 'bvid:', bvid);
      return data;
    } catch (error) {
      console.error('获取音乐信息失败:', error);
      return { code: -1, message: error.message };
    }
  }

  /**
   * 热门音乐排行（参考 biu-master 的 getMusicComprehensiveWebRank）
   * GET /x/centralization/interface/music/comprehensive/web/rank
   */
  async getMusicComprehensiveWebRank(pn = 1, ps = 20) {
    try {
      console.log('[debug] getMusicComprehensiveWebRank: pn=', pn, 'ps=', ps);
      const data = await this.request(`${BILIBILI_BASE}/x/centralization/interface/music/comprehensive/web/rank`, {
        params: {
          pn,
          ps,
          web_location: '333.1351'
        }
      });
      console.log('[debug] getMusicComprehensiveWebRank ok, list:', data?.data?.list?.length);
      return data;
    } catch (error) {
      console.error('热门音乐排行获取失败:', error);
      return { code: -1, message: error.message, data: { list: [] } };
    }
  }

  async getMusicPlayUrl(bvid, cid) {
    try {
      dlog('获取播放地址:', bvid, cid);
      const data = await this.request(`${BILIBILI_BASE}/x/player/playurl`, {
        params: {
          bvid,
          cid,
          qn: 0,
          fnval: 4048, // DASH格式（必须）
          fnver: 0,
          fourk: 1
        }
      });
      dlog('播放地址 code:', data?.code, 'bvid:', bvid, 'cid:', cid);
      return data;
    } catch (error) {
      console.error('获取播放地址失败:', error);
      return { code: -1, message: error.message };
    }
  }

  async getVideoEpisodes(bvid) {
    try {
      console.log('获取视频分P列表:', bvid);
      const data = await this.request(`${BILIBILI_BASE}/x/player/pagelist`, {
        params: { bvid }
      });
      console.log('分P列表结果:', JSON.stringify(data, null, 2));
      return data;
    } catch (error) {
      console.error('获取分P列表失败:', error);
      return { code: -1, message: error.message };
    }
  }

  async getAudioProxy(audioUrl) {
    try {
      console.log('代理音频请求:', audioUrl);
      const response = await this.axios({
        method: 'get',
        url: audioUrl,
        responseType: 'arraybuffer',
        headers: {
          'Referer': 'https://www.bilibili.com',
          'User-Agent': UserAgent
        },
        timeout: 60000
      });
      return Buffer.from(response.data);
    } catch (error) {
      console.error('音频代理失败:', error.message);
      throw error;
    }
  }

  async getRecommendations() {
    try {
      const headers = {
        'Referer': 'https://www.bilibili.com',
        'User-Agent': UserAgent
      };

      const response = await this.axios.get(`${BILIBILI_BASE}/x/web-interface/index/top/feed/rcmd`, {
        params: {
          platform: 'web',
          web_location: 1550101,
          aid: 1,
          appkey: '84956560bc028eb7'
        },
        headers: {
          ...headers,
          Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
        }
      });
      return response.data;
    } catch (error) {
      console.error('获取推荐内容失败:', error.message);
      return { code: -1, message: error.message };
    }
  }

  async generateQrcode() {
    try {
      const response = await this.axios.get(`${BILIBILI_WEB}/x/passport-login/web/qrcode/generate`, {
        headers: { Referer: 'https://passport.bilibili.com/' }
      });
      return response.data;
    } catch (error) {
      console.error('申请二维码失败:', error.message);
      return { code: -1, message: error.message };
    }
  }

  async pollQrcode(qrcodeKey) {
    try {
      const response = await this.axios.get(`${BILIBILI_WEB}/x/passport-login/web/qrcode/poll`, {
        params: { qrcode_key: qrcodeKey },
        headers: { Referer: 'https://passport.bilibili.com/' }
      });
      return { code: 0, data: response.data, headers: response.headers };
    } catch (error) {
      console.error('轮询二维码失败:', error.message);
      return { code: -1, message: error.message };
    }
  }

  async getUserNavInfo() {
    try {
      await this.refreshCookiesFromSession();
      // axios interceptor 会自动注入 Cookie
      const response = await this.axios.get(`${BILIBILI_BASE}/x/web-interface/nav`);
      // 缓存 wbi img_key / sub_key（供 /x/v3/fav/* 接口签名使用）
      if (response.data?.data?.wbi_img) {
        updateWbiKeys(response.data.data.wbi_img);
      }
      return response.data;
    } catch (error) {
      console.error('获取用户信息失败:', error.message);
      return { code: -1, message: error.message };
    }
  }

  async getFavFolderCreatedList(upMid, pn = 1, ps = 50) {
    try {
      await this.refreshCookiesFromSession();
      // axios interceptor 会自动注入 Cookie + 给 /x/v3/fav/ 加 wbi 签名
      const response = await this.axios.get(`${BILIBILI_BASE}/x/v3/fav/folder/created/list`, {
        params: { up_mid: upMid, pn, ps, web_location: '333.1387' }
      });
      return response.data;
    } catch (error) {
      console.error('获取创建的收藏夹失败:', error.message, error.response?.data);
      return { code: -1, message: error.message };
    }
  }

  async getFavFolderCollectedList(upMid, pn = 1, ps = 50) {
    try {
      await this.refreshCookiesFromSession();
      const response = await this.axios.get(`${BILIBILI_BASE}/x/v3/fav/folder/collected/list`, {
        params: { up_mid: upMid, pn, ps, platform: 'web' }
      });
      return response.data;
    } catch (error) {
      console.error('获取收藏的收藏夹失败:', error.message, error.response?.data);
      return { code: -1, message: error.message };
    }
  }

  async getFavResourceList(mediaId, pn = 1, ps = 20) {
    try {
      await this.refreshCookiesFromSession();
      // B 站 /x/v3/fav/resource/list 的 ps 定义域为 1-20，超过会被 -400 拒绝
      // 同步补齐 tid=0（全部分区）与 type=0（仅当前收藏夹），与 biu-master 保持一致
      const safePs = Math.max(1, Math.min(20, Number(ps) || 20));
      const safePn = Math.max(1, Number(pn) || 1);
      // axios interceptor 会自动注入 Cookie + 给 /x/v3/fav/ 加 wbi 签名
      const response = await this.axios.get(`${BILIBILI_BASE}/x/v3/fav/resource/list`, {
        params: { media_id: mediaId, pn: safePn, ps: safePs, tid: 0, type: 0, platform: 'web', order: 'mtime' }
      });
      const data = response.data;
      if (data?.code !== 0) {
        console.error('getFavResourceList B站返回非 0:', data?.code, data?.message, 'mediaId=', mediaId, 'pn=', safePn, 'ps=', safePs);
      } else {
        console.log('[debug] getFavResourceList 成功, medias:', data.data?.medias?.length, 'mediaId=', mediaId);
      }
      return data;
    } catch (error) {
      console.error('获取收藏夹资源失败:', error.message, error.response?.data);
      return { code: -1, message: error.message };
    }
  }

  /**
   * 获取收藏夹全部内容 id（不分页，单次拿到所有 id）
   * 参考 biu-master 的 getFavResourceIds，避免对 /x/v3/fav/resource/list 分页循环触发 -412
   * 注意：/x/v3/fav/resource/ids 不在 /x/v3/fav/ 前缀下，wbi 拦截器不会加签名
   */
  async getFavResourceIds(mediaId) {
    try {
      await this.refreshCookiesFromSession();
      const response = await this.axios.get(`${BILIBILI_BASE}/x/v3/fav/resource/ids`, {
        params: { media_id: mediaId, platform: 'web' }
      });
      const data = response.data;
      if (data?.code !== 0) {
        console.error('getFavResourceIds B站返回非 0:', data?.code, data?.message, 'mediaId=', mediaId);
        return data;
      }
      console.log('[debug] getFavResourceIds 成功, count:', Array.isArray(data?.data) ? data.data.length : 0, 'mediaId=', mediaId);
      return data;
    } catch (error) {
      console.error('获取收藏夹 id 列表失败:', error.message, error.response?.data);
      return { code: -1, message: error.message };
    }
  }

  /**
   * 批量获取收藏资源详情（按 50 个一组）。
   * - resources 形如 "583785685:2,15664:12"（id:type 逗号分隔，最多 50 个）
   * - 注意：/x/v3/fav/resource/infos 不在 /x/v3/fav/ 前缀下，wbi 拦截器不会加签名
   *   但 biu-master 通过 `useWbi: true` 显式给该接口签名，我们走主进程 axios 默认会加
   */
  async getFavResourceInfos(resources) {
    try {
      await this.refreshCookiesFromSession();
      if (typeof resources !== 'string' || !resources) {
        return { code: -400, message: 'resources 不能为空', data: null };
      }
      const response = await this.axios.get(`${BILIBILI_BASE}/x/v3/fav/resource/infos`, {
        params: { resources, platform: 'web' }
      });
      const data = response.data;
      if (data?.code !== 0) {
        console.error('getFavResourceInfos B站返回非 0:', data?.code, data?.message, 'size=', resources.split(',').length);
      } else {
        console.log('[debug] getFavResourceInfos 成功, count:', Array.isArray(data?.data) ? data.data.length : 0);
      }
      return data;
    } catch (error) {
      console.error('获取收藏资源详情失败:', error.message, error.response?.data);
      return { code: -1, message: error.message };
    }
  }

  async getVideoSeries(bvid) {
    try {
      const headers = {
        'Referer': 'https://www.bilibili.com',
        'User-Agent': UserAgent
      };

      const videoInfo = await this.getMusicInfo(bvid);
      if (videoInfo.code === 0 && videoInfo.data && videoInfo.data.season_id) {
        const seasonId = videoInfo.data.season_id;
        const mid = videoInfo.data.owner?.mid;
        
        if (seasonId && mid) {
          const response = await this.axios.get(`${BILIBILI_BASE}/x/polymer/web-space/seasons_archives_list`, {
            params: {
              mid: mid,
              season_id: seasonId
            },
            headers: {
              ...headers,
              Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
            }
          });
          return response.data;
        }
      }
      
      try {
        const response = await this.axios.get(`${BILIBILI_BASE}/x/polymer/space/seasons_archives_list`, {
          params: {
            bvid: bvid
          },
          headers
        });
        return response.data;
      } catch (error) {
        console.error('备用接口获取视频合集失败:', error.message);
      }
      
      return { code: -1, message: '获取视频合集失败' };
    } catch (error) {
      console.error('获取视频合集失败:', error.message);
      return { code: -1, message: error.message };
    }
  }
}

const bilibiliAPI = new BilibiliAPI();

// B 站登录态独立持久化：Electron 20 的 defaultSession 不持久化 cookie，
// 而 session.fromPartition('persist:xxx') 依赖 Chromium 内部 LevelDB
// 懒加载，trae 沙盒下 Partitions/ 目录创建常被拦截。
// 因此我们自己用 JSON 文件保存 .bilibili.com cookie 列表，跨重启保持登录。
// 路径走 app.getPath('userData')，自动跟随 setPath('userData') 固定到开发版独立目录；
// 这样未来跨平台（Windows / Linux）也无需额外分支。
const COOKIE_STORE_PATH = path.join(app.getPath('userData'), 'bilibili-cookies.json');

async function loadCookiesFromFile() {
  try {
    if (fs.existsSync(COOKIE_STORE_PATH)) {
      const raw = fs.readFileSync(COOKIE_STORE_PATH, 'utf-8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        return data;
      }
    }
  } catch (e) {
    console.error('[debug] 读 cookie store 失败:', e);
  }
  return {};
}

// Cookie 写并发锁：多个 webRequest.onHeadersReceived 同时触发 persist 时排队，
// 避免 fs.writeFileSync 半新半旧覆盖。
let cookieWriteLock = null

async function saveCookiesToFile(cookies) {
  // 排队：上一次没写完，本次等它
  while (cookieWriteLock) {
    try { await cookieWriteLock } catch (_) {}
  }
  cookieWriteLock = (async () => {
    try {
      const dir = path.dirname(COOKIE_STORE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // 写 .tmp → 原子 rename，覆盖前备份 .bak（与 appData 原子写策略一致）
      const tmp = `${COOKIE_STORE_PATH}.tmp`
      const bak = `${COOKIE_STORE_PATH}.bak`
      fs.writeFileSync(tmp, JSON.stringify(cookies, null, 2), 'utf-8')
      if (fs.existsSync(COOKIE_STORE_PATH)) {
        try { fs.copyFileSync(COOKIE_STORE_PATH, bak) } catch (_) {}
      }
      fs.renameSync(tmp, COOKIE_STORE_PATH)
    } catch (e) {
      console.error('[debug] 写 cookie store 失败:', e);
    } finally {
      cookieWriteLock = null
    }
  })()
  return cookieWriteLock
}

let mainWindow = null;
let lyricsWindow = null;
let bilibiliSession = null;
const downloadTasks = [];

function getMainWindow() {
  return mainWindow || BrowserWindow.getFocusedWindow();
}

// ============== 桌面歌词悬浮窗 ==============
const DESKTOP_LYRICS_DEFAULT_WIDTH = 900;
const DESKTOP_LYRICS_DEFAULT_HEIGHT = 160;
const DESKTOP_LYRICS_BOUNDS_FILE = () => path.join(app.getPath('userData'), 'desktop-lyrics-bounds.json');

function getLyricsWindow() {
  if (lyricsWindow && !lyricsWindow.isDestroyed()) return lyricsWindow
  return null
}

/**
 * 读取上次保存的窗口位置，并做多显示器兜底（逻辑在 lyricsWindowBounds.js，可单测）：
 * 副屏被拔（位置与所有 workArea 都不相交）→ 回退主屏居中；
 * 仅部分越界 → 夹回重叠最多的那块屏幕。尺寸同时抬到布局硬下限。
 */
function readLyricsBounds() {
  try {
    const file = DESKTOP_LYRICS_BOUNDS_FILE();
    let saved = null;
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (data && typeof data.x === 'number' && typeof data.y === 'number' &&
          typeof data.width === 'number' && typeof data.height === 'number') saved = data;
    }
    // 历史 bounds 里可能存了小于布局硬下限（约 186×40）的尺寸：minWidth/minHeight 只约束
    // 之后的交互缩放，管不到已经落盘的脏数据，所以读取时先抬到 300×60。
    const width = Math.max(300, (saved && saved.width) || DESKTOP_LYRICS_DEFAULT_WIDTH);
    const height = Math.max(60, (saved && saved.height) || DESKTOP_LYRICS_DEFAULT_HEIGHT);
    const { x, y } = resolveLyricsWindowPosition({
      saved,
      displays: screen.getAllDisplays(),
      primary: screen.getPrimaryDisplay(),
      width,
      height
    });
    return { x, y, width, height };
  } catch (_) {
    return null;   // 文件损坏 / 屏幕查询异常：交给 Electron 默认居中，不阻塞开窗
  }
}

/**
 * 创建桌面歌词窗口：透明、无边框、置顶、跳过任务栏、不抢焦点。
 * 窗口内容为独立 Vite 入口 desktop_lyrics.html（src/desktop-lyrics/）。
 */
function createLyricsWindow() {
  const saved = readLyricsBounds();
  lyricsWindow = new BrowserWindow({
    // 尺寸已在 readLyricsBounds 抬到下限（300×60），这里再 clamp 一次兜住 readLyricsBounds 返回 null 的路径
    width: Math.max(300, saved?.width || DESKTOP_LYRICS_DEFAULT_WIDTH),
    height: Math.max(60, saved?.height || DESKTOP_LYRICS_DEFAULT_HEIGHT),
    minWidth: 300,
    minHeight: 60,
    x: saved?.x,
    y: saved?.y,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    skipTaskbar: true,
    show: false,
    focusable: false,           // 不抢系统焦点，点击歌词窗不会让主窗口失焦闪烁
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: false
    }
  });

  // 置顶层级：screen-saver 高于普通应用窗口、低于系统级弹窗
  try { lyricsWindow.setAlwaysOnTop(true, 'screen-saver') } catch (e) { /* ignore */ }

  lyricsWindow.setMenuBarVisibility(false);

  // 拖动/缩放结束后防抖持久化窗口位置（主进程侧直接写文件，绕过渲染层）
  let boundsSaveTimer = null;
  const saveBoundsSoon = () => {
    clearTimeout(boundsSaveTimer);
    boundsSaveTimer = setTimeout(() => {
      const win = getLyricsWindow();
      if (!win) return;
      try {
        const b = win.getBounds();
        fs.writeFileSync(DESKTOP_LYRICS_BOUNDS_FILE(), JSON.stringify(b), 'utf-8');
      } catch (_) {}
    }, 400);
  };
  lyricsWindow.on('move', saveBoundsSoon);
  lyricsWindow.on('resize', saveBoundsSoon);

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    lyricsWindow.loadURL(DEV_SERVER_ORIGIN + '/desktop_lyrics.html');
  } else {
    lyricsWindow.loadFile(path.join(__dirname, '../dist/desktop_lyrics.html'));
  }

  lyricsWindow.once('ready-to-show', () => {
    const win = getLyricsWindow();
    if (win) {
      try { win.showInactive() } catch (e) { /* ignore */ }
    }
  });

  // 关闭时只清引用并通知主窗口停止推送；主进程退出由 app 生命周期统一管理
  lyricsWindow.on('closed', () => { lyricsWindow = null; notifyLyricsVisibility(false) });

  return lyricsWindow;
}

/** 向主窗口同步桌面歌词窗可见性（唯一事实源是主进程，避免渲染层状态漂移） */
function notifyLyricsVisibility(visible) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('desktop-lyrics-visibility', { visible: !!visible }) } catch (_) {}
  }
}

/** 显示/隐藏 桌面歌词窗口；返回当前可见状态 */
function toggleLyricsWindow() {
  let win = getLyricsWindow()
  if (!win) {
    createLyricsWindow()
    notifyLyricsVisibility(true)
    return { code: 0, visible: true, created: true }
  }
  if (win.isVisible()) {
    win.hide()
    notifyLyricsVisibility(false)
    return { code: 0, visible: false }
  }
  win.showInactive()
  notifyLyricsVisibility(true)
  return { code: 0, visible: true }
}

/**
 * 状态中继通道（双向复用 desktop-lyrics-state 一个入口）：
 *   主窗口发出 → 转发给歌词窗口：
 *     progress / track / lyrics / style 四类消息
 *   歌词窗口发出(type=command) → 转发给主窗口：
 *     seek / patch-style / close 等回传命令
 */
ipcMain.on('desktop-lyrics-state', (event, payload) => {
  if (payload && payload.type === 'command') {
    const win = getMainWindow()
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('desktop-lyrics-command', payload) } catch (_) {}
    }
    return
  }
  const win = getLyricsWindow()
  if (!win) return
  try { win.webContents.send('desktop-lyrics-state', payload) } catch (_) {}
});

// 歌词窗口就绪握手：转发给主窗口触发一次全量快照重推（解决开窗瞬间消息早于页面加载的竞态）
ipcMain.on('desktop-lyrics-ready', () => {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('desktop-lyrics-command', { action: 'lyrics-window-ready' }) } catch (_) {}
  }
});

// 歌词窗口 → 主窗口 的命令回传（seek 等）
// 载荷同时带 time 与 payload：渲染层按 cmd.time 读取，命令通道自身用 payload 传递，
// 两边字段名不一致会让 seek 静默变成"跳到 0 秒"。
ipcMain.handle('desktop-lyrics-seek', (_event, time) => {
  const win = getMainWindow()
  const seekTime = Number(time) || 0
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('desktop-lyrics-command', { action: 'seek', time: seekTime, payload: seekTime }) } catch (_) {}
  }
  return { code: 0 }
});

ipcMain.handle('desktop-lyrics-toggle', () => toggleLyricsWindow());

// 工具条关闭按钮：只隐藏不销毁（保留插值状态与 bounds）
ipcMain.handle('desktop-lyrics-hide', () => {
  const win = getLyricsWindow()
  if (win && win.isVisible()) {
    try { win.hide() } catch (_) {}
    notifyLyricsVisibility(false)
  }
  return { code: 0 }
});

// ============== 桌面歌词全局快捷键 ==============
// 快捷键完全由主进程 globalShortcut 接管（聚焦与否都生效）；
// 应用菜单项不再挂 accelerator，避免聚焦时菜单加速器与全局快捷键双触发。
const DESKTOP_LYRICS_HOTKEY_DEFAULT = 'CommandOrControl+D'   // 与 settings store schema v7 默认值互指

let lyricsHotkey = null;          // 当前已注册（或尝试注册）的组合
let lyricsHotkeyRegistered = false;

/** Electron 加速器格式校验：≥1 个修饰键 + 合法按键（防止劫持单键） */
function validateAccelerator(accel) {
  if (typeof accel !== 'string' || accel.length === 0 || accel.length > 64) return false;
  const parts = accel.split('+');
  if (parts.length < 2) return false;   // 必须带修饰键
  const modifiers = new Set([
    'Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl',
    'Alt', 'Option', 'AltGr', 'Shift', 'Super'
  ]);
  const keys = new Set([
    ...('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
    ...('0123456789'.split('')),
    ...Array.from({ length: 24 }, (_, i) => 'F' + (i + 1)),
    'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace',
    'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right',
    'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc',
    'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack',
    'MediaPlayPause', 'MediaStop', 'Plus'
  ]);
  for (let i = 0; i < parts.length - 1; i++) {
    if (!modifiers.has(parts[i])) return false;
  }
  // 修饰键不允许重复堆叠在末位；末位必须是合法按键且不是修饰键本身
  return keys.has(parts[parts.length - 1]);
}

/** 从渲染层持久化的 settings.json 读初值（主进程直读，绕过渲染层 schema 流程） */
function getStoredLyricsHotkey() {
  try {
    const data = readJsonWithFallback(appDataFilePath('settings'));
    if (data && typeof data.desktopLyricsHotkey === 'string' && validateAccelerator(data.desktopLyricsHotkey)) {
      return data.desktopLyricsHotkey;
    }
  } catch (_) {}
  return DESKTOP_LYRICS_HOTKEY_DEFAULT;
}

/**
 * 注册/切换全局快捷键。失败（被其他应用占用）时回滚到 previous 并返回 ok:false。
 */
function applyLyricsHotkey(nextAccel, previous) {
  if (!validateAccelerator(nextAccel)) {
    return { ok: false, conflict: false, reason: 'invalid', registered: lyricsHotkeyRegistered };
  }
  if (lyricsHotkey && lyricsHotkey !== nextAccel) {
    try { globalShortcut.unregister(lyricsHotkey) } catch (_) {}
    lyricsHotkeyRegistered = false;
  }
  let ok = false;
  try {
    ok = globalShortcut.register(nextAccel, () => toggleLyricsWindow());
  } catch (_) {
    ok = false;
  }
  if (ok) {
    lyricsHotkey = nextAccel;
    lyricsHotkeyRegistered = true;
    console.log('[desktop-lyrics] 全局快捷键已注册:', nextAccel);
    return { ok: true, conflict: false, registered: true };
  }
  // 冲突：尝试回滚旧键
  console.warn('[desktop-lyrics] 全局快捷键注册失败（可能被占用）:', nextAccel);
  if (previous && previous !== nextAccel) {
    try {
      if (globalShortcut.register(previous, () => toggleLyricsWindow())) {
        lyricsHotkey = previous;
        lyricsHotkeyRegistered = true;
      }
    } catch (_) {}
  }
  return { ok: false, conflict: true, registered: lyricsHotkeyRegistered };
}

ipcMain.handle('desktop-lyrics-hotkey-get', () => ({
  code: 0,
  accel: lyricsHotkey || getStoredLyricsHotkey(),
  registered: lyricsHotkeyRegistered
}));

ipcMain.handle('desktop-lyrics-hotkey-set', (_event, accel) => {
  const prev = lyricsHotkey || getStoredLyricsHotkey();
  const result = applyLyricsHotkey(String(accel || ''), prev);
  return { code: result.ok ? 0 : (result.conflict ? -2 : -400), ...result, accel: lyricsHotkey };
});

ipcMain.handle('desktop-lyrics-get-visible', () => {
  const win = getLyricsWindow()
  return { code: 0, visible: !!(win && win.isVisible()) }
});

// 锁定穿透切换：锁定后整窗 setIgnoreMouseEvents(true)，鼠标事件落到下层应用
ipcMain.handle('desktop-lyrics-set-ignore-mouse', (_event, ignore) => {
  const win = getLyricsWindow()
  if (win && !win.isDestroyed()) {
    try { win.setIgnoreMouseEvents(!!ignore) } catch (_) {}
  }
  return { code: 0 }
});

function broadcastDownloadProgress(task) {
  const window = getMainWindow();
  if (window && !window.isDestroyed()) {
    window.webContents.send('download-progress', task);
  }
}

// 下载进度推送节流：避免流式 data 事件把 IPC 打满
const DOWNLOAD_PROGRESS_BROADCAST_MS = 200;
function createDownloadProgressThrottler(task) {
  let lastAt = 0;
  return function notify(force = false) {
    const now = Date.now();
    if (!force && now - lastAt < DOWNLOAD_PROGRESS_BROADCAST_MS) return;
    lastAt = now;
    broadcastDownloadProgress(task);
  };
}

function installWebRequestInterceptors(targetSession) {
  const sessionToUse = targetSession || (session && session.defaultSession);
  if (!sessionToUse) {
    console.error('未找到可用的 session，跳过 webRequest 拦截器安装');
    return;
  }
  const urls = ["http://*/*", "https://*/*"];
  const origin = "https://www.bilibili.com";
  const referer = "https://www.bilibili.com";

  const onBeforeSendHeadersHandler = async (details, callback) => {
    const headers = details.requestHeaders || {};

    headers["Referer"] = referer;
    headers["Origin"] = origin;
    headers["User-Agent"] = UserAgent;

    // 从持久化 Electron session 读取 cookies 并添加到请求头
    try {
      const sessionCookies = await sessionToUse.cookies.get({ domain: '.bilibili.com' });
      if (sessionCookies && sessionCookies.length > 0) {
        const cookieString = sessionCookies.map(c => `${c.name}=${c.value}`).join('; ');
        if (cookieString) {
          headers["Cookie"] = cookieString;
        }
      }
    } catch (error) {
      console.error('读取 cookies 失败:', error);
    }

    callback({ requestHeaders: headers });
  };

  const onHeadersReceivedHandler = (details, callback) => {
    const responseHeaders = details.responseHeaders || {};
    const setCookieKey = Object.keys(responseHeaders).find(k => k.toLowerCase() === "set-cookie");

    if (!setCookieKey) {
      callback({ responseHeaders });
      return;
    }

    const raw = responseHeaders[setCookieKey.toLowerCase()];
    const cookies = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];

    const rewritten = cookies.map(cookie => {
      // 简易重写：补齐 SameSite=None; Secure，供跨站嵌入场景
      let result = cookie;
      if (!/;\s*samesite=/i.test(result)) {
        result += '; SameSite=None';
      }
      if (!/;\s*secure/i.test(result)) {
        result += '; Secure';
      }
      return result;
    });

    responseHeaders[setCookieKey] = rewritten;
    callback({ responseHeaders });
  };

  sessionToUse.webRequest.onBeforeSendHeaders({ urls }, onBeforeSendHeadersHandler);
  sessionToUse.webRequest.onHeadersReceived({ urls }, onHeadersReceivedHandler);
}

// 开发服务器地址：端口可用 VITE_DEV_PORT 环境变量覆盖（默认 5173），
// 便于多项目并行开发时错开端口
const DEV_SERVER_ORIGIN = `http://localhost:${process.env.VITE_DEV_PORT || 5173}`;

// ── 主窗口尺寸约束（随屏幕可用工作区动态计算） ──────────────────
// 1000×700 是主界面（顶栏 + 内容区 + 底部 dock / 播放条）不出现元素互相遮挡的 DIP 下限；
// 但 Windows 缩放笔记本上这个下限会大于屏幕：1366×768 物理屏 @150% 的可用 DIP 只有约 911×512，
// @175% 更小。硬套 1000×700 会把窗口撑出屏幕，右下角（dock 右端、播放控制）跑到屏幕外看不见。
// 所以真实下限取"布局下限"与"屏幕可用区"的较小者，窗口始终能整块落在 workArea 内。
const MAIN_WINDOW_PREFERRED_MIN_WIDTH = 1000;
const MAIN_WINDOW_PREFERRED_MIN_HEIGHT = 700;
const MAIN_WINDOW_PREFERRED_WIDTH = 1200;
const MAIN_WINDOW_PREFERRED_HEIGHT = 800;
// 屏幕再小也不能无限缩：低于这个尺寸顶栏 + 内容 + dock 会挤到无法交互
const MAIN_WINDOW_HARD_MIN_WIDTH = 720;
const MAIN_WINDOW_HARD_MIN_HEIGHT = 560;
// 与任务栏、DWM 阴影/圆角、边缘吸附之间留的余量
const MAIN_WINDOW_WORK_AREA_MARGIN = 40;

// 与桌面歌词窗（desktop-lyrics-bounds.json）同一套持久化习惯：<userData>/main-window-bounds.json
const MAIN_WINDOW_BOUNDS_FILE = () => path.join(app.getPath('userData'), 'main-window-bounds.json');

/** 读取已保存的主窗口尺寸；文件缺失/损坏一律返回 null（回落到默认尺寸） */
function readMainWindowBounds() {
  try {
    const file = MAIN_WINDOW_BOUNDS_FILE();
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return data && typeof data === 'object' ? data : null;
  } catch (_) {
    return null;
  }
}

/**
 * 按屏幕可用工作区（DIP）计算主窗口尺寸约束。纯函数，便于单测。
 * 目标：窗口永远能完整落在 workArea 内；下限尽量保持 1000×700，屏幕不够时让位给屏幕。
 * @param {{width:number,height:number}|null} workArea screen.getPrimaryDisplay().workAreaSize
 * @returns {{minWidth:number,minHeight:number,defaultWidth:number,defaultHeight:number,maxWidth:number,maxHeight:number}}
 */
function computeMainWindowConstraints(workArea) {
  const toSize = (value) => {
    const num = Math.round(Number(value) || 0);
    return num > 0 ? num : 1;
  };
  const areaWidth = toSize(workArea && workArea.width);
  const areaHeight = toSize(workArea && workArea.height);
  const clampValue = (value, lower, upper) => Math.max(lower, Math.min(value, upper));

  // 下限：先按"可用区 - 余量"算，再夹在 [硬下限, 布局下限] 内，最后不超过可用区本身
  const minOf = (area, preferredMin, hardMin) => clampValue(
    Math.min(preferredMin, Math.max(hardMin, area - MAIN_WINDOW_WORK_AREA_MARGIN)),
    1,
    area
  );
  const minWidth = minOf(areaWidth, MAIN_WINDOW_PREFERRED_MIN_WIDTH, MAIN_WINDOW_HARD_MIN_WIDTH);
  const minHeight = minOf(areaHeight, MAIN_WINDOW_PREFERRED_MIN_HEIGHT, MAIN_WINDOW_HARD_MIN_HEIGHT);

  // 默认尺寸：先用 1200×800，屏幕放不下就收缩到"可用区 - 余量"，再夹进 [下限, 可用区]
  const defaultOf = (area, preferred, min) =>
    clampValue(Math.min(preferred, area - MAIN_WINDOW_WORK_AREA_MARGIN), min, area);

  return {
    minWidth,
    minHeight,
    defaultWidth: defaultOf(areaWidth, MAIN_WINDOW_PREFERRED_WIDTH, minWidth),
    defaultHeight: defaultOf(areaHeight, MAIN_WINDOW_PREFERRED_HEIGHT, minHeight),
    maxWidth: areaWidth,
    maxHeight: areaHeight
  };
}

/** 拿不到屏幕信息时的兜底约束（等同改造前行为：下限 1000×700、默认 1200×800、不设上限） */
const MAIN_WINDOW_FALLBACK_LIMITS = {
  minWidth: MAIN_WINDOW_PREFERRED_MIN_WIDTH,
  minHeight: MAIN_WINDOW_PREFERRED_MIN_HEIGHT,
  defaultWidth: MAIN_WINDOW_PREFERRED_WIDTH,
  defaultHeight: MAIN_WINDOW_PREFERRED_HEIGHT,
  maxWidth: Number.POSITIVE_INFINITY,
  maxHeight: Number.POSITIVE_INFINITY
};

/**
 * 把读取到的已保存窗口尺寸收敛到当前屏幕允许的范围：
 * - 低于动态下限（小屏笔记本会小于 1000×700）→ 抬到下限，避免顶栏/dock/播放条互相遮挡；
 * - 高于 workArea → 夹到 workArea，避免窗口超出屏幕、右下角控件看不见；
 * - 缺失/非法 → 用动态默认尺寸；x/y 保持原有透传行为。
 */
function clampMainWindowBounds(bounds, constraints) {
  if (!bounds || typeof bounds !== 'object') return null;
  const limits = constraints || MAIN_WINDOW_FALLBACK_LIMITS;
  const toInt = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null);
  const fit = (value, min, max, fallback) => {
    const num = toInt(value);
    if (num === null || num <= 0) return fallback;
    return Math.max(min, Math.min(num, max));
  };
  return {
    width: fit(bounds.width, limits.minWidth, limits.maxWidth, limits.defaultWidth),
    height: fit(bounds.height, limits.minHeight, limits.maxHeight, limits.defaultHeight),
    x: toInt(bounds.x),
    y: toInt(bounds.y)
  };
}

function createWindow() {
  // screen 模块只能在 app ready 之后访问：createWindow 由 app.whenReady() 回调调用
  const constraints = computeMainWindowConstraints(screen.getPrimaryDisplay().workAreaSize);
  // 已保存的窗口尺寸在读取时按当前屏幕的动态下限 clamp（历史脏数据也不能把窗口挤出屏幕）
  const savedBounds = clampMainWindowBounds(readMainWindowBounds(), constraints);
  mainWindow = new BrowserWindow({
    width: savedBounds ? savedBounds.width : constraints.defaultWidth,
    height: savedBounds ? savedBounds.height : constraints.defaultHeight,
    // 再兜一层：用户手动拖拽也不能把主界面拖到动态下限以下
    minWidth: constraints.minWidth,
    minHeight: constraints.minHeight,
    ...(savedBounds && savedBounds.x !== null && savedBounds.y !== null
      ? { x: savedBounds.x, y: savedBounds.y }
      : {}),
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: false
    }
  });

  // 隐藏菜单栏
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setAutoHideMenuBar(true);

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL(DEV_SERVER_ORIGIN + '/');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

/**
 * 构建并安装 macOS 原生应用菜单。
 * 仅在 darwin 平台注册，Windows 仍由 setMenuBarVisibility(false) 隐藏菜单栏。
 * - 视图/播放类项通过 'menu-command' IPC 派发到渲染进程，
 *   渲染进程在 App.vue 的 handleMenuCommand 统一处理。
 * - 窗口控制/重载/DevTools 直接在主进程操作 mainWindow。
 */
function buildApplicationMenu() {
  if (process.platform !== 'darwin') return

  const isMac = true
  const send = (action, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('menu-command', { action, payload })
    }
  }

  const template = [
    // ---- App 菜单（macOS 自动提供 About / Services / Hide / Quit）----
    ...(isMac ? [{
      label: app.name,           // 显示为 "Pink Music"
      submenu: [
        { role: 'about' },
        { label: '检查更新…', click: () => send('check-update') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),

    // ---- Edit（恢复 macOS 标准文本编辑快捷键 Cmd+C/V/X/A/Z）----
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        ...(isMac ? [
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' }
        ] : [
          { role: 'delete' },
          { type: 'separator' },
          { role: 'selectAll' }
        ])
      ]
    },

    // ---- View ----
    {
      label: '视图',
      submenu: [
        { label: '主页',     accelerator: 'CmdOrCtrl+1', click: () => send('go-home') },
        { label: '搜索',     accelerator: 'CmdOrCtrl+2', click: () => send('go-search') },
        { label: '我的',     accelerator: 'CmdOrCtrl+3', click: () => send('go-mine') },
        { type: 'separator' },
        { label: '全屏播放器', accelerator: 'CmdOrCtrl+Return', click: () => send('toggle-player-page') },
        { type: 'separator' },
        { label: '切换主题', accelerator: 'CmdOrCtrl+Shift+T', click: () => send('toggle-theme') },
        { label: '切换歌词', accelerator: 'CmdOrCtrl+L',         click: () => send('toggle-lyric') },
        { label: '切换可视化', accelerator: 'CmdOrCtrl+Shift+V', click: () => send('toggle-visualizer') },
        { type: 'separator' },
        // 桌面歌词快捷键由 globalShortcut 全局接管（聚焦与否都生效）；
        // 菜单项不挂 accelerator，避免应用聚焦时与全局快捷键双触发。点击仍可开关。
        { label: '桌面歌词', click: () => send('toggle-desktop-lyrics') }
      ]
    },

    // ---- Playback ----
    {
      label: '播放',
      submenu: [
        // 不挂 Space 加速键：菜单加速器会在输入框聚焦时抢走空格（输入空格变成播放/暂停）
        { label: '播放 / 暂停', click: () => send('toggle-play-pause') },
        { label: '下一首',     accelerator: 'CmdOrCtrl+Right', click: () => send('play-next') },
        { label: '上一首',     accelerator: 'CmdOrCtrl+Left',  click: () => send('play-previous') },
        { type: 'separator' },
        {
          label: '播放模式',
          submenu: [
            { label: '顺序播放', type: 'radio', checked: false, click: () => send('set-play-mode', 'order') },
            { label: '列表循环', type: 'radio', checked: false, click: () => send('set-play-mode', 'loop') },
            { label: '单曲循环', type: 'radio', checked: false, click: () => send('set-play-mode', 'single') },
            { label: '随机播放', type: 'radio', checked: false, click: () => send('set-play-mode', 'shuffle') }
          ]
        },
        { type: 'separator' },
        { label: '下一分P', accelerator: 'CmdOrCtrl+Shift+Right', click: () => send('next-episode') },
        { label: '上一分P', accelerator: 'CmdOrCtrl+Shift+Left',  click: () => send('previous-episode') }
      ]
    },

    // ---- Window ----
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'CmdOrCtrl+M', click: () => { if (mainWindow) mainWindow.minimize() } },
        {
          label: '缩放',
          click: () => {
            if (!mainWindow) return
            mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize()
          }
        }
      ]
    }
  ]

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

app.whenReady().then(async () => {
  // 本地音乐资源协议：pinkmusic-local://
  //   cover/<name>   → <userData>/local-covers/<name>   （封面图，目录白名单）
  //   audio/<encoded>→ 绝对路径音频文件              （仅允许音频扩展名 + 文件必须存在）
  registerLocalProtocol();

  // 直接使用 defaultSession（仅供 webRequest 拦截器使用）；
  // B 站登录态走 JSON 文件持久化（COOKIE_STORE_PATH）。
  bilibiliSession = session.defaultSession;
  // 调试日志
  try {
    const userData = app.getPath('userData');
    console.log('[debug] app.getPath(userData) =', userData);
    console.log('[debug] cookie store path =', COOKIE_STORE_PATH);
    if (fs.existsSync(COOKIE_STORE_PATH)) {
      const stat = fs.statSync(COOKIE_STORE_PATH);
      console.log('[debug] cookie store 文件存在, size =', stat.size, 'mtime =', stat.mtime.toISOString());
    } else {
      console.log('[debug] cookie store 文件不存在（首次启动或未登录）');
    }
  } catch (e) {
    console.error('[debug] 路径打印失败:', e);
  }
  // 启动时从 JSON 恢复 B 站登录 cookie 到 bilibiliAPI.cookies
  try {
    await bilibiliAPI.refreshCookiesFromSession();
  } catch (e) {
    console.error('[debug] 启动时加载 cookie 失败:', e);
  }
  installWebRequestInterceptors(bilibiliSession);
  createWindow();
  // 安装 macOS 原生应用菜单（非 darwin 平台由 buildApplicationMenu 内部 no-op）
  buildApplicationMenu();
  // 注册桌面歌词全局快捷键（读渲染层持久化的 settings.json 初值）
  applyLyricsHotkey(getStoredLyricsHotkey(), null);
  try { discordRpcManager.init(); } catch (e) { console.warn('Discord RPC init error:', e.message); }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ============== 关窗 flush 协议 ==============
// 协议：before-quit → 发 app-data-flush-required → 渲染进程写盘 → 渲染进程发 app-data-flush-done → 主进程真正退出
// 超时：3s 内没收到 ack 就 app.exit(0) 强制退出
let isFlushing = false
let flushDoneReceived = false

app.on('before-quit', (event) => {
  if (isFlushing) return  // 已经在 flush 流程中，不再二次拦截
  isFlushing = true
  flushDoneReceived = false

  // 0) 注销全局快捷键，避免退出瞬间按键仍触发 toggle
  try { globalShortcut.unregisterAll() } catch (_) {}
  try { discordRpcManager.destroy(); } catch (_) {}

  // 0.5) 缓存索引立即落盘（下载/播放期间是 debounce 写）
  try { cacheManager.flush() } catch (e) {
    console.error('[before-quit] cacheManager flush 失败:', e)
  }

  // 1) 先把 cookie store 同步落盘（Electron 自身 API）
  const target = bilibiliSession || (session && session.defaultSession)
  try { target?.cookies?.flushStore?.() } catch (e) {
    console.error('[before-quit] flushStore 失败:', e)
  }

  // 2) 给渲染进程发 flush 信号（显式主窗口，避免投递到桌面歌词窗）
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('app-data-flush-required') } catch (e) {
      console.error('[before-quit] 发送 flush 信号失败:', e)
    }
  }

  // 3) 等渲染进程 ack，最多 3s
  const timeout = setTimeout(() => {
    if (!flushDoneReceived) {
      console.warn('[before-quit] flush 3s 超时，强制退出')
      // 不重置 isFlushing，防止 app.exit(0) 触发 before-quit 重入
      app.exit(0)
    }
  }, 3000)

  // 4) 拦截 quit，等 ack
  event.preventDefault()

  // 注册一次性的 ack 监听
  ipcMain.once('app-data-flush-done', () => {
    if (flushDoneReceived) return  // 已处理过，防止重入
    flushDoneReceived = true
    clearTimeout(timeout)
    console.log('[before-quit] 收到渲染进程 flush ack，退出')
    // 不重置 isFlushing，防止 app.quit() 触发 before-quit 重入
    app.exit(0)
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ==================== 本地音乐：协议 + IPC ====================
// 本地封面缓存目录：<userData>/local-covers/
const LOCAL_COVER_DIR = localLibrary.getCoverDir(app.getPath('userData'));

/**
 * 注册 pinkmusic-local:// 协议。
 * 白名单策略：
 *   - cover/<name>：只允许 local-covers 目录下的单层文件名（防路径穿越）
 *   - audio/<uri-encoded-abs-path>：必须是绝对路径、扩展名在白名单内、且文件真实存在
 */
function registerLocalProtocol() {
  protocol.registerFileProtocol('pinkmusic-local', (request, callback) => {
    let done = false;
    try {
      const url = new URL(request.url);
      // host 用于区分资源类型（cover / audio）
      const kind = url.hostname;
      let raw = decodeURIComponent(url.pathname.replace(/^\//, ''));

      if (kind === 'cover') {
        // 只取文件名，杜绝 ../ 穿越
        const name = path.basename(raw);
        if (!name || !/^[a-f0-9]{8,}\.(jpg|jpeg|png|webp|gif)$/i.test(name)) {
          done = true;
          return callback({ error: -6 });
        }
        const full = path.join(LOCAL_COVER_DIR, name);
        done = true;
        return callback({ path: full });
      }

      if (kind === 'audio') {
        if (!path.isAbsolute(raw)) {
          done = true;
          return callback({ error: -6 });
        }
        if (!localLibrary.isAudioFile(raw)) {
          done = true;
          return callback({ error: -6 });
        }
        if (!fs.existsSync(raw)) {
          done = true;
          return callback({ error: -6 });
        }
        done = true;
        return callback({ path: raw });
      }

      done = true;
      return callback({ error: -6 });
    } catch (e) {
      if (!done) callback({ error: -6 });
    }
  });
  dlog('[local] pinkmusic-local 协议已注册');
}

/** 递归扫描：把文件/文件夹展开成音频绝对路径列表 */
ipcMain.handle('local-scan-paths', async (event, paths) => {
  try {
    const files = localLibrary.scanPaths(paths || []);
    return { code: 0, data: files };
  } catch (e) {
    console.error('[local] scan 失败:', e.message);
    return { code: -1, message: e.message };
  }
});

/** 弹出选择框导入文件 / 文件夹 */
ipcMain.handle('local-import-files', async () => {
  try {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择音频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: localLibrary.DIALOG_AUDIO_EXTENSIONS },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { code: 0, data: [] };
    }
    const files = localLibrary.scanPaths(result.filePaths);
    return { code: 0, data: files };
  } catch (e) {
    console.error('[local] import-files 失败:', e.message);
    return { code: -1, message: e.message };
  }
});

ipcMain.handle('local-import-folder', async () => {
  try {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections']
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { code: 0, data: { files: [], folderName: '' } };
    }
    const files = localLibrary.scanPaths(result.filePaths);
    const folderName = result.filePaths.length === 1
      ? path.basename(result.filePaths[0])
      : '本地音乐';
    return { code: 0, data: { files, folderName, baseDir: result.filePaths[0] } };
  } catch (e) {
    console.error('[local] import-folder 失败:', e.message);
    return { code: -1, message: e.message };
  }
});

/** 解析元数据（分批，进度通过 event.sender 回推） */
ipcMain.handle('local-parse-metadata', async (event, filePaths) => {
  try {
    const list = Array.isArray(filePaths) ? filePaths : [];
    const sender = event.sender;
    const tracks = await localLibrary.parseFiles(list, LOCAL_COVER_DIR, (p) => {
      try { sender.send('local-parse-progress', p) } catch (_) {}
    });
    return { code: 0, data: tracks };
  } catch (e) {
    console.error('[local] parse-metadata 失败:', e.message);
    return { code: -1, message: e.message };
  }
});

/** 校验文件存在性（失效检测） */
ipcMain.handle('local-check-files', async (event, files) => {
  try {
    return { code: 0, data: localLibrary.checkFiles(files || []) };
  } catch (e) {
    return { code: -1, message: e.message };
  }
});

/** 读取同名 .lrc 歌词内容 */
ipcMain.handle('local-read-lrc', async (event, lyricPath) => {
  try {
    if (!lyricPath || !fs.existsSync(lyricPath)) {
      return { code: -1, message: '歌词文件不存在' };
    }
    const content = fs.readFileSync(lyricPath, 'utf-8');
    return { code: 0, data: content };
  } catch (e) {
    return { code: -1, message: e.message };
  }
});

/** 重新探测某文件的同名歌词（用户手动放好歌词后刷新用） */
ipcMain.handle('local-find-lrc', async (event, filePath) => {
  try {
    return { code: 0, data: localLibrary.findSidecarLrc(filePath) || '' };
  } catch (e) {
    return { code: -1, message: e.message };
  }
});

/** 自定义歌单封面：选择图片 → 拷贝进 local-covers → 返回协议 URL */
ipcMain.handle('local-save-cover', async () => {
  try {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '选择封面图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { code: 0, data: { url: '' } };
    }
    const src = result.filePaths[0];
    const buf = fs.readFileSync(src);
    const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20);
    const ext = path.extname(src).toLowerCase() || '.jpg';
    const name = `${hash}${ext}`;
    const dest = path.join(LOCAL_COVER_DIR, name);
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
    return { code: 0, data: { url: localLibrary.coverUrl(name) } };
  } catch (e) {
    console.error('[local] save-cover 失败:', e.message);
    return { code: -1, message: e.message };
  }
});

/** 打开文件所在目录（失效曲目重新定位用 / 右键定位） */
ipcMain.handle('local-reveal-file', async (event, filePath) => {
  try {
    if (filePath && fs.existsSync(filePath)) {
      shell.showItemInFolder(filePath);
      return { code: 0 };
    }
    return { code: -1, message: '文件不存在' };
  } catch (e) {
    return { code: -1, message: e.message };
  }
});

/** 重新定位失效曲目：选择新文件，返回新的 filePath（前端再解析元数据） */
ipcMain.handle('local-relocate-file', async () => {
  try {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win, {
      title: '重新定位音频文件',
      properties: ['openFile'],
      filters: [{ name: '音频文件', extensions: localLibrary.DIALOG_AUDIO_EXTENSIONS }]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { code: 0, data: { filePath: '' } };
    }
    return { code: 0, data: { filePath: result.filePaths[0] } };
  } catch (e) {
    return { code: -1, message: e.message };
  }
});

// ==================== 云端封面匹配（参考 HisAtri/LrcApi） ====================
// 与歌词链路同构：
//   local-search-cover   ↔ search-lyric      候选列表（手动搜索）
//   local-match-cover    ↔ get-lyric         按 歌名/歌手/专辑 自动匹配
//   local-apply-cover    ↔ get-lyric-by-id   应用选中的候选

/** 把下载到的封面字节落盘到 local-covers，返回 pinkmusic-local:// 引用 */
function persistCoverBuffer(buffer, contentType) {
  const name = localLibrary.writeCoverImage(LOCAL_COVER_DIR, buffer, contentType);
  return name ? localLibrary.coverUrl(name) : '';
}

/** 候选搜索：iTunes（原版优先）+ 网易云，返回带缩略图的候选列表 */
ipcMain.handle('local-search-cover', async (event, keyword) => {
  try {
    const list = await coverSources.searchCoverCandidates(String(keyword || '').trim());
    return { code: 0, data: list };
  } catch (e) {
    console.error('[cover] 候选搜索失败:', e.message);
    return { code: -1, message: e.message };
  }
});

/**
 * 自动匹配：多源候选校验 → 取封面 → 落盘 → 返回协议 URL。
 * 校验不通过时返回「未匹配到封面」，宁可留空也不写错封面。
 * （参考 HisAtri/LrcApi，但先做相关性校验，因为 LrcApi 对任意查询都会"尽力"返回一张图）
 */
ipcMain.handle('local-match-cover', async (event, payload) => {
  try {
    const { title = '', artist = '', album = '' } = payload || {};
    const hit = await coverSources.matchCoverByQuery({ title, artist, album });
    if (!hit) return { code: -1, message: '未匹配到封面' };
    const url = persistCoverBuffer(hit.buffer, hit.contentType);
    if (!url) return { code: -1, message: '封面写入失败' };
    return {
      code: 0,
      data: {
        url,
        matchedName: hit.matched?.name || '',
        matchedArtist: hit.matched?.artist || '',
        provider: hit.matched?.provider || ''
      },
      source: hit.matched?.provider || 'lrcapi'
    };
  } catch (e) {
    console.error('[cover] 自动匹配失败:', e.message);
    return { code: -1, message: e.message };
  }
});

/**
 * 应用候选：下载指定 URL 的封面 → 落盘 → 返回协议 URL。
 * 候选自带的歌手名一并回传（渲染层据此更新曲目作者）；
 * 这里只做透传，不改写任何用户数据，空值/占位由渲染层忽略。
 */
ipcMain.handle('local-apply-cover', async (event, payload) => {
  try {
    const url = payload?.url || '';
    if (!url) return { code: -1, message: '缺少封面地址' };
    const hit = await coverSources.downloadCoverByUrl(url);
    if (!hit) return { code: -1, message: '封面下载失败' };
    const localUrl = persistCoverBuffer(hit.buffer, hit.contentType);
    if (!localUrl) return { code: -1, message: '封面写入失败' };
    return {
      code: 0,
      data: {
        url: localUrl,
        artist: String(payload?.artist || '').trim(),
        name: String(payload?.name || '').trim()
      },
      source: payload?.provider || 'manual'
    };
  } catch (e) {
    console.error('[cover] 应用候选失败:', e.message);
    return { code: -1, message: e.message };
  }
});

// ==================== 主存 appData IPC ====================
// 注意：appDataEncrypted 通道本次先不实现，user.js 走明文 appData。
// 渲染层自动兼容（见 user.js 改动）。TODO: 等 safeStorage 通道补齐后改回 encrypt: true。
ipcMain.handle('app-data-get', (event, key) => {
  if (typeof key !== 'string' || !key) return { code: -400, message: 'key 必填' }
  try {
    const data = readJsonWithFallback(appDataFilePath(key))
    if (data === null) return { code: 0, data: null }
    return { code: 0, data }
  } catch (e) {
    console.error(`[appData] get ${key} 失败:`, e.message)
    return { code: -1, message: e.message }
  }
})

ipcMain.handle('app-data-set', (event, key, value) => {
  if (typeof key !== 'string' || !key) return { code: -400, message: 'key 必填' }
  try {
    atomicWriteJson(appDataFilePath(key), value)
    return { code: 0 }
  } catch (e) {
    console.error(`[appData] set ${key} 失败:`, e.message)
    return { code: -1, message: e.message }
  }
})

ipcMain.handle('app-data-remove', (event, key) => {
  if (typeof key !== 'string' || !key) return { code: -400, message: 'key 必填' }
  try {
    const p = appDataFilePath(key)
    if (fs.existsSync(p)) fs.unlinkSync(p)
    const bak = `${p}.bak`
    if (fs.existsSync(bak)) fs.unlinkSync(bak)
    return { code: 0 }
  } catch (e) {
    console.error(`[appData] remove ${key} 失败:`, e.message)
    return { code: -1, message: e.message }
  }
})

ipcMain.handle('search-music', async (event, keyword, page, pageSize) => {
  try {
    const result = await bilibiliAPI.searchMusic(keyword, page, pageSize);
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-music-comprehensive-web-rank', async (event, pn, ps) => {
  try {
    const result = await bilibiliAPI.getMusicComprehensiveWebRank(pn, ps);
    return result;
  } catch (error) {
    return { code: -1, message: error.message, data: { list: [] } };
  }
});

ipcMain.handle('get-music-region-feed', async (event, displayId, requestCnt) => {
  try {
    const result = await bilibiliAPI.getMusicRegionFeed(displayId, requestCnt);
    return result;
  } catch (error) {
    return { code: -1, message: error.message, data: { archives: [] } };
  }
});

ipcMain.handle('get-music-info', async (event, bvid) => {
  try {
    const result = await bilibiliAPI.getMusicInfo(bvid);
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-music-play-url', async (event, bvid, cid) => {
  try {
    const result = await bilibiliAPI.getMusicPlayUrl(bvid, cid);
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

// 注意：整文件 arraybuffer + base64 过 IPC 内存成本极高，播放主路径不走这里。
// 仅保留兼容接口；新代码请直接使用 playurl 返回的 CDN 地址或本地缓存文件。
ipcMain.handle('proxy-audio', async (event, audioUrl) => {
  try {
    dlog('收到音频代理请求:', audioUrl);
    const buffer = await bilibiliAPI.getAudioProxy(audioUrl);
    return { code: 0, data: buffer.toString('base64') };
  } catch (error) {
    console.error('代理音频失败:', error);
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-recommendations', async (event) => {
  try {
    const result = await bilibiliAPI.getRecommendations();
    dlog('推荐内容 code:', result?.code, 'count:', result?.data?.item?.length);
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-video-episodes', async (event, bvid) => {
  try {
    const result = await bilibiliAPI.getVideoEpisodes(bvid);
    console.log('获取视频分P结果:', JSON.stringify(result)?.substring(0, 500));
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-video-series', async (event, bvid) => {
  try {
    const result = await bilibiliAPI.getVideoSeries(bvid);
    console.log('获取视频合集结果:', JSON.stringify(result)?.substring(0, 500));
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

// ==================== 登录与收藏夹同步 ====================

function extractSetCookies(headers) {
  if (!headers) return [];
  const raw = headers['set-cookie'] || headers['Set-Cookie'];
  if (!raw) return [];
  return Array.isArray(raw) ? raw : [raw];
}

function parseSetCookieString(cookie) {
  if (!cookie) return null;
  const parts = cookie.split(';').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const first = parts[0];
  const eq = first.indexOf('=');
  if (eq < 0) return null;
  const result = {
    name: first.slice(0, eq).trim(),
    value: first.slice(eq + 1).trim()
  };
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const idx = seg.indexOf('=');
    if (idx < 0) continue;
    const key = seg.slice(0, idx).trim().toLowerCase();
    const val = seg.slice(idx + 1).trim();
    if (key === 'expires') result.expires = val;
    else if (key === 'max-age') result.maxAge = parseInt(val, 10);
    else if (key === 'path') result.path = val;
    else if (key === 'domain') result.domain = val;
    else if (key === 'httponly') result.httpOnly = true;
    else if (key === 'secure') result.secure = true;
    else if (key === 'samesite') result.sameSite = val;
  }
  return result;
}

async function persistBilibiliCookies(headers) {
  const targetSession = bilibiliSession || (session && session.defaultSession);
  if (!targetSession) return;
  const setCookies = extractSetCookies(headers);
  console.log('[debug] persistBilibiliCookies 收到', setCookies.length, '个 set-cookie');
  for (const cookie of setCookies) {
    const parsed = parseSetCookieString(cookie);
    if (!parsed || !parsed.name) continue;
    try {
      const cookieDetails = {
        url: 'https://bilibili.com/',
        domain: '.bilibili.com',
        path: '/',
        name: parsed.name,
        value: parsed.value,
        secure: true,
        sameSite: 'no_restriction',
        httpOnly: false
      };
      if (parsed.expires) {
        const exp = Date.parse(parsed.expires);
        if (!Number.isNaN(exp)) {
          cookieDetails.expirationDate = Math.floor(exp / 1000);
        }
      }
      // 同步写入 session（供渲染进程 webRequest 拦截器使用）
      await targetSession.cookies.set(cookieDetails);
      // 立即同步写入内存 cookie 字典 + JSON 文件（保证持久化）
      bilibiliAPI.cookies[parsed.name] = parsed.value;
      try { fs.writeFileSync(COOKIE_STORE_PATH, JSON.stringify(bilibiliAPI.cookies, null, 2), 'utf-8'); } catch (e) {}
      console.log('[debug] 写入 cookie:', parsed.name, 'expires:', parsed.expires || 'session');
    } catch (error) {
      console.warn('写入 cookie 失败:', parsed.name, error.message);
    }
  }
  // 落盘确认
  try {
    const stat = fs.statSync(COOKIE_STORE_PATH);
    console.log('[debug] persistBilibiliCookies 后 cookie store file size =', stat.size, 'mtime =', stat.mtime.toISOString());
  } catch (e) {}
  await bilibiliAPI.refreshCookiesFromSession();
}

ipcMain.handle('generate-qrcode', async () => {
  return await bilibiliAPI.generateQrcode();
});

ipcMain.handle('poll-qrcode', async (event, qrcodeKey) => {
  if (!qrcodeKey) return { code: -1, message: '缺少 qrcode_key' };
  const result = await bilibiliAPI.pollQrcode(qrcodeKey);
  if (result.code === 0) {
    const pollData = result.data?.data;
    if (pollData && pollData.code === 0) {
      // 登录成功，将响应头里的 set-cookie 写入 session
      await persistBilibiliCookies(result.headers);
    }
  }
  return result;
});

ipcMain.handle('get-user-info', async () => {
  await bilibiliAPI.refreshCookiesFromSession();
  return bilibiliAPI.getUserNavInfo();
});

ipcMain.handle('get-bilibili-cookies', async () => {
  await bilibiliAPI.refreshCookiesFromSession();
  return { code: 0, data: bilibiliAPI.cookies || {} };
});

ipcMain.handle('get-fav-folder-created-list', async (event, upMid, pn, ps) => {
  return await bilibiliAPI.getFavFolderCreatedList(upMid, pn, ps);
});

ipcMain.handle('get-fav-folder-collected-list', async (event, upMid, pn, ps) => {
  return await bilibiliAPI.getFavFolderCollectedList(upMid, pn, ps);
});

ipcMain.handle('get-fav-resource-list', async (event, mediaId, pn, ps) => {
  return await bilibiliAPI.getFavResourceList(mediaId, pn, ps);
});

ipcMain.handle('get-fav-resource-ids', async (event, mediaId) => {
  return await bilibiliAPI.getFavResourceIds(mediaId);
});

ipcMain.handle('get-fav-resource-infos', async (event, resources) => {
  return await bilibiliAPI.getFavResourceInfos(resources);
});

ipcMain.handle('logout-bilibili', async () => {
  const targetSession = bilibiliSession || (session && session.defaultSession);
  if (!targetSession) return { code: 0 };
  try {
    const cookies = await targetSession.cookies.get({ domain: '.bilibili.com' });
    for (const cookie of cookies) {
      try {
        await targetSession.cookies.remove({
          url: `https://${cookie.domain.replace(/^\./, '')}/`,
          name: cookie.name
        });
      } catch (error) {
        console.warn('删除 cookie 失败:', cookie.name, error.message);
      }
    }
    try { await targetSession.cookies.flushStore(); } catch (e) {}
    bilibiliAPI.cookies = {};
    // 清空 JSON cookie store
    try { fs.writeFileSync(COOKIE_STORE_PATH, JSON.stringify({}, null, 2), 'utf-8'); } catch (e) {}
    return { code: 0 };
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

// 计算缓存大小
ipcMain.handle('get-cache-size', async () => {
  try {
    let totalSize = 0;
    
    // 用户数据目录中的下载文件夹
    const downloadDir = path.join(app.getPath('userData'), 'downloads');
    if (fs.existsSync(downloadDir)) {
      totalSize += await calculateDirectorySize(downloadDir);
    }
    
    // Electron 的缓存目录
    const cacheDir = path.join(app.getPath('userData'), 'Cache');
    if (fs.existsSync(cacheDir)) {
      totalSize += await calculateDirectorySize(cacheDir);
    }
    
    // Session 缓存
    try {
      const cachePath = path.join(app.getPath('userData'), 'Code Cache');
      if (fs.existsSync(cachePath)) {
        totalSize += await calculateDirectorySize(cachePath);
      }
    } catch (e) {
      // 忽略错误
    }
    
    // cacheManager 管理的音频缓存（userData/cache + 旧项目目录兜底）
    try {
      const managedDir = cacheManager.getCacheDir();
      if (managedDir && fs.existsSync(managedDir)) {
        totalSize += await calculateDirectorySize(managedDir);
      }
      const legacyAudioDir = path.join(__dirname, '..', 'cache', 'audio');
      if (legacyAudioDir !== managedDir && fs.existsSync(legacyAudioDir)) {
        totalSize += await calculateDirectorySize(legacyAudioDir);
      }
    } catch (e) {
      // 忽略错误
    }
    
    return { code: 0, size: totalSize };
  } catch (error) {
    console.error('获取缓存大小失败:', error);
    return { code: -1, message: error.message };
  }
});

// 清空缓存
ipcMain.handle('clear-cache', async () => {
  try {
    // ⚠️ 重要：不清用户下载（项目硬约束）。
    // downloads/ 目录里是用户主动下载的歌曲文件，绝不删。
    // 真正该清的是：① Electron 网络/Storage 缓存 ② cacheManager 音频缓存 ③ 项目根 cache/ 目录。
    // 老的实现会把整个 downloads/ 删掉，违反"不删用户文件"约束，已废弃。

    // 1) Electron 自身缓存（HTTP 缓存、IndexedDB 等）
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData();
    } catch (e) {
      console.log('清空 session 缓存失败:', e);
    }

    // 2) cacheManager 管理的音频缓存（用户主动播放产生的中间缓存）
    try {
      cacheManager.clearAllCache();
    } catch (e) {
      console.log('清空音频缓存失败:', e);
    }

    // 3) 项目根目录下的 cache/ 目录（启动期日志、临时文件等）
    try {
      const projectCacheDir = path.join(__dirname, '..', 'cache');
      if (fs.existsSync(projectCacheDir)) {
        fs.rmSync(projectCacheDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.log('清空项目缓存目录失败:', e);
    }

    return { code: 0 };
  } catch (error) {
    console.error('清空缓存失败:', error);
    return { code: -1, message: error.message };
  }
});

// 选择下载目录
ipcMain.handle('select-download-directory', async () => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择下载目录'
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return { code: 0, path: result.filePaths[0] };
    }
    return { code: 1, message: '未选择目录' };
  } catch (error) {
    console.error('选择目录失败:', error);
    return { code: -1, message: error.message };
  }
});

/**
 * 通用确认弹窗（解决 window.confirm 在 Electron 默认配置下被屏蔽的问题）
 * 入参：{ type, title, message, detail, buttons, defaultId, cancelId }
 * 返回：{ response: number } 用户点的是哪个按钮的下标
 */
ipcMain.handle('dialog-message-box', async (event, options) => {
  try {
    const opts = {
      type: options.type || 'question',
      title: options.title || '提示',
      message: options.message || '',
      detail: options.detail || '',
      buttons: options.buttons || ['确定', '取消'],
      defaultId: options.defaultId ?? 0,
      cancelId: options.cancelId ?? 1,
      noLink: true
    };
    const result = await dialog.showMessageBox(mainWindow, opts);
    return { response: result.response };
  } catch (error) {
    console.error('弹窗失败:', error);
    // 主进程弹窗失败时回退 false，避免误删
    return { response: 1 };
  }
});

// 获取当前下载目录（内存态）
ipcMain.handle('get-download-directory', async () => {
  try {
    // 确保目录存在
    if (!fs.existsSync(currentDownloadDir)) {
      try { fs.mkdirSync(currentDownloadDir, { recursive: true }) } catch (_) {}
    }
    return { code: 0, path: currentDownloadDir };
  } catch (error) {
    console.error('获取下载目录失败:', error);
    return { code: -1, message: error.message };
  }
});

// 保存下载目录（内存态 + 主动推送）
ipcMain.handle('set-download-directory', async (event, dirPath) => {
  try {
    if (!dirPath || typeof dirPath !== 'string') {
      return { code: -400, message: 'dirPath 必填' };
    }
    // 确保目录存在
    if (!fs.existsSync(dirPath)) {
      try { fs.mkdirSync(dirPath, { recursive: true }); } catch (e) {
        return { code: -1, message: '目录创建失败: ' + e.message };
      }
    }
    currentDownloadDir = dirPath;
    // 主动推送，让所有窗口 / 视图立即同步
    broadcastDownloadDir();
    return { code: 0, path: currentDownloadDir };
  } catch (error) {
    console.error('保存下载目录失败:', error);
    return { code: -1, message: error.message };
  }
});

// 下载任务管理
ipcMain.handle('download-audio', async (event, taskInfo) => {
  try {
    const { audioUrl, fileName, bvid, cid, title, author, quality, audioCodecs, id: providedId } = taskInfo || {};
    if (!audioUrl || !fileName) {
      return { code: -1, message: '缺少下载参数' };
    }

    // 优先使用渲染层传过来的 id，保证主进程 task 与前端 store 的 waitingTask
    // 是同一条；前端 progress 回调就能用 id 匹配到，避免重复新增任务
    const id = providedId || `dl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const safeFileName = fileName.replace(/[<>"/\\|?*]/g, '').substring(0, 100);
    const downloadDir = currentDownloadDir;

    // B 站 DASH 音频流（dash.audio / dash.flac / dash.dolby）返回的字节流
    // 本质都是 fragmented MP4（ftypisom 开头），无论内部 codec 是 AAC / FLAC / EC-3，
    // 都不能直接写成 .flac / .mp3，否则播放器会因魔数不匹配而拒绝。
    // 统一用 .m4a 保存，原始编码通过 ftyp/mdat box 完整保留，绝大多数现代播放器
    // （macOS AVFoundation、VLC、ffmpeg-based、QuickTime）都能正常解码。
    // 如需真正的原生 .flac 容器，可安装 ffmpeg 后自行 `ffmpeg -i song.m4a -c:a copy song.flac`。
    const codecsLower = String(audioCodecs || '').toLowerCase();
    let ext = '.m4a';
    if (codecsLower.includes('mp3')) ext = '.mp3';

    const filePath = path.join(downloadDir, `${safeFileName}${ext}`);

    const task = {
      id,
      title: title || fileName,
      author: author || '',
      bvid: bvid || '',
      cid: cid || '',
      quality: quality || 'auto',
      audioCodecs: audioCodecs || '',
      fileName: `${safeFileName}${ext}`,
      filePath,
      status: 'downloading',
      progress: 0,
      totalBytes: 0,
      downloadedBytes: 0,
      createdTime: Date.now(),
      error: ''
    };

    // 已存在同 id 任务时，先移除再插入到队首，避免重复
    const existingIdx = downloadTasks.findIndex(t => t.id === id);
    if (existingIdx > -1) {
      downloadTasks.splice(existingIdx, 1);
    }
    downloadTasks.unshift(task);
    const notifyProgress = createDownloadProgressThrottler(task);
    notifyProgress(true);
    dlog('开始下载任务:', task.id, fileName);

    // 流式写盘：不再把整首音频读进内存再 base64/arraybuffer IPC
    const response = await bilibiliAPI.axios({
      method: 'get',
      url: audioUrl,
      responseType: 'stream',
      headers: {
        'Referer': 'https://www.bilibili.com',
        'User-Agent': UserAgent
      },
      timeout: 120000
    });

    const contentLength = parseInt(
      response.headers['content-length'] || response.headers['Content-Length'] || '0',
      10
    );
    task.totalBytes = contentLength || 0;

    await new Promise((resolve, reject) => {
      try {
        if (!fs.existsSync(downloadDir)) {
          fs.mkdirSync(downloadDir, { recursive: true });
        }
      } catch (e) {
        reject(e);
        return;
      }
      const writeStream = fs.createWriteStream(filePath);
      let downloadedBytes = 0;

      response.data.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        task.downloadedBytes = downloadedBytes;
        if (task.totalBytes > 0) {
          task.progress = Math.min(100, Math.round((downloadedBytes / task.totalBytes) * 100));
        }
        notifyProgress(false);
      });

      response.data.on('error', (err) => {
        try { writeStream.destroy(); } catch (_) {}
        reject(err);
      });
      writeStream.on('error', (err) => {
        try { response.data.destroy(); } catch (_) {}
        reject(err);
      });
      writeStream.on('finish', () => resolve());
      response.data.pipe(writeStream);
    });

    task.status = 'completed';
    task.progress = 100;
    task.totalBytes = task.totalBytes || task.downloadedBytes;
    task.downloadedBytes = task.downloadedBytes || task.totalBytes;
    notifyProgress(true);
    dlog('音频下载完成:', filePath);

    return { code: 0, data: { filePath, taskId: id } };
  } catch (error) {
    console.error('下载音频失败:', error);
    // 错误时仅把当前调用方传进来的 id 标记为失败，避免误改其它正在下载的任务
    const { id: failedId } = taskInfo || {};
    const failedTask = failedId
      ? downloadTasks.find(t => t.id === failedId)
      : downloadTasks.find(t => t.status === 'downloading');
    if (failedTask) {
      failedTask.status = 'error';
      failedTask.error = error.message;
      failedTask.progress = 0;
      broadcastDownloadProgress(failedTask);
    }
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-download-tasks', async () => {
  return { code: 0, data: downloadTasks };
});

ipcMain.handle('clear-download-tasks', async () => {
  downloadTasks.length = 0;
  return { code: 0 };
});

// 更新打开下载目录函数（内存态）
ipcMain.handle('open-download-folder', async () => {
  try {
    // 确保下载目录存在
    if (!fs.existsSync(currentDownloadDir)) {
      try { fs.mkdirSync(currentDownloadDir, { recursive: true }) } catch (_) {}
    }
    await shell.openPath(currentDownloadDir);
    return { code: 0, message: '成功打开下载目录' };
  } catch (error) {
    console.error('打开下载目录失败:', error);
    return { code: -1, message: error.message };
  }
});

// 打开 GitHub 链接
ipcMain.handle('open-github', async () => {
  try {
    await shell.openExternal('https://github.com/Rayson-Liu/pink-music-app');
    return { code: 0 };
  } catch (error) {
    console.error('打开 GitHub 失败:', error);
    return { code: -1, message: error.message };
  }
});

// 当前应用版本（读取打包后的 package.json version）
ipcMain.handle('get-app-version', () => app.getVersion());

// 检查版本更新（走 GitHub releases/latest，带 TTL 缓存）
ipcMain.handle('check-for-update', async (_event, opts) => {
  try {
    return await updateChecker.checkForUpdates(opts || {});
  } catch (error) {
    console.error('检查更新失败:', error);
    return { code: -1, error: 'unknown', message: error.message };
  }
});

// 打开外部链接（白名单：仅 https 且域名为 github.com / *.github.com）
ipcMain.handle('open-external-url', async (_event, url) => {
  try {
    const u = new URL(String(url || ''));
    const isGithub = u.hostname === 'github.com' || u.hostname.endsWith('.github.com');
    if (u.protocol !== 'https:' || !isGithub) {
      return { code: -1, message: '仅允许打开 GitHub 链接' };
    }
    await shell.openExternal(url);
    return { code: 0 };
  } catch (error) {
    console.error('打开外部链接失败:', error);
    return { code: -1, message: error.message };
  }
});

// 窗口控制
ipcMain.handle('minimize-window', () => {
  const window = BrowserWindow.getFocusedWindow();
  if (window) {
    window.minimize();
  }
  return { code: 0 };
});

ipcMain.handle('maximize-window', () => {
  const window = BrowserWindow.getFocusedWindow();
  if (window) {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  }
  return { code: 0 };
});

ipcMain.handle('close-window', () => {
  const window = BrowserWindow.getFocusedWindow();
  if (window) {
    window.close();
  }
  return { code: 0 };
});

ipcMain.handle('is-window-maximized', () => {
  const window = BrowserWindow.getFocusedWindow();
  if (window) {
    return { code: 0, isMaximized: window.isMaximized() };
  }
  return { code: 0, isMaximized: false };
});

// 窗口透明度控制
ipcMain.handle('set-window-opacity', (event, opacity) => {
  const window = mainWindow || BrowserWindow.getFocusedWindow();
  if (window && !window.isDestroyed()) {
    const safeOpacity = Math.max(0.1, Math.min(1.0, Number(opacity) || 1.0));
    window.setOpacity(safeOpacity);
  }
  return { code: 0 };
});

// Discord Rich Presence 控制
ipcMain.handle('discord-update-activity', (event, activity) => {
  discordRpcManager.setActivity(activity);
  return { code: 0 };
});

ipcMain.handle('discord-clear-activity', () => {
  discordRpcManager.clearActivity();
  return { code: 0 };
});

ipcMain.handle('discord-set-enabled', (event, enabled) => {
  discordRpcManager.setEnabled(enabled);
  return { code: 0 };
});

ipcMain.handle('discord-get-status', () => {
  return { code: 0, data: discordRpcManager.getStatus() };
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

// 辅助函数: 计算目录大小
async function calculateDirectorySize(dirPath) {
  let totalSize = 0;
  
  async function scanDirectory(currentPath) {
    const files = fs.readdirSync(currentPath);
    for (const file of files) {
      const filePath = path.join(currentPath, file);
      const stats = fs.statSync(filePath);
      
      if (stats.isDirectory()) {
        await scanDirectory(filePath);
      } else {
        totalSize += stats.size;
      }
    }
  }
  
  try {
    await scanDirectory(dirPath);
  } catch (e) {
    console.error('扫描目录失败:', e);
  }
  
  return totalSize;
}

// ==================== 歌词功能 ====================

const NETEASE_BASE_URL = 'https://music.163.com';

function createNeteaseSignature(params) {
  const modulus = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
  const publicKey = '010001';
  const secret = '0CoJUm6Qyw8W8jud';

  function aesEncrypt(text, key) {
    const iv = '0102030405060708';
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    return encrypted;
  }

  function rsaEncrypt(text) {
    const buffer = Buffer.from(text, 'utf8');
    const encrypted = crypto.publicEncrypt({
      key: `-----BEGIN PUBLIC KEY-----\n${publicKey}\n-----END PUBLIC KEY-----`,
      padding: crypto.constants.RSA_PKCS1_PADDING,
    }, buffer);
    return encrypted.toString('base64');
  }

  const jsonText = JSON.stringify(params);
  const randomKey = crypto.randomBytes(16).toString('hex');
  
  const encryptedParams = aesEncrypt(aesEncrypt(jsonText, secret), randomKey);
  const encSecKey = rsaEncrypt(randomKey.split('').reverse().join(''));

  return { params: encryptedParams, encSecKey };
}

// 使用网易云直接搜索API
async function searchNeteaseMusic(keyword) {
  try {
    console.log('使用网易云直接搜索API:', keyword);
    
    const url = `https://music.163.com/api/search/get?s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=10`;
    
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
        'Referer': 'https://music.163.com/',
        'Accept': 'application/json, text/plain, */*',
      },
      timeout: 10000,
    });

    console.log('搜索API状态码:', response.status);
    console.log('搜索结果code:', response.data?.code);

    if (response.data?.code === 200 && response.data?.result?.songs) {
      const songs = response.data.result.songs;
      console.log('找到歌曲数量:', songs.length);
      return songs.map((song) => ({
        id: song.id,
        name: song.name,
        artist: song.artists?.[0]?.name || song.ar?.[0]?.name || '',
        album: song.album?.name || song.al?.name || '',
        // 网易云返回的 duration 单位是毫秒
        duration: typeof song.duration === 'number' ? song.duration : 0
      }));
    }
    return [];
  } catch (error) {
    console.error('搜索网易云音乐失败:', error.message);
    return [];
  }
}

// 使用简单的未加密API获取歌词
async function getNeteaseLyric(songId) {
  try {
    console.log('使用简单API获取歌词, songId:', songId);

    const [lvRes, rvRes, tvRes] = await Promise.all([
      axios.get(`https://music.163.com/api/song/lyric?id=${songId}&lv=-1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
          'Referer': 'https://music.163.com/',
        },
      }),
      axios.get(`https://music.163.com/api/song/lyric?id=${songId}&rv=-1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
          'Referer': 'https://music.163.com/',
        },
      }),
      axios.get(`https://music.163.com/api/song/lyric?id=${songId}&tv=-1`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
          'Referer': 'https://music.163.com/',
        },
      }),
    ]);

    console.log('API响应:', {
      lv: !!lvRes.data?.lrc?.lyric,
      rv: !!rvRes.data?.romalrc?.lyric,
      tv: !!tvRes.data?.tlyric?.lyric,
    });

    if (lvRes.data.code === 200 || lvRes.status === 200) {
      return {
        lrc: lvRes.data.lrc?.lyric || '',
        // 注意：罗马音字段是 romalrc（不是 rvLyric），旧代码读错字段导致罗马音一直为空
        rv: rvRes.data?.romalrc?.lyric || '',
        tv: tvRes.data?.tlyric?.lyric || '',
        title: lvRes.data?.lrc?.writer || '',
        artist: '',
      };
    }
    return null;
  } catch (error) {
    console.error('获取网易云歌词失败:', error);
    return null;
  }
}

// 清洗搜索关键词：去掉 B 站标题常见的装饰符号，降低歌词源误匹配概率
function cleanLyricKeyword(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[【】\[\]（）()《》<>]/g, ' ')
    .replace(/·|♪|♫|｜|\||【|】/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function generateLyricSearchCandidates(rawTitle, rawArtist) {
  let title = String(rawTitle || '').replace(/<[^>]+>/g, '').trim();
  let artist = String(rawArtist || '').replace(/<[^>]+>/g, '').trim();

  // 1. 提取《...》中的书名号（最可靠的歌名标识）
  const bookMatches = [...title.matchAll(/《([^》]+)》/g)].map(m => m[1].trim()).filter(Boolean);

  // 2. 提取【歌手】歌名 或 【歌名】歌手
  const bracketMatches = [...title.matchAll(/【([^】]+)】/g)].map(m => m[1].trim()).filter(Boolean);

  // 3. 常见噪声标签与说明过滤
  const noiseTagRegex = /【(?:4K|1080P|720P|60帧|60FPS|超清|修复|高清|无损|纯享|高音质|官方|MV|现场|完整版|精选|合集|单曲循环|Remix|动态歌词|自制|首发|伴奏|Live|LIVE|4K60帧|1080P60帧)[^】]*】/gi;
  const noiseParenRegex = /\((?:4K|1080P|720P|60帧|60FPS|超清|修复|高清|无损|纯享|高音质|官方|MV|现场|完整版|单曲纯享|动态歌词|Live|LIVE|cover|Cover|翻唱|高码率)[^)]*\)/gi;
  const noiseSquareRegex = /\[(?:4K|1080P|720P|60帧|60FPS|超清|修复|高清|无损|纯享|Live)[^\]]*\]/gi;
  const noisePhraseRegex = /(?:这首歌的前奏一响|听一遍就爱上|百听不厌|终于找到了|太好听了|感动哭|千万别戴耳机听|建议戴耳机听)[^，！!？?~]*/g;

  let cleaned = title
    .replace(noiseTagRegex, ' ')
    .replace(noiseParenRegex, ' ')
    .replace(noiseSquareRegex, ' ')
    .replace(noisePhraseRegex, ' ');

  let stripped = cleaned
    .replace(/[【】\[\]（）()《》<>「」『』·♪♫｜|~～]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const dashMatch = stripped.match(/^([^-–—/|｜]+)\s*[-–—/|｜]\s*([^-–—/|｜]+)(?:\s*[-–—/|｜].*)?$/);

  const candidates = [];

  if (bookMatches.length > 0) {
    const bookTitle = bookMatches[0];
    if (artist) candidates.push(`${bookTitle} ${artist}`);
    for (const b of bracketMatches) {
      if (b !== bookTitle && b.length <= 15) {
        candidates.push(`${bookTitle} ${b}`);
      }
    }
    candidates.push(bookTitle);
  }

  if (dashMatch) {
    const p1 = dashMatch[1].trim();
    const p2 = dashMatch[2].trim();
    candidates.push(`${p1} ${p2}`);
    candidates.push(`${p2} ${p1}`);
    candidates.push(p2);
    candidates.push(p1);
  }

  if (bracketMatches.length > 0) {
    const b = bracketMatches[0];
    const rest = stripped.replace(b, '').trim();
    if (b && rest && b.length <= 15) {
      candidates.push(`${rest} ${b}`);
      candidates.push(`${b} ${rest}`);
    }
  }

  if (stripped) {
    if (artist && !stripped.includes(artist)) {
      candidates.push(`${stripped} ${artist}`);
    }
    candidates.push(stripped);
  }

  if (title) {
    candidates.push(title);
  }

  return [...new Set(candidates.filter(c => c && c.length >= 2))];
}

// 按歌名/歌手构造搜索关键词序列（多源共用）
function buildLyricKeywords(title, artist) {
  const cleanTitle = cleanLyricKeyword(title);
  const cleanArtist = cleanLyricKeyword(artist);
  const candidates = generateLyricSearchCandidates(title, artist);
  return { keywords: candidates, cleanTitle, cleanArtist };
}

// 从搜索结果里挑最佳匹配（原 get-lyric 的匹配逻辑，多源共用）
function pickBestMatch(allResults, cleanTitle, cleanArtist) {
  if (!allResults.length) return null

  let matchedSong = null;

  if (cleanArtist) {
    const artistMain = cleanArtist.split(/[、,，&/\\\s]+/)[0].trim();
    matchedSong = allResults.find(song =>
      (song.artist || '').toLowerCase().includes(artistMain.toLowerCase()) ||
      (song.name || '').toLowerCase() === cleanTitle.toLowerCase()
    );
  }

  // 标题相似度兜底：优先与清洗后标题更接近的结果
  if (!matchedSong && cleanTitle) {
    const t = cleanTitle.toLowerCase()
    matchedSong = allResults.find(song =>
      (song.name || '').toLowerCase().includes(t) || t.includes((song.name || '').toLowerCase())
    )
  }

  return matchedSong || allResults[0];
}

// 指定源的"搜索 → 匹配 → 取词"全流程。成功返回 { data: {lrc,rv,tv}, source }，失败返回 null
async function fetchLyricFromSource(source, keywords, cleanTitle, cleanArtist) {
  try {
    let allResults = [];
    for (const keyword of keywords) {
      const results = source === 'kugou' ? await searchKugou(keyword)
        : await searchNeteaseMusic(keyword);
      if (results.length > 0) {
        allResults = results;
        break;
      }
    }
    if (!allResults.length) return null;

    const matchedSong = pickBestMatch(allResults, cleanTitle, cleanArtist);
    dlog(`[${source}] 匹配到的歌曲:`, matchedSong?.id, matchedSong?.name, matchedSong?.artist);

    const lyricData = source === 'kugou' ? await getKugouLyric(matchedSong)
      : await getNeteaseLyric(matchedSong.id);

    if (lyricData && lyricData.lrc) {
      dlog(`[${source}] 获取到歌词，长度:`, lyricData.lrc.length);
      return { data: { lrc: lyricData.lrc, rv: lyricData.rv || '', tv: lyricData.tv || '' }, source };
    }
    return null;
  } catch (error) {
    console.error(`[${source}] 取词失败:`, error.message);
    return null;
  }
}

// 歌词源 fallback 顺序：由渲染层传下来的 preferredSource 决定（默认酷狗，未知值兜底 kugou），
// 首选源失败时自动回退到另一个源 —— 见 electron/lyricSourceOrder.js
// IPC: 获取歌词（偏好源 → 另一个源 依次尝试，返回实际来源）
ipcMain.handle('get-lyric', async (event, { bvid, cid, title, artist, preferredSource }) => {
  try {
    dlog('获取歌词:', { bvid, cid, title, artist, preferredSource });

    const { keywords, cleanTitle, cleanArtist } = buildLyricKeywords(title, artist)

    const sourceOrder = resolveLyricSourceOrder(preferredSource);
    dlog('歌词源尝试顺序:', sourceOrder.join(' → '));

    for (const source of sourceOrder) {
      const result = await fetchLyricFromSource(source, keywords, cleanTitle, cleanArtist);
      if (result) {
        return { code: 0, data: result.data, source: result.source };
      }
    }

    return {
      code: -1,
      message: '沒有歌詞'
    };
  } catch (error) {
    console.error('获取歌词失败:', error);
    return {
      code: -1,
      message: error.message
    };
  }
});

// IPC: 搜索歌词（source: netease | kugou，默认 netease）
ipcMain.handle('search-lyric', async (event, keyword, source = 'netease') => {
  try {
    console.log('搜索歌词:', keyword, '来源:', source);
    const results = source === 'kugou' ? await searchKugou(keyword)
      : await searchNeteaseMusic(keyword);
    console.log('歌词搜索结果数量:', results.length);
    if (results.length > 0) {
      console.log('第一个结果:', results[0]);
    }
    return {
      code: 0,
      data: results
    };
  } catch (error) {
    console.error('搜索歌词失败:', error);
    return {
      code: -1,
      message: error.message
    };
  }
});

// IPC: 通过歌曲ID获取歌词。
// song 可以是：
//   - 字符串（网易云 songId，向后兼容旧调用）
//   - 对象 { source, id, hash?, ... }（手动搜索结果项，kugou 需要额外字段）
ipcMain.handle('get-lyric-by-id', async (event, song) => {
  try {
    const source = typeof song === 'object' && song?.source ? song.source : 'netease';
    const songId = typeof song === 'object' ? song.id : song;
    console.log('获取歌词:', source, songId);

    const lyricData = source === 'kugou' ? await getKugouLyric(song)
      : await getNeteaseLyric(songId);

    if (lyricData && lyricData.lrc) {
      return {
        code: 0,
        data: {
          lrc: lyricData.lrc,
          rv: lyricData.rv || '',
          tv: lyricData.tv || ''
        }
      };
    }

    return {
      code: -1,
      message: '沒有歌詞'
    };
  } catch (error) {
    console.error('获取歌词失败:', error);
    return {
      code: -1,
      message: error.message
    };
  }
});
