const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const httpCookie = require('cookie');

const cacheManager = require('./cacheManager');

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
    mainWindow.loadURL('http://localhost:5175/');
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

ipcMain.handle('get-video-series', async (event, bvid) => {
  try {
    const result = await bilibiliAPI.getVideoSeries(bvid);
    console.log('获取视频合集结果:', JSON.stringify(result)?.substring(0, 500));
    return result;
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
    
    // cacheManager 管理的音频缓存
    try {
      const audioCacheDir = path.join(__dirname, '..', 'cache', 'audio');
      if (fs.existsSync(audioCacheDir)) {
        totalSize += await calculateDirectorySize(audioCacheDir);
      }
    } catch (e) {
      // 忽略错误
    }
    
    // 项目根目录下的 cache 目录
    try {
      const projectCacheDir = path.join(__dirname, '..', 'cache');
      if (fs.existsSync(projectCacheDir)) {
        totalSize += await calculateDirectorySize(projectCacheDir);
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
    // 清空下载目录中的缓存
    const downloadDir = path.join(app.getPath('userData'), 'downloads');
    if (fs.existsSync(downloadDir)) {
      try {
        const files = fs.readdirSync(downloadDir);
        for (const file of files) {
          const filePath = path.join(downloadDir, file);
          fs.unlinkSync(filePath);
        }
      } catch (e) {
        console.log('清空下载目录失败:', e);
      }
    }
    
    // 清空 Electron 的缓存
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearStorageData();
    } catch (e) {
      console.log('清空 session 缓存失败:', e);
    }
    
    // 清空 cacheManager 管理的缓存
    try {
      cacheManager.clearAllCache();
    } catch (e) {
      console.log('清空音频缓存失败:', e);
    }
    
    // 清空项目根目录下的 cache 目录
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

// 获取当前下载目录
ipcMain.handle('get-download-directory', async () => {
  try {
    let downloadDir = path.join(app.getPath('userData'), 'downloads');
    
    // 尝试从本地存储读取保存的目录
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.downloadDir) {
        downloadDir = settings.downloadDir;
      }
    }
    
    // 确保目录存在
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    return { code: 0, path: downloadDir };
  } catch (error) {
    console.error('获取下载目录失败:', error);
    return { code: -1, message: error.message };
  }
});

// 保存下载目录
ipcMain.handle('set-download-directory', async (event, dirPath) => {
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let settings = {};
    
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    }
    
    settings.downloadDir = dirPath;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    
    // 确保目录存在
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    return { code: 0 };
  } catch (error) {
    console.error('保存下载目录失败:', error);
    return { code: -1, message: error.message };
  }
});

// 更新下载音频函数,使用自定义目录
ipcMain.handle('download-audio', async (event, audioUrl, fileName) => {
  try {
    console.log('开始下载音频:', audioUrl, fileName);
    const { promisify } = require('util');
    const writeFile = promisify(fs.writeFile);
    
    const buffer = await bilibiliAPI.getAudioProxy(audioUrl);
    
    // 获取下载目录
    let downloadDir = path.join(app.getPath('userData'), 'downloads');
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.downloadDir) {
        downloadDir = settings.downloadDir;
      }
    }
    
    // 确保下载目录存在
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    
    // 生成文件名,确保格式正确
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

// 更新打开下载目录函数
ipcMain.handle('open-download-folder', async () => {
  try {
    let downloadDir = path.join(app.getPath('userData'), 'downloads');
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.downloadDir) {
        downloadDir = settings.downloadDir;
      }
    }
    
    // 确保下载目录存在
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
