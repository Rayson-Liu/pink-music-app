# Pink Music

基于 Electron + Vue 3 的第三方 B 站音乐播放器，核心功能是从哔哩哔哩网站获取视频作为音频播放。

## 主要特性

- 🎵 从 B 站搜索和获取音乐内容
- 🎶 支持多种播放模式（顺序、循环、单曲循环、随机）
- 📂 本地歌单管理（创建、导入、导出）
- 🎨 多主题颜色切换（粉色、紫色、蓝色、绿色、橙色）
- 🌙 深色/浅色模式切换
- ⬇️ 音频下载功能
- 📑 分P视频切换
- 🎨 毛玻璃效果和流畅动画

## 技术栈

| 技术 | 版本 | 用途 |
|------|------|------|
| Electron | ^20.0.0 | 桌面应用框架 |
| Vue 3 | ^3.5.32 | 前端框架 |
| Vite | ^8.0.4 | 构建工具 |
| axios | ^1.15.2 | HTTP 请求 |

## 安装

```bash
# 克隆项目
git clone https://github.com/Rayson-Liu/pink-music-app.git

# 安装依赖
npm install

# 启动开发服务器
npm run dev

# 启动 Electron 客户端
npm run electron:dev
```

## 构建

```bash
# 构建 macOS 应用
npm run electron:build

# 构建 Windows 应用
npm run electron:build -- --win
```

## 使用说明

### 搜索音乐
在搜索框中输入关键词，点击搜索按钮或按回车键进行搜索。

### 播放音乐
点击音乐卡片直接播放，或点击播放按钮进行播放控制。

### 分P切换
当播放的视频包含多个分P时，点击右侧列表按钮查看并切换分P。

### 歌单管理
- 创建歌单：点击侧边栏"创建"按钮
- 导入歌单：点击"导入"按钮，选择导出的 JSON 文件
- 导出歌单：在歌单页面点击"导出"按钮

### 下载音乐
在音乐卡片或歌单中点击下载按钮，音频将保存到下载目录。

### 主题设置
点击右上角主题按钮，可切换颜色主题和深色/浅色模式。

## 下载目录

- **macOS**: `~/Library/Application Support/Pink Music/downloads/`
- **Windows**: `%APPDATA%\Pink Music\downloads\`
- **Linux**: `~/.config/Pink Music/downloads/`

## 项目结构

```
pink-music/
├── electron/                 # Electron 主进程
│   ├── main.js             # 主进程入口
│   └── preload.js           # 预加载脚本
├── src/                     # 渲染进程（Vue应用）
│   ├── App.vue             # 主组件
│   ├── main.js             # Vue 入口
│   ├── style.css           # 全局样式
│   └── utils/
│       └── bilibili.js     # B站工具函数
├── package.json
└── vite.config.js
```

## 免责声明

本项目仅供个人学习交流使用，请勿用于任何商业用途。使用本项目产生的任何问题由使用者自行承担。

## License

[Unlicense License](LICENSE)
