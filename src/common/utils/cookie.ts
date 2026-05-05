import { passportRequest } from '@/service/request';

/**
 * 刷新Cookie
 */
export async function refreshCookie() {
  try {
    const csrf = await window.electron.getCookie('bili_jct');
    if (csrf) {
      await passportRequest.get('/x/passport-login/web/cookie/refresh', {
        params: { csrf },
      });
    }
  } catch (error) {
    console.error('刷新Cookie失败:', error);
  }
}

/**
 * 获取Cookie
 * @param name Cookie名称
 * @returns Promise<string>
 */
export async function getCookie(name: string): Promise<string> {
  return window.electron.getCookie(name);
}

/**
 * 设置Cookie
 * @param name Cookie名称
 * @param value Cookie值
 * @returns Promise<void>
 */
export async function setCookie(name: string, value: string): Promise<void> {
  return window.electron.setCookie(name, value);
}
