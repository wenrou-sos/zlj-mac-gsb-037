/**
 * 轻量鉴权中间件
 * 沿用前端现有约定：登录后请求头携带 x-user-id（见 client/src/api/index.js）。
 * - authOptional: 携带请求头则校验用户并挂到 req.authUser；未携带则放行（兼容历史接口）
 * - authRequired: 必须携带有效用户，否则 401
 * - requireRole: 在 authRequired 之后做角色校验，越权返回 403
 */
const pool = require('../config/db');

async function loadAuthUser(req, res) {
  const headerUserId = req.headers['x-user-id'];
  if (headerUserId === undefined || headerUserId === null || headerUserId === '') {
    return null;
  }
  const [rows] = await pool.query(
    'SELECT id, username, real_name, role, line_id, status FROM users WHERE id = ? AND status = 1',
    [headerUserId]
  );
  if (rows.length === 0) {
    res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: '登录已失效或用户已被禁用，请重新登录' });
    return undefined;
  }
  return rows[0];
}

function authOptional(req, res, next) {
  loadAuthUser(req, res)
    .then((user) => {
      if (user === undefined) return; // 已返回 401
      req.authUser = user;
      next();
    })
    .catch(next);
}

function authRequired(req, res, next) {
  loadAuthUser(req, res)
    .then((user) => {
      if (user === undefined) return; // 已返回 401
      if (!user) {
        return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: '请先登录' });
      }
      req.authUser = user;
      next();
    })
    .catch(next);
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.authUser) {
      return res.status(401).json({ success: false, code: 'UNAUTHENTICATED', message: '请先登录' });
    }
    if (!roles.includes(req.authUser.role)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: '无权执行该操作' });
    }
    next();
  };
}

module.exports = { authOptional, authRequired, requireRole };
