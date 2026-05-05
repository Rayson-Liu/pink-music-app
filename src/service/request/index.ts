import axios, { type CreateAxiosDefaults } from 'axios';

import { requestInterceptors } from './request-interceptors';
import { responseInterceptors } from './response-interceptors';

const axiosConfig: CreateAxiosDefaults = {
  timeout: 10000,
  withCredentials: true,
};

export const axiosInstance = axios.create(axiosConfig);

export const searchRequest = axios.create({
  ...axiosConfig,
  baseURL: 'https://s.search.bilibili.com',
});

export const biliRequest = axios.create({
  ...axiosConfig,
  baseURL: 'https://www.bilibili.com',
});

export const memberRequest = axios.create({
  ...axiosConfig,
  baseURL: 'https://member.bilibili.com',
});

export const apiRequest = axios.create({
  ...axiosConfig,
  baseURL: 'https://api.bilibili.com',
});

export const passportRequest = axios.create({
  ...axiosConfig,
  baseURL: 'https://passport.bilibili.com',
});

apiRequest.interceptors.request.use(requestInterceptors);
passportRequest.interceptors.request.use(requestInterceptors);
searchRequest.interceptors.request.use(requestInterceptors);
memberRequest.interceptors.request.use(requestInterceptors);

apiRequest.interceptors.response.use(responseInterceptors);

const noWbiRequest = axios.create({
  timeout: 10000,
  withCredentials: true,
  baseURL: 'https://api.bilibili.com',
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
  },
});
noWbiRequest.interceptors.response.use(res => res.data);

export { noWbiRequest };

axiosInstance.interceptors.response.use(res => res.data);
biliRequest.interceptors.response.use(res => res.data);
apiRequest.interceptors.response.use(res => res.data);
passportRequest.interceptors.response.use(res => res.data);
searchRequest.interceptors.response.use(res => res.data);
memberRequest.interceptors.response.use(res => res.data);
