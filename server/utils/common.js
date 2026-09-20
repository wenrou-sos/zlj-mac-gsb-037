const pool = require('../config/db');

const num = (v) => (v === null || v === undefined) ? 0 : Number(v);

/** 业务错误：带 HTTP 状态码，路由捕获后按状态码返回 */
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

/**
 * 根据请求携带的身份（x-user-id 请求头，或 body/query 中的 user_id）
 * 从数据库加载用户，用于服务端权限校验。无效或未启用用户返回 null。
 */
async function loadRequestUser(req) {
  const uid = req.headers['x-user-id'] || (req.body && req.body.user_id) || req.query.user_id;
  if (!uid) return null;
  const [rows] = await pool.query(
    'SELECT id, username, real_name, role, line_id, status FROM users WHERE id = ? AND status = 1',
    [uid]
  );
  return rows[0] || null;
}

module.exports = { num, httpError, loadRequestUser };
