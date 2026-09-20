const router = require('express').Router();
const pool = require('../config/db');
const { authOptional } = require('../middleware/auth');

const num = (v) => (v === null || v === undefined) ? 0 : Number(v);

router.use(authOptional);

// 单条生产记录（含版本信息）；操作工仅可查本人记录
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT r.*, w.order_no, w.status AS order_status,
             l.line_name, p.product_name, p.product_model, p.unit,
             u.real_name as user_name
      FROM production_records r
      LEFT JOIN work_orders w ON r.order_id = w.id
      LEFT JOIN production_lines l ON w.line_id = l.id
      LEFT JOIN products p ON w.product_id = p.id
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.id = ?
    `, [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '生产记录不存在' });
    }
    const r = rows[0];
    if (req.authUser && num(req.authUser.role) === 2 && num(r.user_id) !== num(req.authUser.id)) {
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: '无权查看他人的生产记录' });
    }
    res.json({
      success: true,
      data: {
        id: num(r.id),
        order_id: num(r.order_id),
        order_status: num(r.order_status),
        user_id: num(r.user_id),
        completed_qty: num(r.completed_qty),
        defect_qty: num(r.defect_qty),
        work_hours: num(r.work_hours),
        defect_reason: r.defect_reason,
        remark: r.remark,
        created_at: r.created_at,
        current_version: num(r.current_version),
        last_revised_at: r.last_revised_at,
        order_no: r.order_no,
        line_name: r.line_name,
        product_name: r.product_name,
        product_model: r.product_model,
        unit: r.unit,
        user_name: r.user_name
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/', async (req, res) => {
  const { order_id, user_id, correction_status, page = 1, pageSize = 20 } = req.query;
  let sql = `
    SELECT r.*, w.order_no, w.status AS order_status,
           l.line_name,
           p.product_name, p.product_model, p.unit,
           u.real_name as user_name,
           (SELECT c.status FROM record_corrections c
             WHERE c.record_id = r.id AND c.status = 0
             ORDER BY c.id DESC LIMIT 1) AS pending_correction_status
    FROM production_records r
    LEFT JOIN work_orders w ON r.order_id = w.id
    LEFT JOIN production_lines l ON w.line_id = l.id
    LEFT JOIN products p ON w.product_id = p.id
    LEFT JOIN users u ON r.user_id = u.id
  `;
  const conditions = [];
  const params = [];
  if (order_id) {
    conditions.push('r.order_id = ?');
    params.push(order_id);
  }
  // 服务端强制越权防护：操作工只能查看本人记录（前端约束之外的第二道防线）
  if (req.authUser && num(req.authUser.role) === 2) {
    conditions.push('r.user_id = ?');
    params.push(req.authUser.id);
  } else if (user_id) {
    conditions.push('r.user_id = ?');
    params.push(user_id);
  }
  // 申请状态筛选：pending=有待审批申请 / approved=产生过修订版本 / none=从未申请
  if (correction_status === 'pending') {
    conditions.push('EXISTS (SELECT 1 FROM record_corrections pc WHERE pc.record_id = r.id AND pc.status = 0)');
  } else if (correction_status === 'approved') {
    conditions.push('r.current_version > 0');
  } else if (correction_status === 'none') {
    conditions.push('NOT EXISTS (SELECT 1 FROM record_corrections nc WHERE nc.record_id = r.id)');
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  const limit = Math.min(parseInt(pageSize) || 20, 200);
  const offset = ((parseInt(page) || 1) - 1) * limit;
  sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  try {
    const [rows] = await pool.query(sql, params);
    const countConditions = conditions.slice();
    // 计数 SQL 不引用主表别名以外的东西；EXISTS 子查询直接可用
    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM production_records r' +
      ((countConditions.length > 0) ? ' WHERE ' + countConditions.join(' AND ') : ''),
      params.slice(0, -2)
    );
    const data = rows.map(r => ({
      id: num(r.id),
      order_id: num(r.order_id),
      order_status: num(r.order_status),
      user_id: num(r.user_id),
      completed_qty: num(r.completed_qty),
      defect_qty: num(r.defect_qty),
      work_hours: num(r.work_hours),
      defect_reason: r.defect_reason,
      remark: r.remark,
      created_at: r.created_at,
      current_version: num(r.current_version),
      last_revised_at: r.last_revised_at,
      has_pending_correction: r.pending_correction_status !== null,
      order_no: r.order_no,
      line_name: r.line_name,
      product_name: r.product_name,
      product_model: r.product_model,
      unit: r.unit,
      user_name: r.user_name
    }));
    res.json({
      success: true,
      data,
      total: num(countResult[0].total),
      page: parseInt(page),
      pageSize: limit
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', async (req, res) => {
  const { order_id, completed_qty, defect_qty, work_hours, defect_reason, remark } = req.body;
  // 已登录用户以请求头身份为准，忽略 body 中的 user_id，防止冒名上报；
  // 未携带鉴权头时（历史调用）回退使用 body.user_id
  const userId = req.authUser ? req.authUser.id : req.body.user_id;
  if (!userId) {
    return res.status(400).json({ success: false, message: '缺少上报人信息，请重新登录' });
  }
  const addCompleted = num(completed_qty);
  const addDefect = num(defect_qty);
  const addHours = num(work_hours);

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [orderRows] = await conn.query(
      'SELECT completed_qty, defect_qty, defect_threshold, line_id FROM work_orders WHERE id = ? FOR UPDATE',
      [order_id]
    );
    if (orderRows.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ success: false, message: '工单不存在' });
    }
    const cur = orderRows[0];

    // 越权防护：操作工只能向自己所属产线的工单上报
    if (req.authUser && num(req.authUser.role) === 2 && req.authUser.line_id !== null
        && num(cur.line_id) !== num(req.authUser.line_id)) {
      await conn.rollback();
      conn.release();
      return res.status(403).json({ success: false, code: 'FORBIDDEN', message: '不能向非本人所属产线的工单上报' });
    }

    const beforeCompleted = num(cur.completed_qty);
    const beforeDefect = num(cur.defect_qty);
    const threshold = cur.defect_threshold === null || cur.defect_threshold === undefined ? 5 : num(cur.defect_threshold);

    const finalCompleted = beforeCompleted + addCompleted;
    const finalDefect = beforeDefect + addDefect;
    const finalTotal = finalCompleted + finalDefect;
    const finalDefectRate = finalTotal > 0 ? +((finalDefect / finalTotal) * 100).toFixed(2) : 0;
    const defect_alert = finalTotal > 0 && finalDefectRate > threshold;

    const [result] = await conn.query(
      `INSERT INTO production_records
       (order_id, user_id, completed_qty, defect_qty, work_hours, defect_reason, remark)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [order_id, userId, addCompleted, addDefect, addHours, defect_reason || null, remark || null]
    );

    await conn.query(
      `UPDATE work_orders SET
        completed_qty = completed_qty + ?,
        defect_qty = defect_qty + ?,
        total_work_hours = total_work_hours + ?,
        status = CASE
          WHEN status = 0 THEN 1
          WHEN status = 2 THEN 2
          ELSE status
        END,
        start_time = IF(start_time IS NULL, NOW(), start_time)
       WHERE id = ?`,
      [addCompleted, addDefect, addHours, order_id]
    );

    await conn.commit();
    conn.release();

    const message = defect_alert
      ? `上报成功，但当前工单不良率 ${finalDefectRate}% 已超过阈值 ${threshold}%，请关注！`
      : '上报成功';

    res.json({
      success: true,
      warning: defect_alert,
      message,
      data: {
        id: result.insertId,
        final_defect_rate: finalDefectRate,
        final_completed_qty: finalCompleted,
        final_defect_qty: finalDefect,
        defect_threshold: threshold,
        defect_alert
      }
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch (e) {}
      try { conn.release(); } catch (e) {}
    }
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
