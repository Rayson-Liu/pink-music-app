const DiscordRPC = require('discord-rpc');

const CLIENT_ID = '1564248069632037035';

// 注册自定义协议（支持 Discord 客户端调起）
try {
  DiscordRPC.register(CLIENT_ID);
} catch (e) {
  console.warn('[DiscordRPC] register failed:', e.message);
}

class DiscordRpcManager {
  constructor() {
    this.clientId = CLIENT_ID;
    this.rpc = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isEnabled = true;
    this.currentActivity = null;
    this.lastConnectAttempt = 0;
    this.connectCooldown = 10000; // 10秒重连冷却
  }

  init() {
    if (!this.isEnabled) return;
    this.connect();
  }

  connect() {
    if (this.isConnected || this.isConnecting || !this.isEnabled) return;
    const now = Date.now();
    if (now - this.lastConnectAttempt < this.connectCooldown) return;
    this.lastConnectAttempt = now;
    this.isConnecting = true;

    try {
      this.rpc = new DiscordRPC.Client({ transport: 'ipc' });

      this.rpc.on('ready', () => {
        this.isConnected = true;
        this.isConnecting = false;
        console.log('[DiscordRPC] 已连接至 Discord 客户端，用户:', this.rpc.user?.username || '未知');
        if (this.currentActivity) {
          this.applyActivity(this.currentActivity);
        }
      });

      this.rpc.on('disconnected', () => {
        this.isConnected = false;
        this.isConnecting = false;
        console.log('[DiscordRPC] 与 Discord 客户端断开连接');
      });

      this.rpc.login({ clientId: this.clientId }).catch((err) => {
        this.isConnected = false;
        this.isConnecting = false;
        // Discord 未启动属于正常情况，静默记录
        console.log('[DiscordRPC] 连接 Discord 提示:', err.message);
      });
    } catch (err) {
      this.isConnected = false;
      this.isConnecting = false;
      console.warn('[DiscordRPC] 初始化异常:', err.message);
    }
  }

  sanitizeString(str, fallback = '', minLength = 2, maxLength = 128) {
    if (!str || typeof str !== 'string') return fallback;
    const clean = str.replace(/<[^>]+>/g, '').trim();
    if (clean.length < minLength) {
      return clean ? clean.padEnd(minLength, ' ') : fallback;
    }
    return clean.slice(0, maxLength);
  }

  setActivity(trackInfo) {
    if (!trackInfo || !trackInfo.title) {
      this.clearActivity();
      return;
    }

    this.currentActivity = trackInfo;

    if (!this.isEnabled) return;

    if (!this.isConnected) {
      this.connect();
      return;
    }

    this.applyActivity(trackInfo);
  }

  applyActivity(trackInfo) {
    if (!this.rpc || !this.isConnected || !this.isEnabled) return;

    try {
      const isPlaying = !!trackInfo.isPlaying;
      const title = this.sanitizeString(trackInfo.title, 'Pink Music', 2, 128);
      const artist = this.sanitizeString(trackInfo.artist, '未知歌手', 2, 128);
      const duration = Number(trackInfo.duration) || 0;
      const currentTime = Number(trackInfo.currentTime) || 0;

      const activity = {
        details: title,
        state: isPlaying ? `演唱：${artist}` : `已暂停 - ${artist}`,
        largeImageKey: (trackInfo.cover && trackInfo.cover.startsWith('http')) ? trackInfo.cover : 'pink-logo',
        largeImageText: 'Pink Music',
        smallImageKey: isPlaying ? 'play' : 'pause',
        smallImageText: isPlaying ? '正在播放' : '已暂停',
        instance: false
      };

      if (isPlaying && duration > 0) {
        const now = Math.floor(Date.now() / 1000);
        const start = now - Math.floor(currentTime);
        const end = start + Math.floor(duration);
        if (end > now) {
          activity.startTimestamp = start;
          activity.endTimestamp = end;
        } else {
          activity.startTimestamp = start;
        }
      } else if (isPlaying) {
        activity.startTimestamp = Math.floor(Date.now() / 1000) - Math.floor(currentTime);
      }

      this.rpc.setActivity(activity).catch((err) => {
        console.warn('[DiscordRPC] setActivity 失败:', err.message);
      });
    } catch (e) {
      console.warn('[DiscordRPC] applyActivity 异常:', e.message);
    }
  }

  clearActivity() {
    this.currentActivity = null;
    if (this.rpc && this.isConnected) {
      try {
        this.rpc.clearActivity().catch(() => {});
      } catch (_) {}
    }
  }

  setEnabled(enabled) {
    this.isEnabled = !!enabled;
    if (!this.isEnabled) {
      this.clearActivity();
    } else {
      this.connect();
      if (this.currentActivity) {
        this.applyActivity(this.currentActivity);
      }
    }
  }

  getStatus() {
    return {
      enabled: this.isEnabled,
      connected: this.isConnected,
      hasActivity: !!this.currentActivity
    };
  }

  destroy() {
    if (this.rpc) {
      try {
        this.clearActivity();
        this.rpc.destroy().catch(() => {});
      } catch (_) {}
      this.rpc = null;
      this.isConnected = false;
    }
  }
}

const discordRpcManager = new DiscordRpcManager();

module.exports = {
  discordRpcManager
};
