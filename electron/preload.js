const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  searchMusic: (keyword, page, pageSize) => ipcRenderer.invoke('search-music', keyword, page, pageSize),
  getMusicRegionFeed: (displayId, requestCnt) => ipcRenderer.invoke('get-music-region-feed', displayId, requestCnt),
  getMusicComprehensiveWebRank: (pn, ps) => ipcRenderer.invoke('get-music-comprehensive-web-rank', pn, ps),
  getMusicInfo: (bvid) => ipcRenderer.invoke('get-music-info', bvid),
  getMusicPlayUrl: (bvid, cid) => ipcRenderer.invoke('get-music-play-url', bvid, cid),
  getVideoEpisodes: (bvid) => ipcRenderer.invoke('get-video-episodes', bvid),
  proxyAudio: (audioUrl) => ipcRenderer.invoke('proxy-audio', audioUrl),

  getRecommendations: () => ipcRenderer.invoke('get-recommendations'),
  getVideoSeries: (bvid) => ipcRenderer.invoke('get-video-series', bvid),
  downloadAudio: (taskInfo) => ipcRenderer.invoke('download-audio', taskInfo),
  getDownloadTasks: () => ipcRenderer.invoke('get-download-tasks'),
  clearDownloadTasks: () => ipcRenderer.invoke('clear-download-tasks'),
  onDownloadProgress: (callback) => {
    const listener = (event, task) => callback(task)
    ipcRenderer.on('download-progress', listener)
    return () => ipcRenderer.removeListener('download-progress', listener)
  },
  openDownloadFolder: () => ipcRenderer.invoke('open-download-folder'),

  // 设置相关 API
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  clearCache: () => ipcRenderer.invoke('clear-cache'),
  selectDownloadDirectory: () => ipcRenderer.invoke('select-download-directory'),
  getDownloadDirectory: () => ipcRenderer.invoke('get-download-directory'),
  setDownloadDirectory: (dirPath) => ipcRenderer.invoke('set-download-directory', dirPath),
  openGitHub: () => ipcRenderer.invoke('open-github'),

  // 版本更新检查 API
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: (opts) => ipcRenderer.invoke('check-for-update', opts),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // 窗口控制 API
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  maximizeWindow: () => ipcRenderer.invoke('maximize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  isWindowMaximized: () => ipcRenderer.invoke('is-window-maximized'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  setWindowOpacity: (opacity) => ipcRenderer.invoke('set-window-opacity', opacity),

  // Discord Rich Presence API
  discord: {
    updateActivity: (activity) => ipcRenderer.invoke('discord-update-activity', activity),
    clearActivity: () => ipcRenderer.invoke('discord-clear-activity'),
    setEnabled: (enabled) => ipcRenderer.invoke('discord-set-enabled', enabled),
    getStatus: () => ipcRenderer.invoke('discord-get-status')
  },

  // 主存：原子写 + .bak + 损坏自愈
  appData: {
    get: (key) => ipcRenderer.invoke('app-data-get', key),
    set: (key, value) => ipcRenderer.invoke('app-data-set', key, value),
    remove: (key) => ipcRenderer.invoke('app-data-remove', key)
  },
  // 关窗 flush 协议：主进程 before-quit 时通知渲染进程写盘
  onFlushRequired: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('app-data-flush-required', listener)
    return () => ipcRenderer.removeListener('app-data-flush-required', listener)
  },
  notifyFlushDone: () => ipcRenderer.send('app-data-flush-done'),
  // 下载目录变更广播（主进程内存态同步）
  onDownloadDirChanged: (callback) => {
    const listener = (event, dir) => callback(dir)
    ipcRenderer.on('download-dir-changed', listener)
    return () => ipcRenderer.removeListener('download-dir-changed', listener)
  },

  // 歌词相关 API（source: 'netease' | 'kugou'）
  getLyric: (params) => ipcRenderer.invoke('get-lyric', params),
  searchLyric: (keyword, source) => ipcRenderer.invoke('search-lyric', keyword, source),
  getLyricById: (song) => ipcRenderer.invoke('get-lyric-by-id', song),

  // 登录与收藏夹同步 API
  generateQrcode: () => ipcRenderer.invoke('generate-qrcode'),
  pollQrcode: (qrcodeKey) => ipcRenderer.invoke('poll-qrcode', qrcodeKey),
  getUserInfo: () => ipcRenderer.invoke('get-user-info'),
  getFavFolderCreatedList: (upMid, pn, ps) => ipcRenderer.invoke('get-fav-folder-created-list', upMid, pn, ps),
  getFavFolderCollectedList: (upMid, pn, ps) => ipcRenderer.invoke('get-fav-folder-collected-list', upMid, pn, ps),
  getFavResourceList: (mediaId, pn, ps) => ipcRenderer.invoke('get-fav-resource-list', mediaId, pn, ps),
  getFavResourceIds: (mediaId) => ipcRenderer.invoke('get-fav-resource-ids', mediaId),
  getFavResourceInfos: (resources) => ipcRenderer.invoke('get-fav-resource-infos', resources),
  showMessageBox: (options) => ipcRenderer.invoke('dialog-message-box', options),
  getBilibiliCookies: () => ipcRenderer.invoke('get-bilibili-cookies'),
  logoutBilibili: () => ipcRenderer.invoke('logout-bilibili'),

  // 本地音乐库 API
  local: {
    // 弹出选择框：导入文件 / 导入文件夹
    importFiles: () => ipcRenderer.invoke('local-import-files'),
    importFolder: () => ipcRenderer.invoke('local-import-folder'),
    // 把任意路径（文件/文件夹）递归展开为音频绝对路径
    scanPaths: (paths) => ipcRenderer.invoke('local-scan-paths', paths),
    // 批量解析标签（标题/作者/专辑/时长/封面/lrc），进度通过 onParseProgress 回调
    parseMetadata: (filePaths) => ipcRenderer.invoke('local-parse-metadata', filePaths),
    // 校验文件是否仍存在（失效检测）
    checkFiles: (files) => ipcRenderer.invoke('local-check-files', files),
    // 读取同名 .lrc 歌词 / 重新探测歌词路径
    readLrc: (lyricPath) => ipcRenderer.invoke('local-read-lrc', lyricPath),
    findLrc: (filePath) => ipcRenderer.invoke('local-find-lrc', filePath),
    // 自定义歌单封面（选图 → 拷贝进 local-covers → 返回协议 URL）
    saveCover: () => ipcRenderer.invoke('local-save-cover'),
    // 打开文件所在目录 / 重新定位失效文件
    revealFile: (filePath) => ipcRenderer.invoke('local-reveal-file', filePath),
    relocateFile: () => ipcRenderer.invoke('local-relocate-file'),
    // 云端封面匹配（参考 LrcApi）：候选搜索 / 自动匹配 / 应用候选
    searchCover: (keyword) => ipcRenderer.invoke('local-search-cover', keyword),
    matchCover: (payload) => ipcRenderer.invoke('local-match-cover', payload),
    applyCover: (payload) => ipcRenderer.invoke('local-apply-cover', payload),
    // 解析进度订阅；返回取消订阅函数
    onParseProgress: (callback) => {
      const listener = (_event, payload) => {
        try { callback(payload) } catch (e) { console.error('[preload] local-parse-progress handler threw:', e) }
      }
      ipcRenderer.on('local-parse-progress', listener)
      return () => ipcRenderer.removeListener('local-parse-progress', listener)
    }
  }
});

contextBridge.exposeInMainWorld('electronPlayer', {
  /**
   * 订阅主进程发来的菜单命令。返回的函数用于取消监听（HMR / unmount 时清理）。
   * 与 App.vue 中 handleMenuCommand 配套：主进程通过 webContents.send('menu-command', payload)
   * 推送 { action, payload? } 对象。
   */
  onMenuCommand: (callback) => {
    const listener = (_event, payload) => {
      try {
        callback(payload)
      } catch (e) {
        console.error('[preload] menu-command handler threw:', e)
      }
    }
    ipcRenderer.on('menu-command', listener)
    return () => ipcRenderer.removeListener('menu-command', listener)
  }
});

// ============== 桌面歌词悬浮窗 ==============
// 两个窗口共用同一 preload：
//   - 主窗口用 pushState / onCommand / toggle
//   - 歌词窗口用 onState / seek / setIgnoreMouse / saveBounds
contextBridge.exposeInMainWorld('desktopLyricsAPI', {
  // 主窗口 → 主进程：转发播放状态/歌词/样式到歌词窗口
  pushState: (payload) => ipcRenderer.send('desktop-lyrics-state', payload),
  // 开关桌面歌词窗口，返回 { code, visible, created? }
  toggle: () => ipcRenderer.invoke('desktop-lyrics-toggle'),
  getVisible: () => ipcRenderer.invoke('desktop-lyrics-get-visible'),
  // 仅隐藏（工具条关闭按钮用）
  hide: () => ipcRenderer.invoke('desktop-lyrics-hide'),
  // 主窗口订阅歌词窗可见性变化（主进程为唯一事实源）；返回取消订阅函数
  onVisibilityChanged: (callback) => {
    const listener = (_event, payload) => {
      try { callback(!!(payload && payload.visible)) } catch (e) { console.error('[preload] desktop-lyrics-visibility handler threw:', e) }
    }
    ipcRenderer.on('desktop-lyrics-visibility', listener)
    return () => ipcRenderer.removeListener('desktop-lyrics-visibility', listener)
  },
  // 歌词窗口 → 主窗口：点击歌词行跳转播放进度
  requestSeek: (time) => ipcRenderer.invoke('desktop-lyrics-seek', time),
  // 锁定穿透开关
  setIgnoreMouseEvents: (ignore) => ipcRenderer.invoke('desktop-lyrics-set-ignore-mouse', ignore),
  // 全局快捷键：读取当前组合 / 设置新组合（主进程校验+注册，冲突时回滚旧键）
  getLyricsHotkey: () => ipcRenderer.invoke('desktop-lyrics-hotkey-get'),
  setLyricsHotkey: (accel) => ipcRenderer.invoke('desktop-lyrics-hotkey-set', accel),
  // 歌词窗口挂载完成后发 ready 握手（避免主窗口过早推送、消息在页面加载完成前丢失）
  notifyReady: () => ipcRenderer.send('desktop-lyrics-ready'),
  // 歌词窗口订阅主窗口推送的状态流；返回取消订阅函数
  onState: (callback) => {
    const listener = (_event, payload) => {
      try { callback(payload) } catch (e) { console.error('[preload] desktop-lyrics-state handler threw:', e) }
    }
    ipcRenderer.on('desktop-lyrics-state', listener)
    return () => ipcRenderer.removeListener('desktop-lyrics-state', listener)
  },
  // 主窗口订阅歌词窗口回传命令（seek 等）；返回取消订阅函数
  onCommand: (callback) => {
    const listener = (_event, payload) => {
      try { callback(payload) } catch (e) { console.error('[preload] desktop-lyrics-command handler threw:', e) }
    }
    ipcRenderer.on('desktop-lyrics-command', listener)
    return () => ipcRenderer.removeListener('desktop-lyrics-command', listener)
  }
});
