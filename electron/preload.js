const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getLoginQRCode: () => ipcRenderer.invoke('get-login-qrcode'),
  checkLoginStatus: (qrcodeKey) => ipcRenderer.invoke('check-login-status', qrcodeKey),
  setCookies: (cookies) => ipcRenderer.invoke('set-cookies', cookies),

  searchMusic: (keyword, page, pageSize) => ipcRenderer.invoke('search-music', keyword, page, pageSize),
  getMusicInfo: (bvid) => ipcRenderer.invoke('get-music-info', bvid),
  getMusicPlayUrl: (bvid, cid) => ipcRenderer.invoke('get-music-play-url', bvid, cid),
  getVideoEpisodes: (bvid) => ipcRenderer.invoke('get-video-episodes', bvid),
  proxyAudio: (audioUrl) => ipcRenderer.invoke('proxy-audio', audioUrl),

  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  getFavoriteMedia: (folderId, page) => ipcRenderer.invoke('get-favorite-media', folderId, page),
  getRecommendations: () => ipcRenderer.invoke('get-recommendations'),
  getVideoSeries: (bvid) => ipcRenderer.invoke('get-video-series', bvid),
  downloadAudio: (audioUrl, fileName) => ipcRenderer.invoke('download-audio', audioUrl, fileName),
  openDownloadFolder: () => ipcRenderer.invoke('open-download-folder')
});

contextBridge.exposeInMainWorld('electron', {
  getCookie: (key) => ipcRenderer.invoke('get-cookie', key),
  setCookie: (name, value, expirationDate) => ipcRenderer.invoke('set-cookie', { name, value, expirationDate })
});
