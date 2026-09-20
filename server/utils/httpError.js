/** 可携带 HTTP 状态码与业务错误码的异常类型 */
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = 'HttpError';
    this.status = status || 400;
    this.code = code || null;
  }
}

module.exports = HttpError;
