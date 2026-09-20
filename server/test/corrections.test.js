/**
 * 生产记录纠错审批 - 集成测试
 *
 * 覆盖：权限校验、重复/并发申请、批准重算、重复/并发审批、
 *       事务回滚、修订不可变性、修订时间线、状态筛选。
 *
 * 运行前提：MySQL 可用且已按 server/.env 配置（数据库已 init）。
 * 运行方式：
 *   cd server
 *   node test/corrections.test.js
 * 说明：测试会先幂等应用迁移脚本；若 3002 端口无服务则自动在进程内启动。
 */
const assert = require('assert');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = process.env.TEST_PORT || 3002;
const BASE = `http://localhost:${PORT}/api`;

function request(method, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + reqPath);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
        catch (e) { resolve({ status: res.statusCode, body: chunks }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const auth = (uid) => ({ 'x-user-id': String(uid) });

function test(name, fn) {
  return fn()
    .then(() => { console.log('  ✅ PASS', name); return true; })
    .catch((e) => { console.log('  ❌ FAIL', name, '\n     ', e.message); return false; });
}

async function run() {
  console.log('\n=== 纠错审批 集成测试 ===\n');

  // ---------- 0. 准备：应用迁移（幂等） ----------
  const mysql = require('mysql2/promise');
  const { execSqlFile } = require('../utils/execSqlFile');
  try {
    const migConn = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || ''
    });
    await execSqlFile(migConn, path.join(__dirname, '..', 'sql', 'migrate_20260920_record_corrections.sql'));
    await migConn.end();
    console.log('  📦 迁移脚本已应用（幂等）\n');
  } catch (e) {
    console.error('  ❌ 迁移失败:', e.message);
    console.error('     请确认 MySQL 已启动、server/.env 配置正确、数据库已初始化(npm run init:db)');
    process.exit(1);
  }

  // ---------- 1. 确保 API 服务可用 ----------
  let server = null;
  try {
    await request('GET', '/health');
  } catch (e) {
    const app = require('../app');
    server = app.listen(PORT);
    await new Promise((resolve) => server.on('listening', resolve));
    console.log(`  🚀 已在进程内启动测试服务 :${PORT}\n`);
  }
  const pool = require('../config/db');

  let pass = 0, fail = 0;
  const t = async (name, fn) => { (await test(name, fn)) ? pass++ : fail++; };

  // ---------- 2. 登录获取账号 ----------
  let adminId, w1Id, w2Id;
  await t('登录 admin / worker01 / worker02', async () => {
    const a = await request('POST', '/users/login', { username: 'admin', password: '123456' });
    const w1 = await request('POST', '/users/login', { username: 'worker01', password: '123456' });
    const w2 = await request('POST', '/users/login', { username: 'worker02', password: '123456' });
    assert.ok(a.body.success && w1.body.success && w2.body.success);
    adminId = a.body.data.id; w1Id = w1.body.data.id; w2Id = w2.body.data.id;
  });

  // ---------- 3. 构造测试工单与记录 ----------
  let orderId, R1, R2;
  await t('准备：创建工单并上报两条记录 (50/2/4h, 30/1/3h)', async () => {
    const o = await request('POST', '/workorders', {
      line_id: 1, product_id: 1, plan_qty: 100, assigned_by: adminId, remark: '纠错审批测试工单'
    });
    assert.ok(o.body.success);
    orderId = o.body.data.id;

    const r1 = await request('POST', '/records', {
      order_id: orderId, user_id: w1Id, completed_qty: 50, defect_qty: 2, work_hours: 4, remark: '纠错测试R1'
    });
    const r2 = await request('POST', '/records', {
      order_id: orderId, user_id: w1Id, completed_qty: 30, defect_qty: 1, work_hours: 3, remark: '纠错测试R2'
    });
    assert.ok(r1.body.success && r2.body.success);
    R1 = r1.body.data.id; R2 = r2.body.data.id;

    const d = await request('GET', `/workorders/${orderId}`);
    assert.strictEqual(d.body.data.completed_qty, 80);
    assert.strictEqual(d.body.data.defect_qty, 3);
    assert.strictEqual(d.body.data.status, 1);
  });

  // ---------- 4. 权限校验 ----------
  await t('【权限】未登录提交申请 => 401', async () => {
    const r = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 45, new_defect_qty: 2, new_work_hours: 4, reason: 'x'
    });
    assert.strictEqual(r.status, 401);
  });

  await t('【权限】主管提交纠错申请 => 403', async () => {
    const r = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 45, new_defect_qty: 2, new_work_hours: 4, reason: 'x'
    }, auth(adminId));
    assert.strictEqual(r.status, 403);
  });

  await t('【权限】操作工对他人记录申请 => 403', async () => {
    const r = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 45, new_defect_qty: 2, new_work_hours: 4, reason: 'x'
    }, auth(w2Id));
    assert.strictEqual(r.status, 403);
  });

  await t('【权限】未登录查询列表 => 401', async () => {
    const r = await request('GET', '/corrections');
    assert.strictEqual(r.status, 401);
  });

  await t('【校验】修正值与生效值一致 => 400', async () => {
    const r = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 50, new_defect_qty: 2, new_work_hours: 4, reason: '无变化'
    }, auth(w1Id));
    assert.strictEqual(r.status, 400);
    assert.ok(/无需纠错/.test(r.body.message));
  });

  await t('【校验】修正后完成与不良同时为0 => 400；缺纠错原因 => 400', async () => {
    const r1 = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 0, new_defect_qty: 0, new_work_hours: 4, reason: 'x'
    }, auth(w1Id));
    assert.strictEqual(r1.status, 400);
    const r2 = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 45, new_defect_qty: 2, new_work_hours: 4
    }, auth(w1Id));
    assert.strictEqual(r2.status, 400);
  });

  // ---------- 5. 正常申请 + 防重复/并发申请 ----------
  let req1Id;
  await t('提交纠错申请 R1: (50,2,4)->(45,5,4.5) 成功', async () => {
    const r = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 45, new_defect_qty: 5, new_work_hours: 4.5,
      new_defect_reason: '来料不良', reason: '完成数与不良数填报错误'
    }, auth(w1Id));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.success);
    assert.ok(r.body.data.id > 0);
    assert.ok(/^CR\d+/.test(r.body.data.request_no));
    req1Id = r.body.data.id;
  });

  await t('【防重复】同一记录重复提交 => 409', async () => {
    const r = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 40, new_defect_qty: 5, new_work_hours: 4, reason: '重复提交'
    }, auth(w1Id));
    assert.strictEqual(r.status, 409);
    assert.ok(/重复|待审批/.test(r.body.message));
  });

  let reqR2Id;
  await t('【并发】5个并发申请同一记录 => 仅1个成功，其余409', async () => {
    const body = {
      record_id: R2, new_completed_qty: 28, new_defect_qty: 1, new_work_hours: 3, reason: '并发申请测试'
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request('POST', '/corrections', body, auth(w1Id)))
    );
    const ok = results.filter(r => r.status === 200);
    const conflicts = results.filter(r => r.status === 409);
    assert.strictEqual(ok.length, 1, `应仅1个成功，实际 ${ok.length} 个 (${results.map(r => r.status).join(',')})`);
    assert.strictEqual(conflicts.length, 4, `其余应为409，实际 ${conflicts.length} 个`);
    reqR2Id = ok[0].body.data.id;

    // 数据库层确认：同一记录最多一条待审批
    const [pend] = await pool.query(
      'SELECT COUNT(*) AS c FROM record_correction_requests WHERE record_id = ? AND status = 0', [R2]);
    assert.strictEqual(Number(pend[0].c), 1);
  });

  // ---------- 6. 审批权限 ----------
  await t('【权限】操作工批准 => 403；未登录批准 => 401', async () => {
    const r1 = await request('POST', `/corrections/${req1Id}/approve`, {}, auth(w1Id));
    assert.strictEqual(r1.status, 403);
    const r2 = await request('POST', `/corrections/${req1Id}/approve`, {});
    assert.strictEqual(r2.status, 401);
  });

  await t('【权限】操作工列表仅见本人申请', async () => {
    const r = await request('GET', '/corrections?pageSize=100', null, auth(w1Id));
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.data.length > 0);
    r.body.data.forEach(row => assert.strictEqual(row.applicant_id, w1Id));
  });

  await t('【权限】操作工查看他人申请详情 => 403', async () => {
    const r = await request('GET', `/corrections/${req1Id}`, null, auth(w2Id));
    assert.strictEqual(r.status, 403);
  });

  // ---------- 7. 驳回流程 ----------
  await t('驳回 R2 申请：状态=已驳回，工单数据不变，无修订版本', async () => {
    const r = await request('POST', `/corrections/${reqR2Id}/reject`,
      { review_comment: '请补充说明后重新提交' }, auth(adminId));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const d = await request('GET', `/corrections/${reqR2Id}`, null, auth(adminId));
    assert.strictEqual(d.body.data.status, 2);
    assert.strictEqual(d.body.data.review_comment, '请补充说明后重新提交');
    assert.strictEqual(d.body.data.reviewer_name, '张主管');

    const o = await request('GET', `/workorders/${orderId}`);
    assert.strictEqual(o.body.data.completed_qty, 80, '驳回后完成数不应变化');
    assert.strictEqual(o.body.data.defect_qty, 3);

    const [revs] = await pool.query('SELECT COUNT(*) AS c FROM record_revisions WHERE record_id = ?', [R2]);
    assert.strictEqual(Number(revs[0].c), 0, '驳回不应产生修订版本');
  });

  await t('【权限】驳回缺少审批意见 => 400', async () => {
    const r = await request('POST', `/corrections/${reqR2Id}/reject`, { review_comment: '' }, auth(adminId));
    assert.strictEqual(r.status, 400);
  });

  await t('驳回后可重新申请（驳回释放待审批占位）', async () => {
    const r = await request('POST', '/corrections', {
      record_id: R2, new_completed_qty: 28, new_defect_qty: 1, new_work_hours: 3, reason: '重新提交'
    }, auth(w1Id));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // 清理：再次驳回，释放 R2 供后续并发批准测试
    const rr = await request('POST', `/corrections/${r.body.data.id}/reject`,
      { review_comment: '暂不处理' }, auth(adminId));
    assert.strictEqual(rr.status, 200);
  });

  // ---------- 8. 批准 + 数据重算 ----------
  await t('批准 R1 申请：生成修订版本并按最新有效记录重算工单', async () => {
    const r = await request('POST', `/corrections/${req1Id}/approve`,
      { review_comment: '同意修正' }, auth(adminId));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.data.revision_no, 1);
    // 重算：R1(45,5,4.5) + R2(30,1,3) => 75/6/7.5h
    const o = r.body.data.order;
    assert.strictEqual(o.completed_qty, 75);
    assert.strictEqual(o.defect_qty, 6);
    assert.strictEqual(Number(o.total_work_hours), 7.5);
    assert.strictEqual(o.defect_rate, +((6 / 81) * 100).toFixed(2));
    assert.strictEqual(o.defect_alert, true, '不良率7.41%超过阈值5%应告警');
    assert.strictEqual(r.body.warning, true);

    const d = await request('GET', `/workorders/${orderId}`);
    assert.strictEqual(d.body.data.completed_qty, 75);
    assert.strictEqual(d.body.data.defect_qty, 6);
    assert.strictEqual(d.body.data.total_work_hours, 7.5);
    assert.strictEqual(d.body.data.defect_alert, true);
    assert.strictEqual(d.body.data.status, 1);
  });

  await t('批准后：原记录不变，生效指针指向修订版本，记录列表返回生效值', async () => {
    const [recs] = await pool.query('SELECT * FROM production_records WHERE id = ?', [R1]);
    assert.strictEqual(Number(recs[0].completed_qty), 50, '原记录完成数不可被修改');
    assert.strictEqual(Number(recs[0].defect_qty), 2);
    assert.ok(recs[0].current_revision_id, '应设置生效修订指针');

    const [revs] = await pool.query('SELECT * FROM record_revisions WHERE record_id = ?', [R1]);
    assert.strictEqual(revs.length, 1);
    assert.strictEqual(Number(revs[0].revision_no), 1);
    assert.strictEqual(Number(revs[0].completed_qty), 45);
    assert.strictEqual(Number(revs[0].defect_qty), 5);
    assert.strictEqual(Number(revs[0].work_hours), 4.5);
    assert.strictEqual(revs[0].id, recs[0].current_revision_id);

    const list = await request('GET', `/records?order_id=${orderId}&pageSize=50`);
    const row1 = list.body.data.find(x => x.id === R1);
    assert.strictEqual(row1.revision_no, 1);
    assert.strictEqual(row1.effective_completed_qty, 45);
    assert.strictEqual(row1.effective_defect_qty, 5);
    assert.strictEqual(Number(row1.effective_work_hours), 4.5);
    assert.strictEqual(row1.completed_qty, 50, '原始值字段保持原值');
    const row2 = list.body.data.find(x => x.id === R2);
    assert.strictEqual(row2.revision_no, 0);
    assert.strictEqual(row2.effective_completed_qty, 30);
  });

  // ---------- 9. 重复/并发审批 ----------
  await t('【防重复审批】重复批准/驳回已处理申请 => 409', async () => {
    const r1 = await request('POST', `/corrections/${req1Id}/approve`, {}, auth(adminId));
    assert.strictEqual(r1.status, 409);
    const r2 = await request('POST', `/corrections/${req1Id}/reject`,
      { review_comment: 'x' }, auth(adminId));
    assert.strictEqual(r2.status, 409);
  });

  let reqR2cId;
  await t('【并发审批】两个并发批准 => 一个200一个409，仅产生一个修订版本', async () => {
    const c = await request('POST', '/corrections', {
      record_id: R2, new_completed_qty: 25, new_defect_qty: 1, new_work_hours: 3, reason: '并发批准测试'
    }, auth(w1Id));
    assert.strictEqual(c.status, 200);
    reqR2cId = c.body.data.id;

    const results = await Promise.all([
      request('POST', `/corrections/${reqR2cId}/approve`, { review_comment: 'A' }, auth(adminId)),
      request('POST', `/corrections/${reqR2cId}/approve`, { review_comment: 'B' }, auth(adminId))
    ]);
    const ok = results.filter(r => r.status === 200);
    const conflicts = results.filter(r => r.status === 409);
    assert.strictEqual(ok.length, 1, `应仅1个批准成功，实际 ${ok.length} (${results.map(r => r.status).join(',')})`);
    assert.strictEqual(conflicts.length, 1);

    const [revs] = await pool.query('SELECT COUNT(*) AS c FROM record_revisions WHERE record_id = ?', [R2]);
    assert.strictEqual(Number(revs[0].c), 1, '并发批准只能产生一个修订版本');

    // 重算恰好执行一次：R1(45,5) + R2(25,1) => 70/6
    const d = await request('GET', `/workorders/${orderId}`);
    assert.strictEqual(d.body.data.completed_qty, 70);
    assert.strictEqual(d.body.data.defect_qty, 6);
  });

  // ---------- 10. 二次纠错：基于最新生效值 ----------
  let req1bId;
  await t('二次纠错：申请快照为最新生效值(45)，批准后版本号递增并重算', async () => {
    const c = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 40, new_defect_qty: 5, new_work_hours: 4.5, reason: '完成数仍需调整'
    }, auth(w1Id));
    assert.strictEqual(c.status, 200, JSON.stringify(c.body));
    req1bId = c.body.data.id;

    const d = await request('GET', `/corrections/${req1bId}`, null, auth(w1Id));
    assert.strictEqual(d.body.data.old_completed_qty, 45, '快照应为当前生效值45而非原始值50');

    const r = await request('POST', `/corrections/${req1bId}/approve`, {}, auth(adminId));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.revision_no, 2);
    // R1(40,5,4.5) + R2(25,1,3) => 65/6/7.5
    assert.strictEqual(r.body.data.order.completed_qty, 65);
    assert.strictEqual(r.body.data.order.defect_qty, 6);

    const [revs] = await pool.query(
      'SELECT COUNT(*) AS c, MAX(revision_no) AS m FROM record_revisions WHERE record_id = ?', [R1]);
    assert.strictEqual(Number(revs[0].c), 2);
    assert.strictEqual(Number(revs[0].m), 2);
  });

  // ---------- 11. 事务回滚 ----------
  let reqRbId;
  await t('【回滚】批准中途失败 => 完整回滚（修订/指针/工单均不变，申请保持待审批）', async () => {
    const [modeRows] = await pool.query('SELECT @@sql_mode AS mode');
    if (!/STRICT/.test(modeRows[0].mode)) {
      console.log('     ⚠ 当前 sql_mode 非严格模式，跳过（默认安装的 MySQL 5.7+/8.0 均为严格模式）');
      return;
    }
    const c = await request('POST', '/corrections', {
      record_id: R1, new_completed_qty: 55, new_defect_qty: 5, new_work_hours: 4.5, reason: '回滚测试'
    }, auth(w1Id));
    assert.strictEqual(c.status, 200);
    reqRbId = c.body.data.id;

    const [before] = await pool.query(
      'SELECT completed_qty, defect_qty FROM work_orders WHERE id = ?', [orderId]);

    // 审批意见600字 > VARCHAR(500)：在修订插入之后失败，必须整体回滚
    const r = await request('POST', `/corrections/${reqRbId}/approve`,
      { review_comment: 'x'.repeat(600) }, auth(adminId));
    assert.strictEqual(r.status, 400, `超长审批意见应返回400，实际 ${r.status}: ${JSON.stringify(r.body)}`);

    const d = await request('GET', `/corrections/${reqRbId}`, null, auth(adminId));
    assert.strictEqual(d.body.data.status, 0, '失败后申请应保持待审批');

    const [revs] = await pool.query(
      'SELECT COUNT(*) AS c FROM record_revisions WHERE record_id = ?', [R1]);
    assert.strictEqual(Number(revs[0].c), 2, '失败事务不得残留修订版本');

    const [recs] = await pool.query('SELECT current_revision_id FROM production_records WHERE id = ?', [R1]);
    const [revs2] = await pool.query('SELECT id FROM record_revisions WHERE record_id = ? AND revision_no = 2', [R1]);
    assert.strictEqual(recs[0].current_revision_id, revs2[0].id, '生效指针不应变化');

    const [after] = await pool.query(
      'SELECT completed_qty, defect_qty FROM work_orders WHERE id = ?', [orderId]);
    assert.strictEqual(Number(after[0].completed_qty), Number(before[0].completed_qty), '工单完成数应回滚');
    assert.strictEqual(Number(after[0].defect_qty), Number(before[0].defect_qty));
  });

  await t('【回滚】失败后可正常重新批准，数据一致', async () => {
    if (!reqRbId) { console.log('     ⚠ 跳过（上一步未执行）'); return; }
    const r = await request('POST', `/corrections/${reqRbId}/approve`,
      { review_comment: '重新批准' }, auth(adminId));
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // R1(55,5,4.5) + R2(25,1,3) => 80/6/7.5
    assert.strictEqual(r.body.data.order.completed_qty, 80);
    assert.strictEqual(r.body.data.order.defect_qty, 6);
    const [revs] = await pool.query(
      'SELECT COUNT(*) AS c FROM record_revisions WHERE record_id = ?', [R1]);
    assert.strictEqual(Number(revs[0].c), 3);
  });

  await t('【回滚】数据库级验证：模拟批准事务中途FK失败，全部回滚', async () => {
    // 造一条待审批申请用于模拟
    const c = await request('POST', '/corrections', {
      record_id: R2, new_completed_qty: 26, new_defect_qty: 1, new_work_hours: 3, reason: 'DB回滚测试'
    }, auth(w1Id));
    assert.strictEqual(c.status, 200);
    const tmpReqId = c.body.data.id;

    const conn = await pool.getConnection();
    let err = null;
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO record_revisions
         (record_id, request_id, revision_no, completed_qty, defect_qty, work_hours, changed_by)
         VALUES (?, ?, 99, 1, 0, 1, ?)`, [R2, tmpReqId, adminId]);
      await conn.query(
        'UPDATE production_records SET current_revision_id = LAST_INSERT_ID() WHERE id = ?', [R2]);
      // 注入失败：审批人不存在，违反外键
      await conn.query(
        'UPDATE record_correction_requests SET status = 1, reviewed_by = 999999 WHERE id = ?', [tmpReqId]);
      await conn.commit();
    } catch (e) {
      err = e;
      await conn.rollback();
    } finally {
      conn.release();
    }
    assert.ok(err, '外键约束应使事务失败');
    assert.strictEqual(err.code, 'ER_NO_REFERENCED_ROW_2');

    const [revs] = await pool.query(
      'SELECT COUNT(*) AS c FROM record_revisions WHERE record_id = ? AND revision_no = 99', [R2]);
    assert.strictEqual(Number(revs[0].c), 0, '回滚后不得残留修订版本');
    const [recs] = await pool.query('SELECT current_revision_id FROM production_records WHERE id = ?', [R2]);
    const [validRev] = await pool.query('SELECT id FROM record_revisions WHERE record_id = ?', [R2]);
    assert.strictEqual(recs[0].current_revision_id, validRev[0].id, '生效指针应回滚');
    const d = await request('GET', `/corrections/${tmpReqId}`, null, auth(adminId));
    assert.strictEqual(d.body.data.status, 0, '申请应回滚为待审批');

    // 清理该申请
    const rr = await request('POST', `/corrections/${tmpReqId}/reject`,
      { review_comment: '测试清理' }, auth(adminId));
    assert.strictEqual(rr.status, 200);
  });

  // ---------- 12. 修订不可变 ----------
  await t('【不可变】触发器禁止 UPDATE 修订版本表', async () => {
    const [revs] = await pool.query('SELECT id FROM record_revisions LIMIT 1');
    assert.ok(revs.length > 0, '需要至少一条修订记录');
    let err = null;
    try {
      await pool.query('UPDATE record_revisions SET completed_qty = completed_qty + 1 WHERE id = ?', [revs[0].id]);
    } catch (e) { err = e; }
    assert.ok(err, 'UPDATE record_revisions 应被拒绝');
    assert.ok(err.code === 'ER_SIGNAL_EXCEPTION' || /不可变/.test(err.message),
      `应为不可变 SIGNAL 错误，实际: ${err.code} ${err.message}`);
  });

  // ---------- 13. 修订时间线 ----------
  await t('修订时间线：原始记录 + 全部修订版本（含申请/审批信息）', async () => {
    const r = await request('GET', `/records/${R1}/revisions`, null, auth(adminId));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.data.record.completed_qty, 50, '时间线原始记录保持原值');
    const expectedCount = reqRbId ? 3 : 2; // 回滚测试批准后 R1 应有3个版本
    assert.strictEqual(r.body.data.revisions.length, expectedCount);
    r.body.data.revisions.forEach((rv, i) => {
      assert.strictEqual(rv.revision_no, i + 1);
      assert.ok(rv.request_no && rv.reason, '修订应关联申请单号与纠错原因');
      assert.ok(rv.changed_by_name, '修订应包含审批人');
    });
    assert.strictEqual(r.body.data.revisions[0].completed_qty, 45);
    if (reqRbId) assert.strictEqual(r.body.data.revisions[2].completed_qty, 55);
  });

  await t('【权限】操作工查看他人记录时间线 => 403；本人 => 200', async () => {
    const r1 = await request('GET', `/records/${R1}/revisions`, null, auth(w2Id));
    assert.strictEqual(r1.status, 403);
    const r2 = await request('GET', `/records/${R1}/revisions`, null, auth(w1Id));
    assert.strictEqual(r2.status, 200);
  });

  // ---------- 14. 状态筛选 ----------
  await t('状态筛选：status=0/1/2 过滤正确', async () => {
    const approved = await request('GET', '/corrections?status=1&pageSize=100', null, auth(adminId));
    assert.ok(approved.body.data.length >= 3);
    approved.body.data.forEach(row => assert.strictEqual(row.status, 1));

    const rejected = await request('GET', '/corrections?status=2&pageSize=100', null, auth(adminId));
    assert.ok(rejected.body.data.length >= 2);
    rejected.body.data.forEach(row => assert.strictEqual(row.status, 2));

    const pending = await request('GET', '/corrections?status=0&pageSize=100', null, auth(adminId));
    pending.body.data.forEach(row => assert.strictEqual(row.status, 0));
  });

  // ---------- 15. 清理 ----------
  await test('清理：删除测试工单（级联清理记录/申请/修订）', async () => {
    if (orderId) {
      const r = await request('DELETE', `/workorders/${orderId}`);
      assert.ok(r.body.success);
      const [recs] = await pool.query('SELECT COUNT(*) AS c FROM production_records WHERE order_id = ?', [orderId]);
      assert.strictEqual(Number(recs[0].c), 0);
      const [reqs] = await pool.query('SELECT COUNT(*) AS c FROM record_correction_requests WHERE order_id = ?', [orderId]);
      assert.strictEqual(Number(reqs[0].c), 0);
    }
    return true;
  }).then(ok => ok ? pass++ : fail++);

  console.log(`\n=== 测试结果: ${pass} 通过, ${fail} 失败 ===\n`);

  if (server) server.close();
  try { await pool.end(); } catch (e) { /* ignore */ }
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('测试框架异常:', e); process.exit(1); });
