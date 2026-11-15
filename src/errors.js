/**
 * 桥的错误类型。对外统一成一个形状：给用户看的话 + HTTP 状态码 + 机器可读的代号。
 * 所有面向用户的文案都用大白话，说清「发生了什么」和「该怎么办」。
 */
export class BridgeError extends Error {
  /**
   * @param {string} message 给用户看的话
   * @param {number} [status] HTTP 状态码
   * @param {string} [code] 机器可读代号
   * @param {object} [diagnostic] 供本地日志分类的安全元数据；不能放错误原文或用户数据
   */
  constructor(message, status = 400, code = 'invalid_request', diagnostic) {
    super(message);
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    if (diagnostic !== undefined) this.diagnostic = diagnostic;
  }
}

/** 把任意异常收成 BridgeError，避免把内部堆栈漏给客户端 */
export function asBridgeError(error) {
  if (error instanceof BridgeError) return error;
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  return new BridgeError(`本机转发服务内部出错：${message}`, 500, 'internal_error');
}
