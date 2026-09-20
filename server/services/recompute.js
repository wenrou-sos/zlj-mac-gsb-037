/**
 * 工单重算纯逻辑（不依赖数据库，便于单元测试）
 * 纠错批准后，工单的完成数/不良数/工时/状态均按“全部最新有效生产记录”重新计算。
 */

const toNum = (v) => (v === null || v === undefined || v === '') ? 0 : Number(v);

function round2(n) {
  // 与历史代码口径一致：四舍五入保留 2 位小数
  return +Number(n).toFixed(2);
}

/**
 * 按全部最新有效记录汇总工单指标
 * @param {Array<{completed_qty:number, defect_qty:number, work_hours:number}>} records
 * @returns {{completed_qty:number, defect_qty:number, work_hours:number,
 *            defect_rate:number, defect_alert:boolean}}
 */
function summarizeRecords(records, defectThreshold = 5) {
  let completed = 0;
  let defect = 0;
  let hours = 0;
  for (const r of records || []) {
    completed += toNum(r.completed_qty);
    defect += toNum(r.defect_qty);
    hours += toNum(r.work_hours);
  }
  const total = completed + defect;
  const defectRate = total > 0 ? round2((defect / total) * 100) : 0;
  const threshold = defectThreshold === null || defectThreshold === undefined ? 5 : toNum(defectThreshold);
  return {
    completed_qty: completed,
    defect_qty: defect,
    work_hours: round2(hours),
    defect_rate: defectRate,
    defect_alert: total > 0 && defectRate > threshold
  };
}

/**
 * 重算工单状态
 * 规则（不覆盖主管的人工决策）：
 *   - 当前状态为 已完成(2)/已暂停(3)：保持不变
 *   - 当前状态为 待生产(0)/生产中(1)：
 *       全部有效记录的完成数+不良数+工时均为 0 => 待生产(0)（纠错把工单“改回”未投产）
 *       否则 => 生产中(1)
 * @param {number} currentStatus 工单当前状态
 * @param {{completed_qty:number, defect_qty:number, work_hours:number}} summary
 * @returns {number}
 */
function deriveOrderStatus(currentStatus, summary) {
  const status = toNum(currentStatus);
  if (status === 2 || status === 3) return status;
  const hasActivity = toNum(summary.completed_qty) > 0
    || toNum(summary.defect_qty) > 0
    || toNum(summary.work_hours) > 0;
  return hasActivity ? 1 : 0;
}

/** 是否应记录实际开始时间：已有活动量且 start_time 为空时回填 */
function shouldSetStartTime(order, summary) {
  if (order && order.start_time !== null && order.start_time !== undefined) return false;
  return toNum(summary.completed_qty) > 0
    || toNum(summary.defect_qty) > 0
    || toNum(summary.work_hours) > 0;
}

/**
 * 计算一条申请的字段差异
 * @returns {Array<{field:string, label:string, oldValue:*, newValue:*, changed:boolean}>}
 */
function buildDiff(original, corrected) {
  const fields = [
    { field: 'completed_qty', label: '完成数' },
    { field: 'defect_qty', label: '不良数' },
    { field: 'work_hours', label: '工时(h)' },
    { field: 'defect_reason', label: '不良原因' },
    { field: 'remark', label: '备注' }
  ];
  return fields.map(({ field, label }) => {
    let oldValue = original[field];
    let newValue = corrected[field];
    if (field === 'work_hours') {
      oldValue = toNum(oldValue);
      newValue = toNum(newValue);
    }
    if (field === 'completed_qty' || field === 'defect_qty') {
      oldValue = toNum(oldValue);
      newValue = toNum(newValue);
    }
    oldValue = oldValue === null ? '' : oldValue;
    newValue = newValue === null ? '' : newValue;
    return {
      field,
      label,
      oldValue,
      newValue,
      changed: String(oldValue) !== String(newValue)
    };
  });
}

module.exports = { toNum, round2, summarizeRecords, deriveOrderStatus, shouldSetStartTime, buildDiff };
