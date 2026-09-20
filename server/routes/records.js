const router = require('express').Router();
const pool = require('../config/db');
const { num, loadRequestUser } = require('../utils/common');

router.get('/', async (req, res) => {
  const { order_id, user_id, page = 1, pageSize = 20 } = req.query;
  let sql = `
    SELECT r.*, w.order_no, u.real_name as user_name,
           l.line_name, p.product_name, p.product_model,
           rv.revision_no AS current_revision_no,
           rv.completed_qty AS eff_completed_qty,
           rv.defect_qty AS eff_defect_qty,
           rv.work_hours AS eff_work_hours,
           rv.defect_reason AS eff_defect_reason,
           cr.id AS pending_correction_id
    FROM production_records r
    LEFT JOIN work_orders w ON r.order_id = w.id
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN production_lines l ON w.line_id = l.id
    LEFT JOIN products p ON w.product_id = p.id
    LEFT JOIN record_revisions rv ON rv.id = r.current_revision_id
    LEFT JOIN record_correction_requests cr ON cr.record_id = r.id AND cr.status = 0
  `;
  const conditions = [];
  const params = [];
  if (order_id) {
    conditions.push('r.order_id = ?');
    params.push(order_id);
  }
  if (user_id) {
    conditions.push('r.user_id = ?');
    params.push(user_id);
  }
  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
  params.push(parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize));

  try {
    const [rows] = await pool.query(sql, params);
    const [countResult] = await pool.query(
      'SELECT COUNT(*) as total FROM production_records r' +
      ((conditions.length > 0) ? ' WHERE ' + conditions.join(' AND ') : ''),
      params.slice(0, -2)
    );
    const data = rows.map(r => {
      // 是否存在生效修订（注意：修订的不良原因可能合法地为 NULL，不能用 COALESCE 判别）
      const hasRev = r.current_revision_no !== null && r.current_revision_no !== undefined;
      return {
        id: num(r.id),
        order_id: num(r.order_id),
        user_id: num(r.user_id),
        completed_qty: num(r.completed_qty),
        defect_qty: num(r.defect_qty),
        work_hours: num(r.work_hours),
        defect_reason: r.defect_reason,
        remark: r.remark,
        created_at: r.created_at,
        order_no: r.order_no,
        user_name: r.user_name,
        line_name: r.line_name,
        product_name: r.product_name,
        product_model: r.product_model,
        // 修订状态与当前生效值（无修订时生效值 = 原始值）
        revision_no: num(r.current_revision_no),
        pending_correction_id: r.pending_correction_id === null ? null : num(r.pending_correction_id),
        effective_completed_qty: hasRev ? num(r.eff_completed_qty) : num(r.completed_qty),
        effective_defect_qty: hasRev ? num(r.eff_defect_qty) : num(r.defect_qty),
        effective_work_hours: hasRev ? num(r.eff_work_hours) : num(r.work_hours),
        effective_defect_reason: hasRev ? r.eff_defect_reason : r.defect_reason
      };
    });
    res.json({
      success: true,
      data,
      total: num(countResult[0].total),
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 记录修订时间线：原始记录 + 全部修订版本（含纠错申请与审批信息）
router.get('/:id/revisions', async (req, res) => {
  try {
    const user = await loadRequestUser(req);
    if (!user) return res.status(401).json({ success: false, message: '未登录或用户无效' });

    const [recRows] = await pool.query(
      `SELECT r.*, w.order_no, u.real_name AS user_name
       FROM production_records r
       LEFT JOIN work_orders w ON r.order_id = w.id
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.id = ?`,
      [req.params.id]
    );
    if (recRows.length === 0) {
      return res.status(404).json({ success: false, message: '生产记录不存在' });
    }
    const rec = recRows[0];
    if (num(user.role) === 2 && num(rec.user_id) !== num(user.id)) {
      return res.status(403).json({ success: false, message: '无权查看他人记录的修订历史' });
    }

    const [revRows] = await pool.query(
      `SELECT rv.*, c.request_no, c.reason, c.review_comment, c.reviewed_at,
              c.applicant_id, ua.real_name AS applicant_name,
              cu.real_name AS changed_by_name
       FROM record_revisions rv
       LEFT JOIN record_correction_requests c ON rv.request_id = c.id
       LEFT JOIN users ua ON c.applicant_id = ua.id
       LEFT JOIN users cu ON rv.changed_by = cu.id
       WHERE rv.record_id = ?
       ORDER BY rv.revision_no ASC`,
      [req.params.id]
    );

    res.json({
      success: true,
      data: {
        record: {
          id: num(rec.id),
          order_id: num(rec.order_id),
          order_no: rec.order_no,
          user_id: num(rec.user_id),
          user_name: rec.user_name,
          completed_qty: num(rec.completed_qty),
          defect_qty: num(rec.defect_qty),
          work_hours: num(rec.work_hours),
          defect_reason: rec.defect_reason,
          remark: rec.remark,
          current_revision_id: rec.current_revision_id === null ? null : num(rec.current_revision_id),
          created_at: rec.created_at
        },
        revisions: revRows.map(rv => ({
          id: num(rv.id),
          revision_no: num(rv.revision_no),
          completed_qty: num(rv.completed_qty),
          defect_qty: num(rv.defect_qty),
          work_hours: num(rv.work_hours),
          defect_reason: rv.defect_reason,
          remark: rv.remark,
          changed_by: num(rv.changed_by),
          changed_by_name: rv.changed_by_name,
          created_at: rv.created_at,
          request_id: num(rv.request_id),
          request_no: rv.request_no,
          reason: rv.reason,
          review_comment: rv.review_comment,
          reviewed_at: rv.reviewed_at,
          applicant_id: rv.applicant_id === null ? null : num(rv.applicant_id),
          applicant_name: rv.applicant_name
        }))
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', async (req, res) => {
  const { order_id, user_id, completed_qty, defect_qty, work_hours, defect_reason, remark } = req.body;
  const addCompleted = num(completed_qty);
  const addDefect = num(defect_qty);
  const addHours = num(work_hours);

  try {
    const conn = await pool.getConnection();
    await conn.beginTransaction();

    const [orderRows] = await conn.query(
      'SELECT completed_qty, defect_qty, defect_threshold FROM work_orders WHERE id = ? FOR UPDATE',
      [order_id]
    );
    if (orderRows.length === 0) {
      await conn.rollback();
      conn.release();
      return res.status(404).json({ success: false, message: '工单不存在' });
    }
    const cur = orderRows[0];
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
      [order_id, user_id, addCompleted, addDefect, addHours, defect_reason || null, remark || null]
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
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
