const fs = require('fs')
const path = require('path')
const { app } = require('electron')

class CacheManager {
  constructor() {
    // 缓存目录（使用当前目录，避免权限问题）
    this.cacheDir = path.join(__dirname, '..', 'cache', 'audio')
    // 缓存数据库路径
    this.dbPath = path.join(__dirname, '..', 'cache', 'cache.db.json')
    this.db = null
    
    // 初始化缓存目录
    this.initCacheDir()
    // 初始化数据库（使用简单的文件存储，避免lowdb问题）
    this.initDatabaseSimple()
  }

  // 初始化缓存目录
  initCacheDir() {
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true })
      }
    } catch (error) {
      console.error('初始化缓存目录失败:', error)
    }
  }

  // 初始化数据库（使用简单的文件存储）
  initDatabaseSimple() {
    try {
      // 确保数据库目录存在
      const dbDir = path.dirname(this.dbPath)
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true })
      }
      
      // 读取或创建数据库文件
      if (fs.existsSync(this.dbPath)) {
        const data = fs.readFileSync(this.dbPath, 'utf8')
        this.db = JSON.parse(data)
      } else {
        this.db = {
          cache: {},
          collection: {}
        }
        this.saveDatabase()
      }
    } catch (error) {
      console.error('初始化数据库失败:', error)
      // 失败时使用内存存储
      this.db = {
        cache: {},
        collection: {}
      }
    }
  }

  // 保存数据库
  saveDatabase() {
    try {
      fs.writeFileSync(this.dbPath, JSON.stringify(this.db, null, 2))
    } catch (error) {
      console.error('保存数据库失败:', error)
    }
  }

  // 获取缓存文件路径
  getCacheFilePath(bvid, quality = 'mp3') {
    return path.join(this.cacheDir, `${bvid}_${quality}`)
  }

  // 检查缓存是否存在
  hasCache(bvid, quality = 'mp3') {
    const filePath = this.getCacheFilePath(bvid, quality)
    return fs.existsSync(filePath)
  }

  // 保存缓存信息
  saveCacheInfo(bvid, quality, info) {
    if (!this.db) return
    const key = `${bvid}_${quality}`
    this.db.cache[key] = {
      ...info,
      updatedAt: Date.now()
    }
    this.saveDatabase()
  }

  // 删除缓存
  deleteCache(bvid, quality = 'mp3') {
    if (!this.db) return
    const filePath = this.getCacheFilePath(bvid, quality)
    const key = `${bvid}_${quality}`
    
    // 删除文件
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
    
    // 删除数据库记录
    delete this.db.cache[key]
    this.saveDatabase()
  }

  // 清理过期缓存（7天）
  cleanExpiredCache() {
    if (!this.db) return
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
    
    for (const key in this.db.cache) {
      const cache = this.db.cache[key]
      if (cache.updatedAt < sevenDaysAgo) {
        const [bvid, quality] = key.split('_')
        this.deleteCache(bvid, quality)
      }
    }
  }

  // 清空所有缓存
  clearAllCache() {
    if (!this.db) return
    // 清空数据库
    this.db.cache = {}
    this.saveDatabase()
    
    // 清空缓存目录
    try {
      if (fs.existsSync(this.cacheDir)) {
        fs.readdirSync(this.cacheDir).forEach(file => {
          fs.unlinkSync(path.join(this.cacheDir, file))
        })
      }
    } catch (error) {
      console.error('清空缓存失败:', error)
    }
  }

  // 保存合集数据
  saveCollectionData(collectionId, data) {
    if (!this.db) return
    this.db.collection[collectionId] = {
      ...data,
      updatedAt: Date.now()
    }
    this.saveDatabase()
  }

  // 获取合集数据
  getCollectionData(collectionId) {
    if (!this.db) return null
    const data = this.db.collection[collectionId]
    if (!data) return null
    
    // 检查是否过期（30分钟）
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000
    if (data.updatedAt < thirtyMinutesAgo) {
      delete this.db.collection[collectionId]
      this.saveDatabase()
      return null
    }
    
    return data
  }

  // 获取缓存信息
  getCacheInfo(bvid, quality = 'mp3') {
    if (!this.db) return null
    return this.db.cache[`${bvid}_${quality}`]
  }
}

module.exports = new CacheManager()