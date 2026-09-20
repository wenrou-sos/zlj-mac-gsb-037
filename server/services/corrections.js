/**
 * 生产记录纠错审批服务
 *
 * 并发安全约定（InnoDB + REPEATABLE READ）：
 *   全局加锁顺序固定为  production_records -> work_orders -> record_corrections，
 *   申请、批准、驳回均按此顺序取锁，避免交叉等待死锁。
 *
 *   - 申请：SELECT ... FOR UPDATE 锁记录（同时锁工单），事务内复查待审批申请
 *   - 批准/驳回：先锁记录、再锁工单（批准时），最后锁申请；
 *               条件 UPDATE ... WHERE status=0 兜底，保证重复/并发审批只有一方成功
 *
 *   防重复申请：record_corrections 上 (record_id, pending_flag) 唯一索引，
 *               同一条记录存在待审批申请时，第二方插入必失败（ER 1062 -> 409）。
 */
const pool = require('../config/db');
const HttpError = require('../utils/httpError');
const {
  toNum, summarizeRecords, deriveOrderStatus, shouldSetStartTime, buildDiff
} = require('./recompute');

const STATUSES = { PENDING: 0, APPROVED: 1, REJECTED: 2 };

function toInt(v, field) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new HttpError(400, `${field}必须为非负整数`, 'VALIDATION_ERROR');
  }
  return n;
}

function toHours(v, field) {
  const n = Number(v);
  if (v === '' || v === null || v === undefined || Number.isNaN(n) || n < 0 || n > 9999) {
    throw new HttpError(400, `${field}必须为 0~9999 之间的数值`, 'VALIDATION_ERROR');
  }
  return +n.toFixed(2);
}

function cleanText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** 规范化申请人提交的修正值 */
function normalizeCorrectionInput(body) {
  const out = {
    corrected_completed_qty: toInt(body.corrected_completed_qty, '修正后完成数'),
    corrected_defect_qty: toInt(body.corrected_defect_qty, '修正后不良数'),
    corrected_work_hours: toHours(body.corrected_work_hours, '修正后工时'),
    corrected_defect_reason: cleanText(body.corrected_defect_reason),
    corrected_remark: cleanText(body.corrected_remark),
    reason: cleanText(body.reason)
  };
  if (!out.reason) {
    throw new HttpError(400, '请填写纠错原因', 'VALIDATION_ERROR');
  }
  if (out.reason.length > 500) {
    throw new HttpError(400, '纠错原因不能超过500字', 'VALIDATION_ERROR');
  }
  if (out.corrected_completed_qty === 0 && out.corrected_defect_qty === 0 && out.corrected_work_hours === 0) {
    // 允许只改文本（不良原因/备注），但若数值工时全 0 且文本也没改，下面会再判“无变化”
  }
  return out;
}

/** 判断修正值是否与现值存在差异 */
function hasAnyChange(record, c) {
  return toNum(record.completed_qty) !== c.corrected_completed_qty
    || toNum(record.defect_qty) !== c.corrected_defect_qty
    || +toNum(record.work_hours).toFixed(2) !== c.corrected_work_hours
    || (record.defect_reason || null) !== c.corrected_defect_reason
    || (record.remark || null) !== c.corrected_remark;
}

async function rollbackAndRelease(conn) {
  try { await conn.rollback(); } catch (e) { /* 连接已失效 */ }
  try { conn.release(); } catch (e) { /* 已释放 */ }
}

function mapDbError(err) {
  if (err instanceof HttpError) return err;
  // ER_DUP_NAME / 唯一索引冲突：待审批申请已存在
  if (err && err.code === 'ER_DUP_ENTRY') {
    return new HttpError(409, '该记录已有待审批的纠错申请，请勿重复提交', 'DUPLICATE_PENDING');
  }
  // ER_LOCK_DEADLOCK / 锁等待超时
  if (err && (err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT')) {
    return new HttpError(409, '操作冲突（资源正被其他审批处理），请重试', 'LOCK_CONFLICT');
  }
  return new HttpError(500, err.message || '数据库操作失败', 'DB_ERROR');
}

/**
 * 提交纠错申请
 * @param {object} applicant 鉴权用户（必须操作工且为记录上报人本人）
 */
async function createCorrection(recordId, body, applicant) {
  const c = normalizeCorrectionInput(body);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // ① 锁生产记录（固定锁序第一条），顺带锁定其工单
    const [recRows] = await conn.query(
      `SELECT r.*, w.status AS order_status
       FROM production_records r
       JOIN work_orders w ON w.id = r.order_id
       WHERE r.id = ? FOR UPDATE`,
      [recordId]
    );
    if (recRows.length === 0) {
      throw new HttpError(404, '生产记录不存在', 'RECORD_NOT_FOUND');
    }
    const record = recRows[0];

    // ② 越权校验：只能对本人记录申请
    if (toNum(record.user_id) !== toNum(applicant.id)) {
      throw new HttpError(403, '只能对本人上报的记录提交纠错申请', 'NOT_OWN_RECORD');
    }

    // ③ 防重复申请：事务内复查（唯一索引是最终防线）
    const [pendingRows] = await conn.query(
      'SELECT id FROM record_corrections WHERE record_id = ? AND status = ?',
      [recordId, STATUSES.PENDING]
    );
    if (pendingRows.length > 0) {
      throw new HttpError(409, '该记录已有待审批的纠错申请，请勿重复提交', 'DUPLICATE_PENDING');
    }

    // ④ 修正值合法性：不能是“无变化”的申请
    if (!hasAnyChange(record, c)) {
      throw new HttpError(400, '修正后内容与原记录完全一致，无需纠错', 'NO_CHANGE');
    }

    const [result] = await conn.query(
      `INSERT INTO record_corrections
        (record_id, applicant_id,
         original_completed_qty, original_defect_qty, original_work_hours,
         original_defect_reason, original_remark,
         corrected_completed_qty, corrected_defect_qty, corrected_work_hours,
         corrected_defect_reason, corrected_remark, reason, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [recordId, applicant.id,
       toNum(record.completed_qty), toNum(record.defect_qty), toNum(record.work_hours),
       record.defect_reason || null, record.remark || null,
       c.corrected_completed_qty, c.corrected_defect_qty, c.corrected_work_hours,
       c.corrected_defect_reason, c.corrected_remark, c.reason, STATUSES.PENDING]
    );

    await conn.commit();
    return {
      id: result.insertId,
      record_id: toNum(recordId),
      status: STATUSES.PENDING,
      diff: buildDiff({
        completed_qty: toNum(record.completed_qty),
        defect_qty: toNum(record.defect_qty),
        work_hours: toNum(record.work_hours),
        defect_reason: record.defect_reason || '',
        remark: record.remark || ''
      }, {
        completed_qty: c.corrected_completed_qty,
        defect_qty: c.corrected_defect_qty,
        work_hours: c.corrected_work_hours,
        defect_reason: c.corrected_defect_reason || '',
        remark: c.corrected_remark || ''
      })
    };
  } catch (err) {
    await rollbackAndRelease(conn);
    throw mapDbError(err);
  } finally {
    try { conn.release(); } catch (e) { /* rollbackAndRelease 已释放 */ }
  }
}

/**
 * 审批纠错申请（主管）
 * @param {number} correctionId
 * @param {boolean} approve true=批准 false=驳回
 * @param {string|null} reviewComment 审批意见（驳回必填）
 * @param {object} reviewer 鉴权主管
 */
async function reviewCorrection(correctionId, approve, reviewComment, reviewer) {
  const comment = cleanText(reviewComment);
  if (!approve && !comment) {
    throw new HttpError(400, '驳回时必须填写审批意见', 'REVIEW_COMMENT_REQUIRED');
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 先读出申请，确认存在并拿到 record_id（不加锁），随后按固定顺序加锁
    const [corrRows] = await conn.query(
      'SELECT * FROM record_corrections WHERE id = ?',
      [correctionId]
    );
    if (corrRows.length === 0) {
      throw new HttpError(404, '纠错申请不存在', 'CORRECTION_NOT_FOUND');
    }
    const corr = corrRows[0];

    // ① 锁生产记录（固定锁序第一条）
    const [recRows] = await conn.query(
      'SELECT * FROM production_records WHERE id = ? FOR UPDATE',
      [corr.record_id]
    );
    if (recRows.length === 0) {
      throw new HttpError(404, '生产记录不存在', 'RECORD_NOT_FOUND');
    }
    const record = recRows[0];

    // ② 批准时锁工单（驳回不修改工单，但批准需在同一事务中重算）
    let order = null;
    if (approve) {
      const [orderRows] = await conn.query(
        'SELECT * FROM work_orders WHERE id = ? FOR UPDATE',
        [record.order_id]
      );
      if (orderRows.length === 0) {
        throw new HttpError(404, '工单不存在', 'ORDER_NOT_FOUND');
      }
      order = orderRows[0];
    }

    // ③ 锁申请（固定锁序最后一条）并复查状态
    const [lockedCorrRows] = await conn.query(
      'SELECT * FROM record_corrections WHERE id = ? FOR UPDATE',
      [correctionId]
    );
    if (toNum(lockedCorrRows[0].status) !== STATUSES.PENDING) {
      throw new HttpError(409, '该申请已被处理，请勿重复审批', 'ALREADY_REVIEWED');
    }

    const newStatus = approve ? STATUSES.APPROVED : STATUSES.REJECTED;

    // ④ 条件更新兜底：并发审批时只可能有一方 affectedRows=1
    const [updateResult] = await conn.query(
      `UPDATE record_corrections
          SET status = ?, reviewer_id = ?, review_comment = ?, reviewed_at = NOW()
        WHERE id = ? AND status = ?`,
      [newStatus, reviewer.id, comment, correctionId, STATUSES.PENDING]
    );
    if (updateResult.affectedRows !== 1) {
      throw new HttpError(409, '该申请已被处理，请勿重复审批', 'ALREADY_REVIEWED');
    }

    // ---- 驳回分支：到此结束，不改动记录与工单 ----
    if (!approve) {
      await conn.commit();
      return {
        id: toNum(correctionId),
        status: STATUSES.REJECTED,
        approved: false,
        reviewed_by: reviewer.id,
        reviewed_at: new Date()
      };
    }

    // ---- 批准分支：生成不可变修订并重算工单 ----

    // ⑤ 记录更新为修正值，版本号 +1（触发器保证 id/order_id/user_id/created_at 不可变）
    const oldVersion = toNum(record.current_version);
    const newVersion = oldVersion + 1;
    await conn.query(
      `UPDATE production_records
          SET completed_qty = ?,
              defect_qty = ?,
              work_hours = ?,
              defect_reason = ?,
              remark = ?,
              current_version = current_version + 1,
              last_revised_at = NOW()
        WHERE id = ?`,
      [corr.corrected_completed_qty, corr.corrected_defect_qty, corr.corrected_work_hours,
       corr.corrected_defect_reason, corr.corrected_remark, corr.record_id]
    );

    // ⑥ 按全部最新有效记录重新汇总工单
    const [allRecords] = await conn.query(
      'SELECT completed_qty, defect_qty, work_hours FROM production_records WHERE order_id = ?',
      [order.id]
    );
    const summary = summarizeRecords(allRecords, order.defect_threshold);
    const newOrderStatus = deriveOrderStatus(order.status, summary);

    // ⑦ 更新工单：完成数/不良数/工时/状态（必要时回填开始时间），告警由读出时推导
    const oldOrder = {
      completed_qty: toNum(order.completed_qty),
      defect_qty: toNum(order.defect_qty),
      work_hours: toNum(order.total_work_hours),
      status: toNum(order.status)
    };
    await conn.query(
      `UPDATE work_orders
          SET completed_qty = ?,
              defect_qty = ?,
              total_work_hours = ?,
              status = ?,
              start_time = IF(? = 1 AND start_time IS NULL, NOW(), start_time)
        WHERE id = ?`,
      [summary.completed_qty, summary.defect_qty, summary.work_hours,
       newOrderStatus, newOrderStatus, order.id]
    );

    // ⑧ 写入不可变修订版本快照（之后任何 UPDATE/DELETE 被触发器拒绝）
    await conn.query(
      `INSERT INTO record_revisions
        (record_id, correction_id, version_no,
         old_completed_qty, new_completed_qty,
         old_defect_qty, new_defect_qty,
         old_work_hours, new_work_hours,
         old_defect_reason, new_defect_reason,
         old_remark, new_remark,
         old_order_completed_qty, new_order_completed_qty,
         old_order_defect_qty, new_order_defect_qty,
         old_order_work_hours, new_order_work_hours,
         old_order_status, new_order_status,
         approved_by, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [corr.record_id, correctionId, newVersion,
       toNum(corr.original_completed_qty), corr.corrected_completed_qty,
       toNum(corr.original_defect_qty), corr.corrected_defect_qty,
       toNum(corr.original_work_hours), corr.corrected_work_hours,
       corr.original_defect_reason, corr.corrected_defect_reason,
       corr.original_remark, corr.corrected_remark,
       oldOrder.completed_qty, summary.completed_qty,
       oldOrder.defect_qty, summary.defect_qty,
       oldOrder.work_hours, summary.work_hours,
       oldOrder.status, newOrderStatus,
       reviewer.id]
    );

    await conn.commit();

    return {
      id: toNum(correctionId),
      status: STATUSES.APPROVED,
      approved: true,
      version_no: newVersion,
      reviewed_by: reviewer.id,
      reviewed_at: new Date(),
      record: {
        id: toNum(corr.record_id),
        completed_qty: corr.corrected_completed_qty,
        defect_qty: corr.corrected_defect_qty,
        work_hours: corr.corrected_work_hours,
        current_version: newVersion
      },
      work_order: {
        id: toNum(order.id),
        order_no: order.order_no,
        completed_qty: summary.completed_qty,
        defect_qty: summary.defect_qty,
        total_work_hours: summary.work_hours,
        status: newOrderStatus,
        defect_rate: summary.defect_rate,
        defect_threshold: toNum(order.defect_threshold),
        defect_alert: summary.defect_alert
      }
    };
  } catch (err) {
    await rollbackAndRelease(conn);
    throw mapDbError(err);
  } finally {
    try { conn.release(); } catch (e) { /* rollbackAndRelease 已释放 */ }
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

const LIST_SELECT = `
  SELECT c.*,
         w.order_no, w.status AS order_status,
         l.line_name,
         p.product_name, p.product_model,
         ua.real_name AS applicant_name,
         ur.real_name AS reviewer_name,
         r.current_version AS record_version
  FROM record_corrections c
  JOIN production_records r ON r.id = c.record_id
  JOIN work_orders w ON w.id = r.order_id
  LEFT JOIN production_lines l ON w.line_id = l.id
  LEFT JOIN products p ON w.product_id = p.id
  JOIN users ua ON ua.id = c.applicant_id
  LEFT JOIN users ur ON ur.id = c.reviewer_id
`;

function serializeCorrection(c) {
  return {
    id: toNum(c.id),
    record_id: toNum(c.record_id),
    applicant_id: toNum(c.applicant_id),
    applicant_name: c.applicant_name,
    order_no: c.order_no,
    order_status: toNum(c.order_status),
    line_name: c.line_name,
    product_name: c.product_name,
    product_model: c.product_model,
    original_completed_qty: toNum(c.original_completed_qty),
    original_defect_qty: toNum(c.original_defect_qty),
    original_work_hours: toNum(c.original_work_hours),
    original_defect_reason: c.original_defect_reason,
    original_remark: c.original_remark,
    corrected_completed_qty: toNum(c.corrected_completed_qty),
    corrected_defect_qty: toNum(c.corrected_defect_qty),
    corrected_work_hours: toNum(c.corrected_work_hours),
    corrected_defect_reason: c.corrected_defect_reason,
    corrected_remark: c.corrected_remark,
    reason: c.reason,
    status: toNum(c.status),
    reviewer_id: c.reviewer_id === null || c.reviewer_id === undefined ? null : toNum(c.reviewer_id),
    reviewer_name: c.reviewer_name || null,
    review_comment: c.review_comment,
    record_version: toNum(c.record_version),
    created_at: c.created_at,
    reviewed_at: c.reviewed_at
  };
}

async function listCorrections(query, authUser) {
  const { status, record_id, applicant_id, page = 1, pageSize = 20 } = query;
  const where = [];
  const params = [];

  // 操作工只能看到本人的申请；主管看全部
  if (toNum(authUser.role) === 2) {
    where.push('c.applicant_id = ?');
    params.push(authUser.id);
  } else if (applicant_id) {
    where.push('c.applicant_id = ?');
    params.push(applicant_id);
  }
  if (status !== undefined && status !== '' && status !== null) {
    where.push('c.status = ?');
    params.push(toNum(status));
  }
  if (record_id) {
    where.push('c.record_id = ?');
    params.push(record_id);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const limit = Math.min(toNum(pageSize) || 20, 200);
  const offset = ((toNum(page) || 1) - 1) * limit;

  const [rows] = await pool.query(
    `${LIST_SELECT}${whereSql} ORDER BY c.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const [countRows] = await pool.query(
    `SELECT COUNT(*) AS total FROM record_corrections c${whereSql}`,
    params
  );

  return {
    data: rows.map(serializeCorrection),
    total: toNum(countRows[0].total),
    page: toNum(page) || 1,
    pageSize: limit
  };
}

async function getCorrection(correctionId, authUser) {
  const [rows] = await pool.query(`${LIST_SELECT} WHERE c.id = ?`, [correctionId]);
  if (rows.length === 0) {
    throw new HttpError(404, '纠错申请不存在', 'CORRECTION_NOT_FOUND');
  }
  const c = rows[0];
  // 操作工仅可查看本人申请
  if (toNum(authUser.role) === 2 && toNum(c.applicant_id) !== toNum(authUser.id)) {
    throw new HttpError(403, '无权查看该纠错申请', 'FORBIDDEN');
  }
  const correction = serializeCorrection(c);
  correction.diff = buildDiff(
    {
      completed_qty: correction.original_completed_qty,
      defect_qty: correction.original_defect_qty,
      work_hours: correction.original_work_hours,
      defect_reason: correction.original_defect_reason || '',
      remark: correction.original_remark || ''
    },
    {
      completed_qty: correction.corrected_completed_qty,
      defect_qty: correction.corrected_defect_qty,
      work_hours: correction.corrected_work_hours,
      defect_reason: correction.corrected_defect_reason || '',
      remark: correction.corrected_remark || ''
    }
  );
  correction.current_record = {
    completed_qty: toNum(c.record_version) > 0 ? correction.corrected_completed_qty : correction.original_completed_qty,
    defect_qty: toNum(c.record_version) > 0 ? correction.corrected_defect_qty : correction.original_defect_qty,
    work_hours: toNum(c.record_version) > 0 ? correction.corrected_work_hours : correction.original_work_hours,
    current_version: toNum(c.record_version)
  };
  return correction;
}

/**
 * 修订时间线：原始上报 + 每个已批准修订版本（按版本升序）
 * 权限由路由层保证（主管，或记录本人）。
 */
async function getTimeline(recordId, authUser) {
  const [recRows] = await pool.query(
    `SELECT r.*, w.order_no, u.real_name AS user_name
       FROM production_records r
       JOIN work_orders w ON w.id = r.order_id
       JOIN users u ON u.id = r.user_id
      WHERE r.id = ?`,
    [recordId]
  );
  if (recRows.length === 0) {
    throw new HttpError(404, '生产记录不存在', 'RECORD_NOT_FOUND');
  }
  const r = recRows[0];
  if (toNum(authUser.role) === 2 && toNum(r.user_id) !== toNum(authUser.id)) {
    throw new HttpError(403, '无权查看该记录的修订历史', 'FORBIDDEN');
  }

  const [revRows] = await pool.query(
    `SELECT rv.*, u.real_name AS approver_name, c.reason
       FROM record_revisions rv
       JOIN users u ON u.id = rv.approved_by
       JOIN record_corrections c ON c.id = rv.correction_id
      WHERE rv.record_id = ?
      ORDER BY rv.version_no ASC`,
    [recordId]
  );

  // 起点：原始上报
  const timeline = [{
    version_no: 0,
    title: '原始上报',
    completed_qty: revRows.length > 0 ? toNum(revRows[0].old_completed_qty) : toNum(r.completed_qty),
    defect_qty: revRows.length > 0 ? toNum(revRows[0].old_defect_qty) : toNum(r.defect_qty),
    work_hours: revRows.length > 0 ? toNum(revRows[0].old_work_hours) : toNum(r.work_hours),
    defect_reason: revRows.length > 0 ? revRows[0].old_defect_reason : r.defect_reason,
    remark: revRows.length > 0 ? revRows[0].old_remark : r.remark,
    operator_name: r.user_name,
    operated_at: r.created_at,
    reason: null
  }];

  revRows.forEach((rv) => {
    timeline.push({
      version_no: toNum(rv.version_no),
      title: `第 ${rv.version_no} 次修订（纠错批准）`,
      correction_id: toNum(rv.correction_id),
      completed_qty: toNum(rv.new_completed_qty),
      defect_qty: toNum(rv.new_defect_qty),
      work_hours: toNum(rv.new_work_hours),
      defect_reason: rv.new_defect_reason,
      remark: rv.new_remark,
      approver_name: rv.approver_name,
      operated_at: rv.approved_at,
      reason: rv.reason,
      order_snapshot: {
        old_completed_qty: toNum(rv.old_order_completed_qty),
        new_completed_qty: toNum(rv.new_order_completed_qty),
        old_defect_qty: toNum(rv.old_order_defect_qty),
        new_defect_qty: toNum(rv.new_order_defect_qty),
        old_work_hours: toNum(rv.old_order_work_hours),
        new_work_hours: toNum(rv.new_order_work_hours),
        old_status: toNum(rv.old_order_status),
        new_status: toNum(rv.new_order_status)
      }
    });
  });

  return {
    record_id: toNum(recordId),
    order_no: r.order_no,
    current_version: toNum(r.current_version),
    last_revised_at: r.last_revised_at,
    timeline
  };
}

module.exports = {
  STATUSES,
  createCorrection,
  reviewCorrection,
  listCorrections,
  getCorrection,
  getTimeline,
  // 导出供事务回滚集成测试复用
  normalizeCorrectionInput,
  hasAnyChange,
  rollbackAndRelease
};
