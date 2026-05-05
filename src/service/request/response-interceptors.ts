import type { AxiosResponse } from 'axios';

export const responseInterceptors = async (response: AxiosResponse) => {
  if (response?.data?.data?.v_voucher) {
    console.log('Geetest verification required but not implemented');
  }
  return response;
};