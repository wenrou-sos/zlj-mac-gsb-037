const router = require('express').Router();
const correctionsService = require('../services/corrections');
const { authRequired, requireRole } = require('../middleware/auth');

const ROLE_MANAGER = 1;
const ROLE_WORKER = 2;

function handle(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// 所有纠错接口都必须登录
router.use(authRequired);

// 申请列表：主管看全部（可按申请人筛选），操作工仅本人（服务内强制过滤）
router.get('/', handle(async (req, res) => {
  const result = await correctionsService.listCorrections(req.query, req.authUser);
  res.json({ success: true, ...result });
}));

// 修订时间线：主管或记录本人（服务内校验记录归属）
router.get('/records/:id/timeline', handle(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: '无效的生产记录ID' });
  }
  const result = await correctionsService.getTimeline(id, req.authUser);
  res.json({ success: true, data: result });
}));

// 申请详情：主管或申请人本人（服务内校验）
router.get('/:id', handle(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: '无效的申请ID' });
  }
  const result = await correctionsService.getCorrection(id, req.authUser);
  res.json({ success: true, data: result });
}));

// 提交纠错申请：仅操作工，且只能对本人记录（服务内校验归属）
router.post('/', requireRole(ROLE_WORKER), handle(async (req, res) => {
  const recordId = req.body.record_id;
  if (recordId === undefined || recordId === null || !Number.isInteger(Number(recordId))) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: '缺少有效的生产记录ID' });
  }
  const result = await correctionsService.createCorrection(Number(recordId), req.body, req.authUser);
  res.status(201).json({ success: true, message: '纠错申请已提交，等待主管审批', data: result });
}));

// 批准：仅主管
router.post('/:id/approve', requireRole(ROLE_MANAGER), handle(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: '无效的申请ID' });
  }
  const result = await correctionsService.reviewCorrection(
    id, true, (req.body || {}).review_comment, req.authUser
  );
  const message = result.work_order.defect_alert
    ? `已批准并生效（版本 v${result.version_no}），重算后工单不良率 ${result.work_order.defect_rate}% 仍超过阈值 ${result.work_order.defect_threshold}%`
    : `已批准并生效（版本 v${result.version_no}），工单数据已按最新有效记录重算`;
  res.json({ success: true, message, data: result });
}));

// 驳回：仅主管，审批意见必填
router.post('/:id/reject', requireRole(ROLE_MANAGER), handle(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ success: false, code: 'VALIDATION_ERROR', message: '无效的申请ID' });
  }
  const result = await correctionsService.reviewCorrection(
    id, false, (req.body || {}).review_comment, req.authUser
  );
  res.json({ success: true, message: '已驳回该纠错申请', data: result });
}));

module.exports = router;
