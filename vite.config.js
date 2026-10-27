import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'
import http from 'http'
import https from 'https'

function audioProxyPlugin() {
  return {
    name: 'audio-proxy-plugin',
    configureServer(server) {
      server.middlewares.use('/proxy-audio', (req, res) => {
        try {
          const parsedUrl = new URL(req.url, 'http://localhost');
          const targetUrl = parsedUrl.searchParams.get('url');
          if (!targetUrl) {
            res.statusCode = 400;
            res.end('Missing url parameter');
            return;
          }

          const forwardRequest = (requestUrl, hops = 0) => {
            if (hops > 5) {
              res.statusCode = 502;
              res.end('Too many redirects');
              return;
            }

            const client = requestUrl.startsWith('https') ? https : http;
            const headers = {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Referer': 'https://www.bilibili.com/',
              'Origin': 'https://www.bilibili.com'
            };
            if (req.headers.range) {
              headers['Range'] = req.headers.range;
            }

            const proxyReq = client.get(requestUrl, { headers }, (proxyRes) => {
              if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                return forwardRequest(proxyRes.headers.location, hops + 1);
              }

              res.statusCode = proxyRes.statusCode || 200;
              for (const [key, value] of Object.entries(proxyRes.headers)) {
                if (key.toLowerCase() !== 'content-security-policy') {
                  res.setHeader(key, value);
                }
              }
              res.setHeader('Access-Control-Allow-Origin', '*');
              proxyRes.pipe(res);
            });

            proxyReq.on('error', (err) => {
              res.statusCode = 502;
              res.end(err.message);
            });
          };

          forwardRequest(targetUrl);
        } catch (e) {
          res.statusCode = 500;
          res.end(e.message);
        }
      });
    }
  }
}

export default defineConfig({
  plugins: [vue(), audioProxyPlugin()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    assetsDir: 'assets',
    rollupOptions: {
      // 多入口：index.html 主应用 + desktop_lyrics.html 桌面歌词悬浮窗
      input: {
        main: path.resolve(__dirname, 'index.html'),
        desktopLyrics: path.resolve(__dirname, 'desktop_lyrics.html')
      }
    }
  },
  server: {
    watch: {
      ignored: [
        '**/screenshots/**',
        '**/release/**',
        '**/dist/**',
        '**/.git/**',
        '**/node_modules/**'
      ]
    },
    proxy: {
      '/api': {
        target: 'https://api.bilibili.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
        headers: {
          Referer: 'https://www.bilibili.com/',
          Origin: 'https://www.bilibili.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        cookieDomainRewrite: 'localhost',
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            const customCookie = req.headers['x-bilibili-cookie'];
            if (customCookie) {
              const existing = proxyReq.getHeader('cookie') || '';
              proxyReq.setHeader('cookie', existing ? `${existing}; ${customCookie}` : customCookie);
            }
          });
        }
      },
      '/passport': {
        target: 'https://passport.bilibili.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/passport/, ''),
        headers: {
          Referer: 'https://passport.bilibili.com/',
          Origin: 'https://passport.bilibili.com',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        cookieDomainRewrite: 'localhost'
      },
      '/netease-api': {
        target: 'https://music.163.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/netease-api/, ''),
        headers: {
          Referer: 'https://music.163.com/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      }
    }
  }
})
