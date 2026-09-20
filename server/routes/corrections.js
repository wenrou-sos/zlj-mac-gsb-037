const router = require('express').Router();
const pool = require('../config/db');
const { num, httpError, loadRequestUser } = require('../utils/common');

function generateRequestNo(recordId) {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const rand = String(Math.floor(Math.random() * 90000) + 10000);
  return `CR${y}${m}${day}${recordId}${rand}`;
}

/**
 * 在事务内按工单全部最新有效记录（原记录 + 当前生效修订）重算工单统计。
 * 调用前必须已持有该工单行的 FOR UPDATE 锁。
 * 重算内容：完成数、不良数、累计工时、状态(0<->1)、不良率告警。
 */
async function recalcOrderStats(conn, orderId) {
  // 锁定读（LOCK IN SHARE MODE）：读取最新已提交数据，避免 REPEATABLE READ
  // 快照导致并发批准时漏算其他事务刚提交的修订。
  const [sums] = await conn.query(
    `SELECT COALESCE(SUM(COALESCE(rv.completed_qty, r.completed_qty)), 0) AS completed_qty,
            COALESCE(SUM(COALESCE(rv.defect_qty, r.defect_qty)), 0) AS defect_qty,
            COALESCE(SUM(COALESCE(rv.work_hours, r.work_hours)), 0) AS work_hours,
            COUNT(r.id) AS record_count
     FROM production_records r
     LEFT JOIN record_revisions rv ON rv.id = r.current_revision_id
     WHERE r.order_id = ?
     LOCK IN SHARE MODE`,
    [orderId]
  );
  const completed = num(sums[0].completed_qty);
  const defect = num(sums[0].defect_qty);
  const hours = num(sums[0].work_hours);
  const recordCount = num(sums[0].record_count);

  const [orderRows] = await conn.query(
    'SELECT plan_qty, status, defect_threshold FROM work_orders WHERE id = ?',
    [orderId]
  );
  if (orderRows.length === 0) {
    throw httpError(404, '关联工单不存在');
  }
  const planQty = num(orderRows[0].plan_qty);
  const curStatus = num(orderRows[0].status);
  const threshold = orderRows[0].defect_threshold === null || orderRows[0].defect_threshold === undefined
    ? 5 : num(orderRows[0].defect_threshold);

  // 状态重算：有记录则待生产->生产中，无记录则生产中->待生产；已完成/已暂停保持不变
  let newStatus = curStatus;
  if (curStatus === 0 && recordCount > 0) newStatus = 1;
  else if (curStatus === 1 && recordCount === 0) newStatus = 0;

  await conn.query(
    `UPDATE work_orders SET
       completed_qty = ?,
       defect_qty = ?,
       total_work_hours = ?,
       status = ?,
       start_time = IF(? = 1 AND start_time IS NULL, NOW(), start_time)
     WHERE id = ?`,
    [completed, defect, hours, newStatus, newStatus, orderId]
  );

  const totalQty = completed + defect;
  const defectRate = totalQty > 0 ? +((defect / totalQty) * 100).toFixed(2) : 0;
  return {
    order_id: num(orderId),
    plan_qty: planQty,
    completed_qty: completed,
    defect_qty: defect,
    total_work_hours: hours,
    status: newStatus,
    completion_rate: planQty > 0 ? +((completed / planQty) * 100).toFixed(2) : 0,
    defect_rate: defectRate,
    defect_threshold: threshold,
    defect_alert: totalQty > 0 && defectRate > threshold
  };
}

function mapRequestRow(r) {
  return {
    id: num(r.id),
    request_no: r.request_no,
    record_id: num(r.record_id),
    order_id: num(r.order_id),
    order_no: r.order_no,
    applicant_id: num(r.applicant_id),
    applicant_name: r.applicant_name,
    old_completed_qty: num(r.old_completed_qty),
    old_defect_qty: num(r.old_defect_qty),
    old_work_hours: num(r.old_work_hours),
    old_defect_reason: r.old_defect_reason,
    new_completed_qty: num(r.new_completed_qty),
    new_defect_qty: num(r.new_defect_qty),
    new_work_hours: num(r.new_work_hours),
    new_defect_reason: r.new_defect_reason,
    reason: r.reason,
    status: num(r.status),
    reviewed_by: r.reviewed_by === null ? null : num(r.reviewed_by),
    reviewer_name: r.reviewer_name || null,
    reviewed_at: r.reviewed_at,
    review_comment: r.review_comment,
    created_at: r.created_at
  };
}

// 提交纠错申请（仅操作工，且只能对本人记录）
router.post('/', async (req, res) => {
  try {
    const user = await loadRequestUser(req);
    if (!user) return res.status(401).json({ success: false, message: '未登录或用户无效' });
    if (num(user.role) !== 2) {
      return res.status(403).json({ success: false, message: '仅操作工可提交纠错申请' });
    }

    const { record_id, new_defect_reason, reason } = req.body;
    const newCompleted = num(req.body.new_completed_qty);
    const newDefect = num(req.body.new_defect_qty);
    const newHours = num(req.body.new_work_hours);

    if (!record_id) {
      return res.status(400).json({ success: false, message: '缺少 record_id' });
    }
    if (!Number.isInteger(newCompleted) || newCompleted < 0 || newCompleted > 999999) {
      return res.status(400).json({ success: false, message: '修正完成数必须为 0~999999 的整数' });
    }
    if (!Number.isInteger(newDefect) || newDefect < 0 || newDefect > 999999) {
      return res.status(400).json({ success: false, message: '修正不良数必须为 0~999999 的整数' });
    }
    if (!(newHours >= 0 && newHours <= 24)) {
      return res.status(400).json({ success: false, message: '修正工时必须在 0~24 小时之间' });
    }
    if (newCompleted === 0 && newDefect === 0) {
      return res.status(400).json({ success: false, message: '修正后完成数与不良数不能同时为0' });
    }
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ success: false, message: '请填写纠错原因' });
    }
    if (String(reason).length > 500) {
      return res.status(400).json({ success: false, message: '纠错原因不能超过500字' });
    }
    if (new_defect_reason && String(new_defect_reason).length > 500) {
      return res.status(400).json({ success: false, message: '不良原因不能超过500字' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 锁定原记录并读取当前生效值（原记录永不被修改，生效值 = 最新修订或原值）
      const [recRows] = await conn.query(
        `SELECT r.id, r.order_id, r.user_id,
                IF(rv.id IS NULL, r.completed_qty, rv.completed_qty) AS eff_completed,
                IF(rv.id IS NULL, r.defect_qty, rv.defect_qty) AS eff_defect,
                IF(rv.id IS NULL, r.work_hours, rv.work_hours) AS eff_hours,
                IF(rv.id IS NULL, r.defect_reason, rv.defect_reason) AS eff_defect_reason
         FROM production_records r
         LEFT JOIN record_revisions rv ON rv.id = r.current_revision_id
         WHERE r.id = ?
         FOR UPDATE`,
        [record_id]
      );
      if (recRows.length === 0) {
        throw httpError(404, '生产记录不存在');
      }
      const rec = recRows[0];
      if (num(rec.user_id) !== num(user.id)) {
        throw httpError(403, '只能对本人上报的记录申请纠错');
      }

      // 防重复申请：同事务内检查 + 数据库 uk_pending_record 唯一索引兜底
      const [pendRows] = await conn.query(
        'SELECT id FROM record_correction_requests WHERE record_id = ? AND status = 0 LOCK IN SHARE MODE',
        [record_id]
      );
      if (pendRows.length > 0) {
        throw httpError(409, '该记录已有待审批的纠错申请，请勿重复提交');
      }

      const effCompleted = num(rec.eff_completed);
      const effDefect = num(rec.eff_defect);
      const effHours = num(rec.eff_hours);
      const effReason = rec.eff_defect_reason || null;
      const newReasonVal = new_defect_reason ? String(new_defect_reason) : null;
      if (newCompleted === effCompleted && newDefect === effDefect &&
          newHours === effHours && newReasonVal === effReason) {
        throw httpError(400, '修正值与当前生效值一致，无需纠错');
      }

      const requestNo = generateRequestNo(record_id);
      let result;
      try {
        [result] = await conn.query(
          `INSERT INTO record_correction_requests
           (request_no, record_id, order_id, applicant_id,
            old_completed_qty, old_defect_qty, old_work_hours, old_defect_reason,
            new_completed_qty, new_defect_qty, new_work_hours, new_defect_reason, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [requestNo, record_id, rec.order_id, user.id,
           effCompleted, effDefect, effHours, effReason,
           newCompleted, newDefect, newHours, newReasonVal, String(reason).trim()]
        );
      } catch (e) {
        if (e.code === 'ER_DUP_ENTRY' && /uk_pending_record/.test(e.message)) {
          throw httpError(409, '该记录已有待审批的纠错申请，请勿重复提交');
        }
        throw e;
      }

      await conn.commit();
      res.json({
        success: true,
        data: { id: result.insertId, request_no: requestNo },
        message: '纠错申请已提交，等待主管审批'
      });
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* ignore */ }
      if (err.expose) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 申请列表（操作工只能看本人；主管可看全部并按状态/申请人/工单筛选）
router.get('/', async (req, res) => {
  try {
    const user = await loadRequestUser(req);
    if (!user) return res.status(401).json({ success: false, message: '未登录或用户无效' });

    const { status, order_id, applicant_id, page = 1, pageSize = 20 } = req.query;
    const conditions = [];
    const params = [];

    if (num(user.role) === 2) {
      conditions.push('c.applicant_id = ?');
      params.push(user.id);
    } else if (applicant_id) {
      conditions.push('c.applicant_id = ?');
      params.push(applicant_id);
    }
    if (status !== undefined && status !== '' && status !== null) {
      conditions.push('c.status = ?');
      params.push(status);
    }
    if (order_id) {
      conditions.push('c.order_id = ?');
      params.push(order_id);
    }
    const where = conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT c.*, w.order_no, u.real_name AS applicant_name, rv.real_name AS reviewer_name
       FROM record_correction_requests c
       LEFT JOIN work_orders w ON c.order_id = w.id
       LEFT JOIN users u ON c.applicant_id = u.id
       LEFT JOIN users rv ON c.reviewed_by = rv.id
       ${where}
       ORDER BY (c.status = 0) DESC, c.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, parseInt(pageSize), (parseInt(page) - 1) * parseInt(pageSize)]
    );
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM record_correction_requests c${where}`,
      params
    );

    res.json({
      success: true,
      data: rows.map(mapRequestRow),
      total: num(countRows[0].total),
      page: parseInt(page),
      pageSize: parseInt(pageSize)
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 申请详情（操作工只能看本人的申请）
router.get('/:id', async (req, res) => {
  try {
    const user = await loadRequestUser(req);
    if (!user) return res.status(401).json({ success: false, message: '未登录或用户无效' });

    const [rows] = await pool.query(
      `SELECT c.*, w.order_no, u.real_name AS applicant_name, rv.real_name AS reviewer_name
       FROM record_correction_requests c
       LEFT JOIN work_orders w ON c.order_id = w.id
       LEFT JOIN users u ON c.applicant_id = u.id
       LEFT JOIN users rv ON c.reviewed_by = rv.id
       WHERE c.id = ?`,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: '纠错申请不存在' });
    }
    const row = rows[0];
    if (num(user.role) === 2 && num(row.applicant_id) !== num(user.id)) {
      return res.status(403).json({ success: false, message: '无权查看他人的纠错申请' });
    }
    res.json({ success: true, data: mapRequestRow(row) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 主管批准：新增不可变修订版本 + 事务内重算工单
router.post('/:id/approve', async (req, res) => {
  try {
    const user = await loadRequestUser(req);
    if (!user) return res.status(401).json({ success: false, message: '未登录或用户无效' });
    if (num(user.role) !== 1) {
      return res.status(403).json({ success: false, message: '仅车间主管可审批纠错申请' });
    }
    const { review_comment } = req.body;

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      // 1) 锁定申请
      const [reqRows] = await conn.query(
        'SELECT * FROM record_correction_requests WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (reqRows.length === 0) {
        throw httpError(404, '纠错申请不存在');
      }
      const reqRow = reqRows[0];
      if (num(reqRow.status) !== 0) {
        throw httpError(409, '该申请已被审批，请勿重复操作');
      }

      // 2) 锁定原记录
      const [recRows] = await conn.query(
        'SELECT id, order_id, remark FROM production_records WHERE id = ? FOR UPDATE',
        [reqRow.record_id]
      );
      if (recRows.length === 0) {
        throw httpError(404, '原生产记录不存在');
      }

      // 3) 锁定工单
      const [orderRows] = await conn.query(
        'SELECT id FROM work_orders WHERE id = ? FOR UPDATE',
        [reqRow.order_id]
      );
      if (orderRows.length === 0) {
        throw httpError(404, '关联工单不存在');
      }

      // 4) 生成下一版本号（记录行锁已持有，串行安全；锁定读确保看到最新已提交版本）
      const [revRows] = await conn.query(
        'SELECT COALESCE(MAX(revision_no), 0) + 1 AS next_no FROM record_revisions WHERE record_id = ? LOCK IN SHARE MODE',
        [reqRow.record_id]
      );
      const nextNo = num(revRows[0].next_no);

      // 5) 新增不可变修订版本
      const [revResult] = await conn.query(
        `INSERT INTO record_revisions
         (record_id, request_id, revision_no, completed_qty, defect_qty, work_hours, defect_reason, remark, changed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [reqRow.record_id, reqRow.id, nextNo,
         reqRow.new_completed_qty, reqRow.new_defect_qty, reqRow.new_work_hours,
         reqRow.new_defect_reason, recRows[0].remark, user.id]
      );

      // 6) 更新记录的生效指针
      await conn.query(
        'UPDATE production_records SET current_revision_id = ? WHERE id = ?',
        [revResult.insertId, reqRow.record_id]
      );

      // 7) 标记申请已批准（条件更新兜底，防并发重复审批）
      const [upd] = await conn.query(
        `UPDATE record_correction_requests
         SET status = 1, reviewed_by = ?, reviewed_at = NOW(), review_comment = ?
         WHERE id = ? AND status = 0`,
        [user.id, review_comment ? String(review_comment) : null, reqRow.id]
      );
      if (upd.affectedRows !== 1) {
        throw httpError(409, '该申请已被审批，请勿重复操作');
      }

      // 8) 按全部最新有效记录重算工单完成数/不良数/工时/状态/告警
      const stats = await recalcOrderStats(conn, reqRow.order_id);

      await conn.commit();
      res.json({
        success: true,
        warning: stats.defect_alert,
        message: stats.defect_alert
          ? `已批准，工单不良率 ${stats.defect_rate}% 超过阈值 ${stats.defect_threshold}%，请关注！`
          : '已批准，工单数据已按最新有效记录重新计算',
        data: { revision_no: nextNo, order: stats }
      });
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* ignore */ }
      if (err.expose) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      // 审批意见超长等数据约束错误：事务已完整回滚，申请保持待审批
      if (err.code === 'ER_DATA_TOO_LONG') {
        return res.status(400).json({ success: false, message: '审批意见过长，最多500字' });
      }
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 主管驳回
router.post('/:id/reject', async (req, res) => {
  try {
    const user = await loadRequestUser(req);
    if (!user) return res.status(401).json({ success: false, message: '未登录或用户无效' });
    if (num(user.role) !== 1) {
      return res.status(403).json({ success: false, message: '仅车间主管可审批纠错申请' });
    }
    const { review_comment } = req.body;
    if (!review_comment || !String(review_comment).trim()) {
      return res.status(400).json({ success: false, message: '驳回时必须填写审批意见' });
    }

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [reqRows] = await conn.query(
        'SELECT id, status FROM record_correction_requests WHERE id = ? FOR UPDATE',
        [req.params.id]
      );
      if (reqRows.length === 0) {
        throw httpError(404, '纠错申请不存在');
      }
      if (num(reqRows[0].status) !== 0) {
        throw httpError(409, '该申请已被审批，请勿重复操作');
      }

      const [upd] = await conn.query(
        `UPDATE record_correction_requests
         SET status = 2, reviewed_by = ?, reviewed_at = NOW(), review_comment = ?
         WHERE id = ? AND status = 0`,
        [user.id, String(review_comment).trim(), req.params.id]
      );
      if (upd.affectedRows !== 1) {
        throw httpError(409, '该申请已被审批，请勿重复操作');
      }

      await conn.commit();
      res.json({ success: true, message: '已驳回该纠错申请' });
    } catch (err) {
      try { await conn.rollback(); } catch (e) { /* ignore */ }
      if (err.expose) {
        return res.status(err.status).json({ success: false, message: err.message });
      }
      if (err.code === 'ER_DATA_TOO_LONG') {
        return res.status(400).json({ success: false, message: '审批意见过长，最多500字' });
      }
      throw err;
    } finally {
      conn.release();
    }
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.recalcOrderStats = recalcOrderStats;
