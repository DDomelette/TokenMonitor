const { STATUS_CODES } = require('node:http');

const MAX_SUMMARY_LENGTH = 160;

function rawMessage(error) {
  if (error && typeof error.message === 'string') return error.message;
  if (typeof error === 'string') return error;
  return error == null ? '' : String(error);
}

function bounded(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '请求失败';
  if (text.length <= MAX_SUMMARY_LENGTH) return text;
  return text.slice(0, MAX_SUMMARY_LENGTH - 3).trimEnd() + '...';
}

function redactGeneric(message) {
  let value = String(message || '');

  value = value.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, '[凭证已隐藏]');
  value = value.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, '[凭证已隐藏]');
  value = value.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[凭证已隐藏]');
  value = value.replace(
    /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi,
    '$1=[已隐藏]'
  );
  value = value.replace(/https?:\/\/[^\s]+/gi, '[地址已隐藏]');
  value = value.replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '[路径已隐藏]');
  value = value.replace(/\/(?:[^/\s]+\/)+[^/\s]*/g, '[路径已隐藏]');
  value = value.replace(/\{[^{}]{0,4000}\}|\[[^\[\]]{0,4000}\]/g, '[详情已隐藏]');

  return bounded(value);
}

function summarizeProviderError(error) {
  const message = rawMessage(error);

  if (/unauthoriz|forbidden|\b401\b|\b403\b|invalid[ -]?token|token[^\n]{0,24}expired|认证|登录已过期/i.test(message)) {
    return '认证已过期或无效';
  }
  if (/timed?\s*out|timeout|ETIMEDOUT|请求超时/i.test(message)) {
    return '请求超时';
  }
  if (/(?:proxy|代理)[\s\S]{0,120}(?:connect|ECONNREFUSED|tunnel|socket)|(?:ECONNREFUSED)[\s\S]{0,120}(?:proxy|代理)/i.test(message)) {
    return '代理连接失败';
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|name or service not known|无法解析/i.test(message)) {
    return '网络地址无法解析';
  }
  if (/ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up|network offline/i.test(message)) {
    return '网络连接失败';
  }

  const httpMatch = /\bHTTP\s+([1-5]\d{2})\b/i.exec(message);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    const reason = STATUS_CODES[status];
    return reason ? `HTTP ${status} ${reason}` : `HTTP ${status}`;
  }

  return redactGeneric(message);
}

module.exports = {
  MAX_SUMMARY_LENGTH,
  summarizeProviderError
};
