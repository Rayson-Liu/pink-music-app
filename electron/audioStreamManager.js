const axios = require('axios')
const fs = require('fs')
const path = require('path')
const cacheManager = require('./cacheManager')

class AudioStreamManager {
  constructor() {
    this.activeDownloads = new Map()
    this.concurrentLimit = 5
  }

  // 生成标准请求头
  getStandardHeaders(cookies = {}) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      'Referer': 'https://www.bilibili.com/',
      'Cookie': Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
    }
  }

  // 流式下载音频（支持Range请求）
  async streamDownload(bvid, audioUrl, quality = 'mp3', cookies = {}) {
    return new Promise((resolve, reject) => {
      const cachePath = cacheManager.getCacheFilePath(bvid, quality)
      const writeStream = fs.createWriteStream(cachePath)
      
      // 记录下载状态
      const downloadId = `${bvid}_${quality}`
      const downloadInfo = {
        bvid,
        audioUrl,
        quality,
        progress: 0,
        totalSize: 0,
        isComplete: false,
        writeStream,
        resolve,
        reject
      }
      
      this.activeDownloads.set(downloadId, downloadInfo)

      // 先发送HEAD请求获取文件大小
      axios.head(audioUrl, {
        headers: this.getStandardHeaders(cookies),
        timeout: 30000
      })
      .then(headResponse => {
        const contentLength = parseInt(headResponse.headers['content-length'] || headResponse.headers['Content-Length'])
        downloadInfo.totalSize = contentLength
        
        // 发起Range请求下载整个文件
        const headers = {
          ...this.getStandardHeaders(cookies),
          'Range': `bytes=0-${contentLength - 1}`
        }

        const response = axios.get(audioUrl, {
          headers,
          responseType: 'stream',
          timeout: 60000
        })

        response.then(res => {
          let downloadedSize = 0
          
          res.data.on('data', (chunk) => {
            downloadedSize += chunk.length
            downloadInfo.progress = Math.round((downloadedSize / contentLength) * 100)
            
            // 实时更新缓存信息
            cacheManager.saveCacheInfo(bvid, quality, {
              url: audioUrl,
              path: cachePath,
              size: contentLength,
              downloaded: downloadedSize,
              progress: downloadInfo.progress,
              quality
            })
          })

          res.data.pipe(writeStream)

          writeStream.on('finish', () => {
            downloadInfo.isComplete = true
            downloadInfo.progress = 100
            
            // 保存完整的缓存信息
            cacheManager.saveCacheInfo(bvid, quality, {
              url: audioUrl,
              path: cachePath,
              size: contentLength,
              downloaded: contentLength,
              progress: 100,
              quality,
              completed: true
            })
            
            this.activeDownloads.delete(downloadId)
            resolve({ success: true, path: cachePath })
          })

          writeStream.on('error', (error) => {
            console.error('写入文件失败:', error)
            this.activeDownloads.delete(downloadId)
            reject(error)
          })

        }).catch(error => {
          console.error('下载失败:', error)
          this.activeDownloads.delete(downloadId)
          reject(error)
        })

      }).catch(error => {
        console.error('获取文件大小失败:', error)
        this.activeDownloads.delete(downloadId)
        reject(error)
      })
    })
  }

  // 获取音频流（用于播放）
  async getAudioStream(audioUrl, cookies = {}) {
    try {
      const response = await axios.get(audioUrl, {
        headers: this.getStandardHeaders(cookies),
        responseType: 'stream',
        timeout: 30000
      })
      return response.data
    } catch (error) {
      console.error('获取音频流失败:', error)
      throw error
    }
  }

  // 获取缓存或下载
  async getAudioPath(bvid, audioUrl, quality = 'mp3', cookies = {}) {
    // 检查缓存
    if (cacheManager.hasCache(bvid, quality)) {
      const cacheInfo = cacheManager.getCacheInfo(bvid, quality)
      if (cacheInfo && cacheInfo.completed) {
        return { success: true, path: cacheManager.getCacheFilePath(bvid, quality), fromCache: true }
      }
    }

    // 开始下载
    try {
      const result = await this.streamDownload(bvid, audioUrl, quality, cookies)
      return { ...result, fromCache: false }
    } catch (error) {
      console.error('获取音频失败:', error)
      return { success: false, error: error.message }
    }
  }

  // 获取下载进度
  getDownloadProgress(bvid, quality = 'mp3') {
    const downloadId = `${bvid}_${quality}`
    const downloadInfo = this.activeDownloads.get(downloadId)
    if (downloadInfo) {
      return {
        progress: downloadInfo.progress,
        totalSize: downloadInfo.totalSize,
        isComplete: downloadInfo.isComplete
      }
    }
    
    // 检查缓存信息
    const cacheInfo = cacheManager.getCacheInfo(bvid, quality)
    if (cacheInfo) {
      return {
        progress: cacheInfo.progress || 0,
        totalSize: cacheInfo.size || 0,
        isComplete: cacheInfo.completed || false
      }
    }
    
    return { progress: 0, totalSize: 0, isComplete: false }
  }

  // 取消下载
  cancelDownload(bvid, quality = 'mp3') {
    const downloadId = `${bvid}_${quality}`
    const downloadInfo = this.activeDownloads.get(downloadId)
    if (downloadInfo) {
      if (downloadInfo.writeStream) {
        downloadInfo.writeStream.destroy()
      }
      this.activeDownloads.delete(downloadId)
    }
  }

  // 批量下载（控制并发）
  async batchDownload(downloads, cookies = {}) {
    const results = []
    const queue = [...downloads]
    
    async function processQueue() {
      if (queue.length === 0) return
      
      const task = queue.shift()
      try {
        const result = await audioStreamManager.getAudioPath(
          task.bvid,
          task.audioUrl,
          task.quality || 'mp3',
          cookies
        )
        results.push({ bvid: task.bvid, ...result })
      } catch (error) {
        results.push({ bvid: task.bvid, success: false, error: error.message })
      }
      
      await processQueue()
    }

    // 控制并发数
    const workers = []
    for (let i = 0; i < Math.min(this.concurrentLimit, downloads.length); i++) {
      workers.push(processQueue())
    }

    await Promise.all(workers)
    return results
  }
}

const audioStreamManager = new AudioStreamManager()
module.exports = audioStreamManager