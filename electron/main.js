const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const axios = require('axios');
const httpCookie = require('cookie');

const BILIBILI_BASE = 'https://api.bilibili.com';
const BILIBILI_WEB = 'https://passport.bilibili.com';

const UserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

class BilibiliAPI {
  constructor() {
    this.cookies = {};
    this.axios = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent': UserAgent,
        'Referer': 'https://www.bilibili.com/',
        'Origin': 'https://www.bilibili.com',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
  }

  setCookies(cookies) {
    this.cookies = cookies;
    console.log('Cookies已设置:', cookies);
  }

  async request(url, options = {}) {
    // 如果 this.cookies 为空，尝试从 Electron session 读取
    let cookies = this.cookies;
    if (!cookies || Object.keys(cookies).length === 0) {
      try {
        const sessionCookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' });
        if (sessionCookies && sessionCookies.length > 0) {
          cookies = {};
          sessionCookies.forEach(c => {
            cookies[c.name] = c.value;
          });
        }
      } catch (error) {
        console.error('从 session 读取 cookies 失败:', error);
      }
    }

    const headers = {
      ...options.headers,
      Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    };

    try {
      const response = await this.axios({
        url,
        headers,
        ...options
      });
      return response.data;
    } catch (error) {
      console.error('API请求失败:', error.message);
      throw error;
    }
  }

  async getLoginQRCode() {
    const data = await this.request(`${BILIBILI_WEB}/x/passport-login/web/qrcode/generate`);
    return data;
  }

  async checkLoginStatus(qrcodeKey) {
    const data = await this.request(`${BILIBILI_WEB}/x/passport-login/web/qrcode/poll`, {
      params: { qrcode_key: qrcodeKey }
    });
    return data;
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

  async getMusicInfo(bvid) {
    try {
      console.log('获取音乐信息:', bvid);
      const data = await this.request(`${BILIBILI_BASE}/x/web-interface/view`, {
        params: { bvid }
      });
      console.log('音乐信息结果:', JSON.stringify(data, null, 2));
      return data;
    } catch (error) {
      console.error('获取音乐信息失败:', error);
      return { code: -1, message: error.message };
    }
  }

  async getMusicPlayUrl(bvid, cid) {
    try {
      console.log('获取播放地址:', bvid, cid);
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
      console.log('播放地址结果:', JSON.stringify(data, null, 2));
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

  async getFavorites(cookie) {
    try {
      const cookies = cookie || this.cookies;
      const mid = cookies.DedeUserID;
      if (!mid) {
        return { code: -1, message: '用户未登录' };
      }
      const headers = {
        'Referer': 'https://www.bilibili.com',
        'User-Agent': UserAgent
      };

      const response = await this.axios.get(`${BILIBILI_BASE}/x/v3/fav/folder/created/list-all`, {
        params: {
          mid: mid,
          platform: 'web',
          jsonp: 'jsonp'
        },
        headers: {
          ...headers,
          Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
        }
      });
      return response.data;
    } catch (error) {
      console.error('获取收藏夹失败:', error.message);
      return { code: -1, message: error.message };
    }
  }

  async getFavoriteMedia(folderId, page = 1) {
    try {
      const headers = {
        'Referer': 'https://www.bilibili.com',
        'User-Agent': UserAgent
      };

      const response = await this.axios.get(`${BILIBILI_BASE}/x/v3/fav/resource/list`, {
        params: {
          media_id: folderId,
          pn: page,
          ps: 20,
          platform: 'web',
          order: 'mtime',
          type: 0,
          tid: 0
        },
        headers: {
          ...headers,
          Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ')
        }
      });
      return response.data;
    } catch (error) {
      console.error('获取收藏夹内容失败:', error.message);
      return { code: -1, message: error.message };
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

function installWebRequestInterceptors() {
  const urls = ["http://*/*", "https://*/*"];
  const origin = "https://www.bilibili.com";
  const referer = "https://www.bilibili.com";

  const onBeforeSendHeadersHandler = async (details, callback) => {
    const headers = details.requestHeaders || {};

    headers["Referer"] = referer;
    headers["Origin"] = origin;
    headers["User-Agent"] = UserAgent;

    // 从 Electron session 读取 cookies 并添加到请求头
    try {
      const sessionCookies = await session.defaultSession.cookies.get({ domain: '.bilibili.com' });
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
      const setCookieObject = httpCookie.parseSetCookie(cookie);
      setCookieObject.sameSite = "none";
      setCookieObject.secure = true;

      return httpCookie.stringifySetCookie(setCookieObject);
    });

    responseHeaders[setCookieKey] = rewritten;
    callback({ responseHeaders });
  };

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls }, onBeforeSendHeadersHandler);
  session.defaultSession.webRequest.onHeadersReceived({ urls }, onHeadersReceivedHandler);
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      webSecurity: false
    }
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173/');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

app.whenReady().then(() => {
  installWebRequestInterceptors();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('get-login-qrcode', async () => {
  try {
    const result = await bilibiliAPI.getLoginQRCode();
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('check-login-status', async (event, qrcodeKey) => {
  try {
    const result = await bilibiliAPI.checkLoginStatus(qrcodeKey);
    console.log('登录状态检查结果:', JSON.stringify(result));
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('set-cookies', (event, cookies) => {
  bilibiliAPI.setCookies(cookies);
  return { code: 0, message: 'OK' };
});

ipcMain.handle('get-cookie', async (event, key) => {
  try {
    const cookies = await session.defaultSession.cookies.get({ key, domain: '.bilibili.com' });
    return cookies?.[0]?.value || '';
  } catch (error) {
    console.error('获取 Cookie 失败:', error);
    return '';
  }
});

ipcMain.handle('set-cookie', async (event, { name, value, expirationDate }) => {
  try {
    await session.defaultSession.cookies.set({
      url: 'https://bilibili.com/',
      domain: '.bilibili.com',
      path: '/',
      name,
      value,
      secure: true,
      sameSite: 'no_restriction',
      httpOnly: false,
      expirationDate
    });
    await session.defaultSession.cookies.flushStore();
    return { code: 0, message: 'OK' };
  } catch (error) {
    console.error('设置 Cookie 失败:', error);
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('search-music', async (event, keyword, page, pageSize) => {
  try {
    const result = await bilibiliAPI.searchMusic(keyword, page, pageSize);
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
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

ipcMain.handle('proxy-audio', async (event, audioUrl) => {
  try {
    console.log('收到音频代理请求:', audioUrl);
    const buffer = await bilibiliAPI.getAudioProxy(audioUrl);
    return { code: 0, data: buffer.toString('base64') };
  } catch (error) {
    console.error('代理音频失败:', error);
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-favorites', async (event) => {
  try {
    const result = await bilibiliAPI.getFavorites();
    console.log('获取收藏夹结果:', JSON.stringify(result)?.substring(0, 500));
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-favorite-media', async (event, folderId, page) => {
  try {
    const result = await bilibiliAPI.getFavoriteMedia(folderId, page);
    console.log('获取收藏夹内容结果:', JSON.stringify(result)?.substring(0, 500));
    return result;
  } catch (error) {
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('get-recommendations', async (event) => {
  try {
    const result = await bilibiliAPI.getRecommendations();
    console.log('获取推荐内容结果:', JSON.stringify(result)?.substring(0, 500));
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

ipcMain.handle('download-audio', async (event, audioUrl, fileName) => {
  try {
    console.log('开始下载音频:', audioUrl, fileName);
    const { promisify } = require('util');
    const fs = require('fs');
    const path = require('path');
    const writeFile = promisify(fs.writeFile);
    
    const buffer = await bilibiliAPI.getAudioProxy(audioUrl);
    
    // 使用应用数据目录作为下载位置，避免权限问题
    const appDataDir = app.getPath('userData');
    const downloadDir = path.join(appDataDir, 'downloads');
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    // 生成文件名，确保格式正确
    const safeFileName = fileName.replace(/[<>"/\\|?*]/g, '').substring(0, 100);
    const filePath = path.join(downloadDir, `${safeFileName}.mp3`);
    
    await writeFile(filePath, buffer);
    console.log('音频下载完成:', filePath);
    return { code: 0, data: filePath };
  } catch (error) {
    console.error('下载音频失败:', error);
    return { code: -1, message: error.message };
  }
});

ipcMain.handle('open-download-folder', async () => {
  try {
    const { shell } = require('electron');
    const path = require('path');
    const downloadDir = path.join(app.getPath('userData'), 'downloads');
    
    // 确保下载目录存在
    const fs = require('fs');
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    await shell.openPath(downloadDir);
    return { code: 0, message: '成功打开下载目录' };
  } catch (error) {
    console.error('打开下载目录失败:', error);
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
