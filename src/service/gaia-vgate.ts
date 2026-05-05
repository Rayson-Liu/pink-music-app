import axios from 'axios';

export interface GaiaVGateRegisterRequest {
  v_voucher: string;
  csrf: string;
}

export interface GaiaVGateRegisterResponse {
  code: number;
  message: string;
  ttl: number;
  data: {
    captcha_key: string;
    token: string;
    challenge: string;
    gt: string;
    height: number;
    width: number;
  };
}

export interface GaiaVGateValidateRequest {
  challenge: string;
  token: string;
  validate: string;
  seccode: string;
  csrf: string;
}

export interface GaiaVGateValidateResponse {
  code: number;
  message: string;
  ttl: number;
  data: {
    grisk_id: string;
    risk_type: number;
  };
}

export const postGaiaVGateRegister = (data: GaiaVGateRegisterRequest) => {
  return axios.post<GaiaVGateRegisterResponse>('https://api.bilibili.com/api/gaia-vgate/register', data);
};

export const postGaiaVGateValidate = (data: GaiaVGateValidateRequest) => {
  return axios.post<GaiaVGateValidateResponse>('https://api.bilibili.com/api/gaia-vgate/validate', data);
};