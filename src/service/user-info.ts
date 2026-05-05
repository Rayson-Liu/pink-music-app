import { apiRequest } from './request';

/**
 * 获取用户信息 - 响应类型
 */
export interface UserInfoResponse {
  code: number;
  message: string;
  ttl: number;
  data: UserInfoData;
}

/**
 * 获取用户信息 - 数据类型
 */
export interface UserInfoData {
  mid: number;
  name: string;
  sex: string;
  face: string;
  sign: string;
  rank: number;
  level: number;
  jointime: number;
  moral: number;
  silence: number;
  birthday: number;
  coins: number;
  fans_badge: boolean;
  official: {
    role: number;
    title: string;
    desc: string;
    type: number;
  };
  vip: {
    type: number;
    status: number;
    due_date: number;
    vip_pay_type: number;
    theme_type: number;
    label: {
      path: string;
      text: string;
      label_theme: string;
      text_color: string;
      bg_style: number;
      bg_color: string;
      border_color: string;
    };
    avatar_subscript: number;
    nickname_color: string;
  };
  pendant: {
    pid: number;
    name: string;
    image: string;
    expire: number;
  };
  nameplate: {
    nid: number;
    name: string;
    image: string;
    image_small: string;
    level: string;
    condition: string;
  };
  is_followed: boolean;
  top_photo: string;
  theme: {
    is_followed: boolean;
  };
  wbi_img: {
    img_url: string;
    sub_url: string;
  };
  is_fans: boolean;
  fans_detail: any;
}

/**
 * 获取用户信息
 * @returns Promise<UserInfoResponse>
 */
export const getUserInfo = () => {
  return apiRequest.get<UserInfoResponse>('/x/web-interface/nav', { useWbi: true });
};
