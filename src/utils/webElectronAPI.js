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

/**
 * Web 环境下的 electronAPI 适配器
 * 当在普通浏览器（localhost）运行而没有 Electron preload 注入时生效。
 * 通过 Vite 开发服务器的 /api、/passport、/netease-api 和 /proxy-audio 反向代理与 B 站及歌词服务通信。
 */

function getStoredCookies() {
  try {
    const raw = localStorage.getItem('bilibili_cookies');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  try {
    const raw = localStorage.getItem('bilibili-login-cookie');
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return {};
}

function saveStoredCookies(cookies) {
  if (!cookies || typeof cookies !== 'object') return;
  const current = getStoredCookies();
  const merged = { ...current, ...cookies };
  try {
    localStorage.setItem('bilibili_cookies', JSON.stringify(merged));
    localStorage.setItem('bilibili-login-cookie', JSON.stringify(merged));
    localStorage.setItem('app-data-login', JSON.stringify(merged));
  } catch (e) {
    console.warn('[webElectronAPI] 保存 cookie 失败:', e);
  }
}

function clearStoredCookies() {
  try {
    localStorage.removeItem('bilibili_cookies');
    localStorage.removeItem('bilibili-login-cookie');
    localStorage.removeItem('app-data-login');
  } catch (_) {}
}

function getCookieHeader() {
  const cookies = getStoredCookies();
  return Object.entries(cookies)
    .filter(([_, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function parseCookiesFromUrl(targetUrl) {
  if (!targetUrl) return {};
  try {
    const u = new URL(targetUrl);
    const cookies = {};
    for (const [key, val] of u.searchParams.entries()) {
      if (['DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA', 'bili_jct'].includes(key)) {
        cookies[key] = val;
      }
    }
    return cookies;
  } catch (e) {
    return {};
  }
}

function proxyAudioUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (url.startsWith('/proxy-audio') || url.startsWith('blob:') || url.startsWith('data:')) {
    return url;
  }
  return `/proxy-audio?url=${encodeURIComponent(url)}`;
}

function transformPlayUrlData(data) {
  if (!data) return data;
  const cloned = JSON.parse(JSON.stringify(data));
  if (cloned.dash) {
    if (Array.isArray(cloned.dash.audio)) {
      cloned.dash.audio.forEach((item) => {
        if (item.baseUrl) item.baseUrl = proxyAudioUrl(item.baseUrl);
        if (item.base_url) item.base_url = proxyAudioUrl(item.base_url);
        if (Array.isArray(item.backupUrl)) {
          item.backupUrl = item.backupUrl.map(proxyAudioUrl);
        }
        if (Array.isArray(item.backup_url)) {
          item.backup_url = item.backup_url.map(proxyAudioUrl);
        }
      });
    }
    if (cloned.dash.flac?.audio) {
      const flac = cloned.dash.flac.audio;
      if (flac.baseUrl) flac.baseUrl = proxyAudioUrl(flac.baseUrl);
      if (flac.base_url) flac.base_url = proxyAudioUrl(flac.base_url);
    }
    if (Array.isArray(cloned.dash.dolby?.audio)) {
      cloned.dash.dolby.audio.forEach((item) => {
        if (item.baseUrl) item.baseUrl = proxyAudioUrl(item.baseUrl);
        if (item.base_url) item.base_url = proxyAudioUrl(item.base_url);
      });
    }
  }
  if (Array.isArray(cloned.durl)) {
    cloned.durl.forEach((item) => {
      if (item.url) item.url = proxyAudioUrl(item.url);
    });
  }
  return cloned;
}

async function requestApi(path, options = {}) {
  const headers = {
    Accept: 'application/json, text/plain, */*',
    ...(options.headers || {})
  };
  const cookieHeader = getCookieHeader();
  if (cookieHeader) {
    headers['X-Bilibili-Cookie'] = cookieHeader;
  }
  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return await res.json();
}

export function setupWebElectronAPI() {
  if (typeof window === 'undefined' || window.electronAPI) return;

  console.info('[Web Mode] 未检测到 Electron 环境，已初始化 Web 模式 electronAPI 适配器。');

  window.electronAPI = {
    isWeb: true,

    // 搜索音乐
    async searchMusic(keyword, page = 1, pageSize = 20) {
      try {
        const url = `/api/x/web-interface/search/all/v2?keyword=${encodeURIComponent(keyword)}&page=${page}&page_size=${pageSize}`;
        return await requestApi(url);
      } catch (err) {
        console.error('[Web] searchMusic 失败:', err);
        return { code: -1, message: err.message };
      }
    },

    // 音乐区推荐
    async getMusicRegionFeed(displayId = 1, requestCnt = 15) {
      try {
        const url = `/api/x/web-interface/region/feed/rcmd?display_id=${displayId}&request_cnt=${requestCnt}&from_region=1003&device=web&plat=30&web_location=333.40138`;
        return await requestApi(url);
      } catch (err) {
        console.error('[Web] getMusicRegionFeed 失败:', err);
        return { code: -1, message: err.message, data: { archives: [] } };
      }
    },

    // 音乐综合排行
    async getMusicComprehensiveWebRank(pn = 1, ps = 20) {
      try {
        const url = `/api/x/centralization/interface/music/comprehensive/web/rank?pn=${pn}&ps=${ps}&web_location=333.1351`;
        return await requestApi(url);
      } catch (err) {
        console.error('[Web] getMusicComprehensiveWebRank 失败:', err);
        return { code: -1, message: err.message, data: { list: [] } };
      }
    },

    // 视频信息
    async getMusicInfo(bvid) {
      try {
        const url = `/api/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
        return await requestApi(url);
      } catch (err) {
        console.error('[Web] getMusicInfo 失败:', err);
        return { code: -1, message: err.message };
      }
    },

    // 视频播放流地址（音频流转代理地址）
    async getMusicPlayUrl(bvid, cid) {
      try {
        const url = `/api/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}&qn=0&fnval=4048&fnver=0&fourk=1`;
        const res = await requestApi(url);
        if (res && res.code === 0 && res.data) {
          res.data = transformPlayUrlData(res.data);
        }
        return res;
      } catch (err) {
        console.error('[Web] getMusicPlayUrl 失败:', err);
        return { code: -1, message: err.message };
      }
    },

    // 分 P 列表
    async getVideoEpisodes(bvid) {
      try {
        const url = `/api/x/player/pagelist?bvid=${encodeURIComponent(bvid)}`;
        return await requestApi(url);
      } catch (err) {
        console.error('[Web] getVideoEpisodes 失败:', err);
        return { code: -1, message: err.message };
      }
    },

    // 音频代理
    async proxyAudio(audioUrl) {
      return { code: 0, data: proxyAudioUrl(audioUrl) };
    },

    // 推荐
    async getRecommendations() {
      try {
        return await requestApi('/api/x/web-interface/index/top/rcmd');
      } catch (err) {
        return { code: -1, message: err.message };
      }
    },

    // 视频合集
    async getVideoSeries(bvid) {
      try {
        return await requestApi(`/api/x/series/series?bvid=${encodeURIComponent(bvid)}`);
      } catch (err) {
        return { code: -1, message: err.message };
      }
    },

    // 下载相关（Web 降级为提示）
    async downloadAudio(taskInfo) {
      console.warn('[Web] 网页端不支持本地下载');
      return { code: -1, message: 'Web 模式不支持本地下载文件' };
    },
    async getDownloadTasks() {
      return [];
    },
    async clearDownloadTasks() {
      return { code: 0 };
    },
    onDownloadProgress(callback) {
      return () => {};
    },
    async openDownloadFolder() {
      alert('Web 模式不支持打开系统下载目录');
      return { code: 0 };
    },

    // 设置与缓存
    async getCacheSize() {
      return { code: 0, size: '0 MB' };
    },
    async clearCache() {
      localStorage.clear();
      return { code: 0 };
    },
    async selectDownloadDirectory() {
      return null;
    },
    async getDownloadDirectory() {
      return '';
    },
    async setDownloadDirectory() {
      return { code: 0 };
    },
    async openGitHub() {
      window.open('https://github.com/LittleCatAlex/pink-music-app', '_blank');
      return { code: 0 };
    },

    // 版本检查
    async getAppVersion() {
      return '2.6.3';
    },
    async checkForUpdate() {
      return { hasUpdate: false };
    },
    async openExternalUrl(url) {
      window.open(url, '_blank');
      return { code: 0 };
    },

    // 窗口控制
    async minimizeWindow() {},
    async maximizeWindow() {},
    async closeWindow() {},
    async isWindowMaximized() {
      return false;
    },
    async getPlatform() {
      return 'web';
    },

    // 持久化存储
    appData: {
      async get(key) {
        try {
          const raw = localStorage.getItem(`app-data-${key}`);
          return raw ? JSON.parse(raw) : null;
        } catch (_) {
          return null;
        }
      },
      async set(key, value) {
        try {
          localStorage.setItem(`app-data-${key}`, JSON.stringify(value));
          return true;
        } catch (_) {
          return false;
        }
      },
      async remove(key) {
        try {
          localStorage.removeItem(`app-data-${key}`);
          return true;
        } catch (_) {
          return false;
        }
      }
    },

    onFlushRequired(callback) {
      return () => {};
    },
    notifyFlushDone() {},
    onDownloadDirChanged(callback) {
      return () => {};
    },

    // 歌词相关（通过 /netease-api 代理）
    async searchLyric(keyword, source = 'netease') {
      try {
        const cleanKw = String(keyword || '').replace(/[【】\[\]《》]/g, ' ').replace(/\s+/g, ' ').trim();
        const url = `/netease-api/api/search/get?s=${encodeURIComponent(cleanKw)}&type=1&offset=0&limit=10`;
        const res = await fetch(url).then(r => r.json());
        if (res.code === 200 && res.result?.songs) {
          const songs = res.result.songs.map((song) => ({
            id: song.id,
            name: song.name,
            artist: song.artists?.[0]?.name || song.ar?.[0]?.name || '',
            album: song.album?.name || song.al?.name || '',
            duration: song.duration || 0,
            source: 'netease'
          }));
          return { code: 0, data: songs };
        }
        return { code: 0, data: [] };
      } catch (err) {
        console.error('[Web] searchLyric 失败:', err);
        return { code: -1, message: '沒有歌詞', data: [] };
      }
    },

    async getLyricById(song) {
      try {
        const songId = typeof song === 'object' ? song.id : song;
        const res = await fetch(`/netease-api/api/song/lyric?id=${songId}&lv=-1&kv=-1&tv=-1&rv=-1`).then(r => r.json()).catch(() => null);
        const lrc = res?.lrc?.lyric || '';
        if (!lrc || res?.uncollected || res?.nolyric || lrc.includes('暂无歌词') || lrc.includes('纯音乐，无歌词') || lrc.includes('纯音乐，请欣赏')) {
          return { code: -1, message: '沒有歌詞' };
        }
        return {
          code: 0,
          data: {
            lrc: lrc,
            tv: res?.tlyric?.lyric || '',
            rv: res?.romalrc?.lyric || ''
          }
        };
      } catch (err) {
        console.error('[Web] getLyricById 失败:', err);
        return { code: -1, message: '沒有歌詞' };
      }
    },

    async getLyric({ title, artist }) {
      try {
        const candidates = generateLyricSearchCandidates(title, artist);
        for (const candidate of candidates) {
          const searchRes = await this.searchLyric(candidate);
          if (searchRes.code === 0 && Array.isArray(searchRes.data) && searchRes.data.length > 0) {
            for (const song of searchRes.data.slice(0, 3)) {
              const lyricRes = await this.getLyricById(song);
              if (lyricRes.code === 0 && lyricRes.data?.lrc) {
                return lyricRes;
              }
            }
          }
        }
        return { code: -1, message: '沒有歌詞' };
      } catch (err) {
        return { code: -1, message: '沒有歌詞' };
      }
    },

    // 登录与二维码
    async generateQrcode() {
      try {
        const res = await requestApi('/passport/x/passport-login/web/qrcode/generate');
        return res;
      } catch (err) {
        console.error('[Web] generateQrcode 失败:', err);
        return { code: -1, message: err.message };
      }
    },

    async pollQrcode(qrcodeKey) {
      try {
        const res = await requestApi(`/passport/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`);
        if (res && res.code === 0 && res.data) {
          if (res.data.code === 0 && res.data.url) {
            const cookies = parseCookiesFromUrl(res.data.url);
            saveStoredCookies(cookies);
          }
        }
        return { code: 0, data: res };
      } catch (err) {
        console.error('[Web] pollQrcode 失败:', err);
        return { code: -1, message: err.message };
      }
    },

    async getUserInfo() {
      try {
        return await requestApi('/api/x/web-interface/nav');
      } catch (err) {
        console.error('[Web] getUserInfo 失败:', err);
        return { code: -1, message: err.message };
      }
    },

    async getBilibiliCookies() {
      return { code: 0, data: getStoredCookies() };
    },

    async logoutBilibili() {
      clearStoredCookies();
      return { code: 0 };
    },

    // 收藏夹
    async getFavFolderCreatedList(upMid, pn = 1, ps = 50) {
      try {
        const url = `/api/x/v3/fav/folder/created/list?up_mid=${encodeURIComponent(upMid)}&pn=${pn}&ps=${ps}&web_location=333.1387`;
        return await requestApi(url);
      } catch (err) {
        return { code: -1, message: err.message };
      }
    },

    async getFavFolderCollectedList(upMid, pn = 1, ps = 50) {
      try {
        const url = `/api/x/v3/fav/folder/collected/list?up_mid=${encodeURIComponent(upMid)}&pn=${pn}&ps=${ps}&platform=web`;
        return await requestApi(url);
      } catch (err) {
        return { code: -1, message: err.message };
      }
    },

    async getFavResourceList(mediaId, pn = 1, ps = 20) {
      try {
        const safePs = Math.max(1, Math.min(20, Number(ps) || 20));
        const safePn = Math.max(1, Number(pn) || 1);
        const url = `/api/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=${safePn}&ps=${safePs}&tid=0&type=0&platform=web&order=mtime`;
        return await requestApi(url);
      } catch (err) {
        return { code: -1, message: err.message };
      }
    },

    async getFavResourceIds(mediaId) {
      try {
        return await requestApi(`/api/x/v3/fav/resource/ids?media_id=${encodeURIComponent(mediaId)}&platform=web`);
      } catch (err) {
        return { code: -1, message: err.message };
      }
    },

    async getFavResourceInfos(resources) {
      return { code: 0, data: { list: [] } };
    },

    async showMessageBox(options) {
      const ok = window.confirm(options.message || options.title || '确认操作？');
      return { response: ok ? 0 : 1 };
    },

    async setWindowOpacity(opacity) {
      return { code: 0 };
    },

    discord: {
      async updateActivity(activity) {
        // Web 模式无本地 Discord IPC
        return { code: 0 };
      },
      async clearActivity() {
        return { code: 0 };
      },
      async setEnabled(enabled) {
        return { code: 0 };
      },
      async getStatus() {
        return { code: 0, data: { enabled: true, connected: false } };
      }
    },

    // 本地音乐库降级占位
    local: {
      async importFiles() {
        alert('Web 模式不支持直接导入本地音乐文件，请在 Electron 客户端中使用');
        return { code: 0, data: [] };
      },
      async importFolder() {
        alert('Web 模式不支持直接导入本地文件夹，请在 Electron 客户端中使用');
        return { code: 0, data: [] };
      },
      async scanPaths() {
        return [];
      },
      async parseMetadata() {
        return [];
      },
      async checkFiles() {
        return [];
      },
      async readLrc() {
        return null;
      },
      async findLrc() {
        return null;
      },
      async saveCover() {
        return '';
      },
      async revealFile() {},
      async relocateFile() {
        return null;
      },
      onParseProgress() {
        return () => {};
      }
    }
  };
}
