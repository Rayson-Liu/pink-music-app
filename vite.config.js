import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    assetsDir: 'assets'
  },
  server: {
    proxy: {
      '/api': {
        target: 'https://api.bilibili.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      '/passport': {
        target: 'https://passport.bilibili.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/passport/, '')
      }
    }
  }
})