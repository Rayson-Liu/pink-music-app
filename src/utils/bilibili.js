class BilibiliAPI {
  constructor() {
    this.cookies = {}
    this.defaultCover = 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400'
    this.defaultCovers = [
      'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400',
      'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400',
      'https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=400',
      'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400',
      'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=400'
    ]
  }

  getDefaultCover(index = 0) {
    return this.defaultCovers[index % this.defaultCovers.length]
  }

  processCoverUrl(coverUrl, fallbackIndex = 0) {
    if (!coverUrl) {
      return this.getDefaultCover(fallbackIndex)
    }
    let processedUrl = coverUrl
    if (processedUrl.startsWith('//')) {
      processedUrl = 'https:' + processedUrl
    }
    if (!processedUrl.startsWith('http')) {
      processedUrl = 'https://' + processedUrl
    }
    return processedUrl
  }

  setCookies(cookies) {
    this.cookies = cookies
  }

  async getLoginQRCode() {
    try {
      const result = await window.electronAPI.getLoginQRCode()
      if (result.code === 0) {
        return {
          success: true,
          qrcodeKey: result.data.qrcode_key,
          qrcodeUrl: result.data.url,
          qrcodeImage: `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(result.data.url)}`
        }
      }
      return { success: false, error: result.message || '生成二维码失败' }
    } catch (error) {
      console.error('获取登录二维码失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async checkLoginStatus(qrcodeKey) {
    try {
      const result = await window.electronAPI.checkLoginStatus(qrcodeKey)
      console.log('登录状态检查原始返回:', JSON.stringify(result))
      if (result.code === 0) {
        const cookies = this.extractCookiesFromResult(result)
        return {
          success: true,
          isLoggedIn: result.data.code === 0,
          url: result.data.url,
          cookies: cookies,
          code: result.data.code,
          message: result.data.message
        }
      }
      return { success: false, isLoggedIn: false, error: result.message || '检查登录状态失败' }
    } catch (error) {
      console.error('检查登录状态失败:', error)
      return { success: false, isLoggedIn: false, error: error.message || '网络错误' }
    }
  }

  extractCookiesFromResult(result) {
    const cookies = {}
    if (result.data.url) {
      try {
        const url = new URL(result.data.url)
        const searchParams = url.searchParams
        
        // 提取所有可能的Cookie参数
        const cookieParams = ['bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'SESSDATA']
        cookieParams.forEach(param => {
          const value = searchParams.get(param)
          if (value) {
            cookies[param] = value
          }
        })
      } catch (e) {
        console.error('解析Cookie失败:', e)
      }
    }
    if (result.data.refresh_token) {
      cookies.refresh_token = result.data.refresh_token
    }
    return cookies
  }

  async searchMusic(keyword, page = 1, pageSize = 30) {
    try {
      if (window.electronAPI) {
        const result = await window.electronAPI.searchMusic(keyword, page, pageSize)
        console.log('搜索结果原始返回:', JSON.stringify(result)?.substring(0, 1000))

        if (result.code === 0 && result.data?.result) {
          const videoResult = result.data.result.find(item => item.result_type === 'video')
          if (videoResult && videoResult.data) {
            return {
              success: true,
              music: videoResult.data.map((item, index) => ({
                bvid: item.bvid,
                aid: item.aid,
                title: this.stripHtmlTags(item.title || ''),
                author: item.author || '未知作者',
                cover: this.processCoverUrl(item.pic, index),
                duration: this.parseDuration(item.duration) || 180,
                playCount: item.play || 0,
                pubdate: item.pubdate,
                description: item.description || ''
              }))
            }
          }
        }

        if (result.data?.video) {
          return {
            success: true,
            music: result.data.video.map((item, index) => ({
              bvid: item.bvid,
              aid: item.aid,
              title: this.stripHtmlTags(item.title || ''),
              author: item.author || '未知作者',
              cover: this.processCoverUrl(item.pic, index),
              duration: this.parseDuration(item.duration) || 180,
              playCount: item.play || 0,
              pubdate: item.pubdate,
              description: item.description || ''
            }))
          }
        }

        return { success: true, music: [] }
      }
      return this.getMockSearchResults(keyword)
    } catch (error) {
      console.error('搜索音乐失败:', error)
      return { success: false, error: error.message || '网络错误', music: [] }
    }
  }

  stripHtmlTags(str) {
    return str.replace(/<[^>]*>/g, '')
  }

  parseDuration(duration) {
    if (!duration) return 180
    if (typeof duration === 'number') return duration

    const parts = duration.split(':')
    if (parts.length === 2) {
      return parseInt(parts[0]) * 60 + parseInt(parts[1])
    }
    return 180
  }

  getMockSearchResults(keyword) {
    return {
      success: true,
      music: [
        {
          bvid: 'BV1xx411c7mZ',
          aid: 12345678,
          title: `【测试】${keyword} - 示例音乐1`,
          author: '测试UP主',
          cover: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400',
          duration: 180,
          playCount: 123456,
          pubdate: 1620000000,
          description: '这是一个测试音乐'
        },
        {
          bvid: 'BV1yy411d7nZ',
          aid: 87654321,
          title: `【测试】${keyword} - 示例音乐2`,
          author: '测试UP主',
          cover: 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400',
          duration: 240,
          playCount: 987654,
          pubdate: 1620000000,
          description: '这是另一个测试音乐'
        }
      ]
    }
  }

  async getMusicInfo(bvid) {
    try {
      const result = await window.electronAPI.getMusicInfo(bvid)
      console.log('获取音乐信息原始返回:', JSON.stringify(result)?.substring(0, 500))
      if (result.code === 0) {
        const item = result.data
        return {
          success: true,
          music: {
            bvid: item.bvid,
            aid: item.aid,
            title: item.title,
            author: item.owner?.name || '未知作者',
            cover: this.processCoverUrl(item.pic),
            duration: item.duration || 180,
            cid: item.cid,
            playCount: item.stat?.view || 0,
            likeCount: item.stat?.like || 0,
            coinCount: item.stat?.coin || 0,
            favoriteCount: item.stat?.favorite || 0,
            commentCount: item.stat?.reply || 0,
            pubdate: item.pubdate,
            description: item.desc || ''
          }
        }
      }
      return { success: false, error: result.message || '音乐不存在' }
    } catch (error) {
      console.error('获取音乐信息失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async getMusicPlayUrl(bvid, cid) {
    try {
      console.log('开始获取播放地址:', bvid, cid)
      const result = await window.electronAPI.getMusicPlayUrl(bvid, cid)
      console.log('获取播放地址原始返回:', JSON.stringify(result)?.substring(0, 1000))
      if (result.code === 0) {
        // 尝试多种可能的数据结构
        if (result.data?.durl?.[0]?.url) {
          console.log('使用durl格式的音频地址')
          return {
            success: true,
            url: result.data.durl[0].url
          }
        } else if (result.data?.data?.durl?.[0]?.url) {
          console.log('使用data.durl格式的音频地址')
          return {
            success: true,
            url: result.data.data.durl[0].url
          }
        } else if (result.data?.url) {
          console.log('使用url格式的音频地址')
          return {
            success: true,
            url: result.data.url
          }
        } else if (result.data?.dash?.audio?.[0]?.baseUrl) {
          console.log('使用dash.audio.baseUrl格式的音频地址')
          return {
            success: true,
            url: result.data.dash.audio[0].baseUrl
          }
        } else if (result.data?.dash?.audio?.[0]?.url) {
          console.log('使用dash.audio.url格式的音频地址')
          return {
            success: true,
            url: result.data.dash.audio[0].url
          }
        } else {
          console.error('未找到音频地址，数据结构:', JSON.stringify(result.data))
        }
      }
      console.error('获取播放地址失败:', result.message || '未知错误')
      return { success: false, error: result.message || '获取播放地址失败' }
    } catch (error) {
      console.error('获取音乐播放地址失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async getProxyAudioUrl(audioUrl) {
    try {
      const result = await window.electronAPI.proxyAudio(audioUrl)
      if (result.code === 0) {
        return {
          success: true,
          data: result.data
        }
      }
      return { success: false, error: result.message || '代理音频失败' }
    } catch (error) {
      console.error('代理音频失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async getFavorites() {
    try {
      const result = await window.electronAPI.getFavorites()
      console.log('获取收藏夹原始返回:', JSON.stringify(result)?.substring(0, 500))
      if (result.code === 0 && result.data?.list) {
        return {
          success: true,
          favorites: result.data.list.map((item, index) => ({
            id: item.id,
            name: item.title,
            cover: this.processCoverUrl(item.cover, index),
            media_count: item.media_count || 0
          }))
        }
      }
      return { success: false, error: result.message || '获取收藏夹失败' }
    } catch (error) {
      console.error('获取收藏夹失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async getFavoriteMedia(folderId, page = 1) {
    try {
      const result = await window.electronAPI.getFavoriteMedia(folderId, page)
      console.log('获取收藏夹内容原始返回:', JSON.stringify(result)?.substring(0, 500))
      if (result.code === 0 && result.data?.media_list) {
        return {
          success: true,
          media: result.data.media_list.map((item, index) => ({
            bvid: item.bvid,
            aid: item.id,
            title: item.title,
            author: item.upper?.name || '未知作者',
            cover: this.processCoverUrl(item.cover, index),
            duration: item.duration || 180,
            playCount: item.play || 0,
            pubdate: item.pubtime,
            description: item.intro || ''
          }))
        }
      }
      return { success: false, error: result.message || '获取收藏夹内容失败' }
    } catch (error) {
      console.error('获取收藏夹内容失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async getVideoSeries(bvid) {
    try {
      const result = await window.electronAPI.getVideoSeries(bvid)
      console.log('获取视频合集原始返回:', JSON.stringify(result)?.substring(0, 500))
      if (result.code === 0 && result.data) {
        const seriesData = result.data
        return {
          success: true,
          series: {
            id: seriesData.id,
            title: seriesData.title,
            cover: this.processCoverUrl(seriesData.cover),
            episodes: seriesData.list || []
          }
        }
      }
      return { success: false, error: result.message || '获取视频合集失败' }
    } catch (error) {
      console.error('获取视频合集失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async getAudioPath(bvid, audioUrl, quality = 'mp3') {
    try {
      const result = await window.electronAPI.getAudioPath(bvid, audioUrl, quality)
      if (result.code === 0 && result.data) {
        return result.data
      }
      return { success: false, error: result.message || '获取音频路径失败' }
    } catch (error) {
      console.error('获取音频路径失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  async getDownloadProgress(bvid, quality = 'mp3') {
    try {
      const result = await window.electronAPI.getDownloadProgress(bvid, quality)
      if (result.code === 0 && result.data) {
        return result.data
      }
      return { progress: 0, totalSize: 0, isComplete: false }
    } catch (error) {
      console.error('获取下载进度失败:', error)
      return { progress: 0, totalSize: 0, isComplete: false }
    }
  }

  async cancelDownload(bvid, quality = 'mp3') {
    try {
      const result = await window.electronAPI.cancelDownload(bvid, quality)
      return result.code === 0
    } catch (error) {
      console.error('取消下载失败:', error)
      return false
    }
  }

  async clearCache() {
    try {
      const result = await window.electronAPI.clearCache()
      return result.code === 0
    } catch (error) {
      console.error('清空缓存失败:', error)
      return false
    }
  }

  async getRecommendations() {
    try {
      const result = await window.electronAPI.getRecommendations()
      console.log('获取推荐内容原始返回:', JSON.stringify(result)?.substring(0, 500))
      if (result.code === 0 && result.data?.item) {
        return {
          success: true,
          music: result.data.item.map((item, index) => ({
            bvid: item.bvid || item.id_str,
            aid: item.aid || 0,
            title: this.stripHtmlTags(item.title || ''),
            author: item.owner?.name || item.up?.name || '未知作者',
            cover: this.processCoverUrl(item.pic, index),
            duration: this.parseDuration(item.duration) || 180,
            playCount: item.stat?.view || 0,
            pubdate: item.pubdate || 0,
            description: item.desc || ''
          })).filter(item => item.bvid)
        }
      }
      return { success: false, error: result.message || '获取推荐内容失败' }
    } catch (error) {
      console.error('获取推荐内容失败:', error)
      return { success: false, error: error.message || '网络错误' }
    }
  }

  bvid2aid(bvid) {
    const table = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF'
    const tr = {}
    for (let i = 0; i < 58; i++) {
      tr[table[i]] = i
    }
    const s = [11, 10, 3, 8, 4, 6]
    let x = 0
    for (let i = 0; i < 6; i++) {
      x += tr[bvid[s[i]]] * Math.pow(58, i)
    }
    return (x - 0x2_08b0_0000) ^ 0x0a93_b324
  }

  aid2bvid(aid) {
    const table = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF'
    const s = [11, 10, 3, 8, 4, 6]
    const x = (aid ^ 0x0a93_b324) + 0x2_08b0_0000
    let r = Array(10).fill('B')
    r[0] = 'B'
    r[1] = 'V'
    for (let i = 0; i < 6; i++) {
      r[s[i]] = table[Math.floor(x / Math.pow(58, i)) % 58]
    }
    return r.join('')
  }

  getTimestamp() {
    return Math.floor(Date.now() / 1000)
  }
}

export const bilibiliAPI = new BilibiliAPI()

export function parseDuration(duration) {
  if (typeof duration === 'number') {
    const mins = Math.floor(duration / 60)
    const secs = Math.floor(duration % 60)
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }
  return duration || '0:00'
}

export function formatPlayCount(count) {
  if (count >= 100000000) {
    return (count / 100000000).toFixed(1) + '亿'
  }
  if (count >= 10000) {
    return (count / 10000).toFixed(1) + '万'
  }
  return count.toString()
}

export function formatPubdate(timestamp) {
  const date = new Date(timestamp * 1000)
  const now = new Date()
  const diff = now - date

  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000)
    if (hours < 1) {
      const mins = Math.floor(diff / 60000)
      return mins + '分钟前'
    }
    return hours + '小时前'
  }
  if (diff < 604800000) {
    return Math.floor(diff / 86400000) + '天前'
  }
  return `${date.getMonth() + 1}-${date.getDate()}`
}

export function extractBVId(input) {
  const match = input.match(/BV[a-zA-Z0-9]+/)
  return match ? match[0] : null
}