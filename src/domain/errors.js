// 调用方给了非法输入这一类错误，单独成一个类型，让 transport 层能把它
// 映射成 400 而不是混同于 500 的服务端内部错误。
//
// 放在 domain 层而不是 coordinator.js：协调器、状态、消息三个入口都要抛它，
// 留在 coordinator 里会让 domain 反向依赖 daemon，是分层倒置。
export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.statusCode = 400;
  }
}

export function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`"${field}" is required and must be a non-empty string`, field);
  }
  return value;
}

// 可选字段：undefined / null 视为"没传"，落库前用 fallback 补上；
// 空串、对象、数字都算显式传了非法值。
export function optionalString(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  return requireString(value, field);
}
