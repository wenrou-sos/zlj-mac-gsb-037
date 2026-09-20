/**
 * 生产记录纠错审批 —— 集成测试
 *
 * 运行前提（与 test/api.test.js 一致）：
 *   1. server/.env 配置好 MySQL 并已执行 init.sql（含纠错表/触发器）
 *   2. 后端实例运行中：PORT=3002 node app.js
 *   3. node test/corrections.test.js
 *
 * 覆盖：
 *   - 权限：未登录 401、操作工越权（他人记录/主管接口）403、主管不能申请
 *   - 业务校验：记录不存在 404、无变化申请 400、驳回必须填意见 400
 *   - 防重复：待审批申请唯一（串行 409 + 唯一索引）
 *   - 审批：批准后不可变修订版本、版本号、原记录不被直接修改路径保护
 *   - 重算：工单完成数/不良数/工时/状态/告警按全部最新有效记录重算
 *   - 并发：两个主管同时批准，恰好一方成功（另一方 409）
 *   - 回滚：触发器禁止更新/删除修订版本（审计不可变）
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
require('dotenv').config();

const BASE = 'http://localhost:3002/api';
const MANAGER = { id: 1, username: 'admin' };
const WORKER = { id: 3, username: 'worker01' };   // 一号组装线
const OTHER_WORKER = { id: 4, username: 'worker02' }; // 二号组装线

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + urlPath);
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers
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

const H = (u) => ({ 'x-user-id': u.id });
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function dbConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✅ PASS', name); pass++; }
  catch (e) { console.log('  ❌ FAIL', name, '\n     ', e.message); fail++; }
}

// ---------------------------------------------------------------------------
async function healthOk() {
  try {
    const r = await request('GET', '/health');
    return r.status === 200;
  } catch { return false; }
}

async function run() {
  console.log('\n=== 纠错审批集成测试 ===\n');

  if (!(await healthOk())) {
    console.log('  ⏭  SKIP: 后端未在 http://localhost:3002 运行（启动后执行: PORT=3002 node app.js）');
    console.log(`\n=== 测试结果: ${pass} 通过, ${fail} 失败, 已跳过 ===\n`);
    process.exit(0);
  }

  let db = null;
  try { db = await dbConn(); } catch { console.log('  ⏭  SKIP: 无法连接 MySQL，跳过集成测试'); process.exit(0); }

  // ---- 测试夹具：主管新建工单 + 操作工上报 3 条记录 ----
  const createdOrderIds = [];
  const createdCorrectionIds = [];

  async function createOrder({ plan_qty = 100, line_id = 1, product_id = 1, threshold = 5 } = {}) {
    const r = await request('POST', '/workorders', {
      line_id, product_id, plan_qty, assigned_by: MANAGER.id,
      defect_threshold: threshold, remark: '纠错测试工单'
    });
    assert.ok(r.body.success, `创建工单失败: ${r.body.message}`);
    createdOrderIds.push(r.body.data.id);
    return r.body.data.id;
  }

  async function submitRecord(orderId, user, { completed_qty, defect_qty, work_hours, defect_reason, remark }) {
    const r = await request('POST', '/records', {
      order_id, user_id: user.id, completed_qty, defect_qty, work_hours,
      defect_reason: defect_reason || '', remark: remark || ''
    }, H(user));
    assert.ok(r.body.success, `上报失败: ${r.body.message}`);
    return r.body.data;
  }

  // 已批准的修订版本受“禁止 UPDATE/DELETE”触发器与 RESTRICT 外键保护，
  // 这是生产设计；测试清理时临时卸下触发器，按 修订->申请->工单 顺序删除后重建。
  const recreateTriggers = async () => {
    await db.query(`CREATE TRIGGER trg_records_block_identity_update
      BEFORE UPDATE ON production_records FOR EACH ROW
      BEGIN
        IF NEW.id <> OLD.id OR NEW.order_id <> OLD.order_id OR NEW.user_id <> OLD.user_id
           OR IFNULL(NEW.created_at, '1970-01-01 00:00:00') <> IFNULL(OLD.created_at, '1970-01-01 00:00:00') THEN
          SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '生产记录标识/归属字段不可修改，数值纠错必须走纠错审批流程';
        END IF;
      END`);
    await db.query(`CREATE TRIGGER trg_revisions_block_update
      BEFORE UPDATE ON record_revisions FOR EACH ROW
      BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '修订版本为不可变审计记录，禁止更新'; END`);
    await db.query(`CREATE TRIGGER trg_revisions_block_delete
      BEFORE DELETE ON record_revisions FOR EACH ROW
      BEGIN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '修订版本为不可变审计记录，禁止删除'; END`);
  };

  const cleanup = async () => {
    try {
      await db.query('DROP TRIGGER IF EXISTS trg_revisions_block_delete');
      await db.query('DROP TRIGGER IF EXISTS trg_revisions_block_update');
      await db.query('DROP TRIGGER IF EXISTS trg_records_block_identity_update');

      if (createdOrderIds.length) {
        const placeholders = createdOrderIds.map(() => '?').join(',');
        await db.query(
          `DELETE rv FROM record_revisions rv
             JOIN production_records r ON r.id = rv.record_id
            WHERE r.order_id IN (${placeholders})`,
          createdOrderIds
        );
      }
      if (createdCorrectionIds.length) {
        await db.query('DELETE FROM record_revisions WHERE correction_id IN (?)', [createdCorrectionIds]);
      }
      for (const id of createdOrderIds) {
        try { await request('DELETE', `/workorders/${id}`); } catch {}
      }
      await recreateTriggers();
    } catch (e) {
      console.warn('    ⚠ 清理失败（可手动删除 remark=纠错测试工单 的数据）:', e.message);
    } finally {
      await db.end();
    }
  };

  try {
    // =======================================================================
    // 一、权限测试
    // =======================================================================
    const orderId = await createOrder({ plan_qty: 1000 });
    const rec1 = await submitRecord(orderId, WORKER, {
      completed_qty: 100, defect_qty: 5, work_hours: 8, defect_reason: '外观划痕', remark: '上午班'
    });
    const rec2 = await submitRecord(orderId, WORKER, {
      completed_qty: 200, defect_qty: 8, work_hours: 8, remark: '下午班'
    });
    // 另一操作工在另一产线的工单/记录，用于越权测试
    const otherOrderId = await createOrder({ plan_qty: 500, line_id: 2 });
    const otherRec = await submitRecord(otherOrderId, OTHER_WORKER, {
      completed_qty: 50, defect_qty: 0, work_hours: 4
    });

    await test('权限: 未登录提交申请 => 401', async () => {
      const r = await request('POST', '/corrections', {
        record_id: rec1.id, corrected_completed_qty: 110,
        corrected_defect_qty: 5, corrected_work_hours: 8, reason: '填错了'
      });
      assert.strictEqual(r.status, 401);
      assert.strictEqual(r.body.success, false);
    });

    await test('权限: 操作工对他人记录提交申请 => 403', async () => {
      const r = await request('POST', '/corrections', {
        record_id: otherRec.id, corrected_completed_qty: 60,
        corrected_defect_qty: 0, corrected_work_hours: 4, reason: '不是我的记录也试试'
      }, H(WORKER));
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.body.code, 'NOT_OWN_RECORD');
    });

    await test('权限: 主管调用操作工的提交接口 => 403', async () => {
      const r = await request('POST', '/corrections', {
        record_id: rec1.id, corrected_completed_qty: 110,
        corrected_defect_qty: 5, corrected_work_hours: 8, reason: '主管不能申请'
      }, H(MANAGER));
      assert.strictEqual(r.status, 403);
    });

    await test('权限: 操作工调用批准接口 => 403', async () => {
      const r = await request('POST', `/corrections/${rec1.id}/approve`, { review_comment: '越权批准' }, H(WORKER));
      // rec1.id 作为申请 id 即便不存在，角色中间件也应先拦截
      assert.strictEqual(r.status, 403);
    });

    await test('权限: 操作工列表只能看到本人的申请', async () => {
      // admin 看不到申请人筛选项；worker02 先给自己记录提一条
      const app = await request('POST', '/corrections', {
        record_id: otherRec.id, corrected_completed_qty: 55,
        corrected_defect_qty: 0, corrected_work_hours: 4, reason: '数量录入错误'
      }, H(OTHER_WORKER));
      assert.strictEqual(app.status, 201);
      createdCorrectionIds.push(app.body.data.id);

      const r = await request('GET', '/corrections', null, H(WORKER));
      assert.strictEqual(r.status, 200);
      r.body.data.forEach(c => assert.strictEqual(c.applicant_id, WORKER.id, '操作工不应看到他人申请'));
    });

    await test('权限: 操作工不能查看他人申请详情 => 403', async () => {
      const otherApp = await request('GET', '/corrections', { }, H(OTHER_WORKER));
      const target = otherApp.body.data[0];
      const r = await request('GET', `/corrections/${target.id}`, null, H(WORKER));
      assert.strictEqual(r.status, 403);
    });

    await test('权限: 操作工向非本产线工单上报 => 403', async () => {
      const r = await request('POST', '/records', {
        order_id: otherOrderId, user_id: WORKER.id,
        completed_qty: 1, defect_qty: 0, work_hours: 1
      }, H(WORKER));
      assert.strictEqual(r.status, 403);
    });

    // =======================================================================
    // 二、申请校验
    // =======================================================================
    await test('申请: 记录不存在 => 404', async () => {
      const r = await request('POST', '/corrections', {
        record_id: 99999999, corrected_completed_qty: 1,
        corrected_defect_qty: 0, corrected_work_hours: 1, reason: 'x'
      }, H(WORKER));
      assert.strictEqual(r.status, 404);
    });

    await test('申请: 缺少纠错原因 => 400', async () => {
      const r = await request('POST', '/corrections', {
        record_id: rec1.id, corrected_completed_qty: 110,
        corrected_defect_qty: 5, corrected_work_hours: 8, reason: '   '
      }, H(WORKER));
      assert.strictEqual(r.status, 400);
    });

    await test('申请: 修正值与原记录完全一致 => 400 NO_CHANGE', async () => {
      const r = await request('POST', '/corrections', {
        record_id: rec1.id, corrected_completed_qty: 100,
        corrected_defect_qty: 5, corrected_work_hours: 8,
        corrected_defect_reason: '外观划痕', corrected_remark: '上午班',
        reason: '没变化也提一下'
      }, H(WORKER));
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.body.code, 'NO_CHANGE');
    });

    await test('申请: 负数修正值 => 400', async () => {
      const r = await request('POST', '/corrections', {
        record_id: rec1.id, corrected_completed_qty: -1,
        corrected_defect_qty: 5, corrected_work_hours: 8, reason: '非法值'
      }, H(WORKER));
      assert.strictEqual(r.status, 400);
    });

    // =======================================================================
    // 三、防重复申请
    // =======================================================================
    let corrId = null;
    await test('申请: 本人记录首次提交成功 => 201，返回差异', async () => {
      const r = await request('POST', '/corrections', {
        record_id: rec1.id,
        corrected_completed_qty: 120, corrected_defect_qty: 3,
        corrected_work_hours: 7.5, corrected_defect_reason: '外壳轻微划痕',
        corrected_remark: '上午班(已复核)', reason: '完工数量与不良数均录错，已与质检核对'
      }, H(WORKER));
      assert.strictEqual(r.status, 201);
      corrId = r.body.data.id;
      createdCorrectionIds.push(corrId);
      assert.strictEqual(r.body.data.status, 0);
      const changed = r.body.data.diff.filter(d => d.changed).map(d => d.field);
      assert.ok(changed.includes('completed_qty'));
      assert.ok(changed.includes('defect_qty'));
      // 数据库中存在待审批申请
      const [rows] = await db.query('SELECT status FROM record_corrections WHERE id = ?', [corrId]);
      assert.strictEqual(Number(rows[0].status), 0);
      // 原记录在审批前不得被修改
      const [recRows] = await db.query(
        'SELECT completed_qty, defect_qty, work_hours, current_version FROM production_records WHERE id = ?',
        [rec1.id]
      );
      assert.strictEqual(Number(recRows[0].completed_qty), 100);
      assert.strictEqual(Number(recRows[0].current_version), 0);
    });

    await test('防重复: 待审批期间再次提交 => 409 DUPLICATE_PENDING', async () => {
      const r = await request('POST', '/corrections', {
        record_id: rec1.id, corrected_completed_qty: 130,
        corrected_defect_qty: 5, corrected_work_hours: 8, reason: '再试一次'
      }, H(WORKER));
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.code, 'DUPLICATE_PENDING');
    });

    await test('防重复: 数据库唯一索引 (record_id,pending_flag) 兜底存在', async () => {
      await assert.rejects(
        () => db.query(
          `INSERT INTO record_corrections
            (record_id, applicant_id, original_completed_qty, original_defect_qty, original_work_hours,
             corrected_completed_qty, corrected_defect_qty, corrected_work_hours, reason, status)
           VALUES (?, ?, 1, 1, 1, 2, 2, 2, '绕过API', 0)`,
          [rec1.id, WORKER.id]
        ),
        /ER_DUP_ENTRY/
      );
    });

    // =======================================================================
    // 四、审批校验
    // =======================================================================
    await test('审批: 不存在的申请 => 404', async () => {
      const r = await request('POST', '/corrections/99999999/approve', {}, H(MANAGER));
      assert.strictEqual(r.status, 404);
    });

    await test('审批: 驳回不填意见 => 400', async () => {
      const r = await request('POST', `/corrections/${corrId}/reject`, { review_comment: '' }, H(MANAGER));
      assert.strictEqual(r.status, 400);
      // 申请仍为待审批
      const [rows] = await db.query('SELECT status FROM record_corrections WHERE id = ?', [corrId]);
      assert.strictEqual(Number(rows[0].status), 0);
    });

    // =======================================================================
    // 五、并发审批：恰好一方成功
    // =======================================================================
    await test('并发: 两个请求同时批准，恰好一方 200、另一方 409', async () => {
      const [r1, r2] = await Promise.all([
        request('POST', `/corrections/${corrId}/approve`, { review_comment: '并发批准A' }, H(MANAGER)),
        wait(15).then(() => request('POST', `/corrections/${corrId}/approve`, { review_comment: '并发批准B' }, H(MANAGER)))
      ]);
      const statuses = [r1.status, r2.status].sort();
      assert.deepStrictEqual(statuses, [200, 409],
        `期望 [200,409]，实际 [${r1.status},${r2.status}]`);
      // 终态唯一
      const [rows] = await db.query('SELECT status, reviewer_id, reviewed_at FROM record_corrections WHERE id = ?', [corrId]);
      assert.strictEqual(Number(rows[0].status), 1);
      assert.ok(rows[0].reviewed_at);
    });

    // =======================================================================
    // 六、批准后：不可变修订 + 数据重算
    // =======================================================================
    await test('批准结果: 记录被更新为修正值且版本号=1，last_revised_at 非空', async () => {
      const [rows] = await db.query(
        'SELECT completed_qty, defect_qty, work_hours, defect_reason, remark, current_version, last_revised_at FROM production_records WHERE id = ?',
        [rec1.id]
      );
      const r = rows[0];
      assert.strictEqual(Number(r.completed_qty), 120);
      assert.strictEqual(Number(r.defect_qty), 3);
      assert.strictEqual(Number(r.work_hours), 7.5);
      assert.strictEqual(r.defect_reason, '外壳轻微划痕');
      assert.strictEqual(r.remark, '上午班(已复核)');
      assert.strictEqual(Number(r.current_version), 1);
      assert.ok(r.last_revised_at);
    });

    await test('批准结果: 生成不可变修订版本，含记录与工单前后快照', async () => {
      const [rows] = await db.query(
        'SELECT * FROM record_revisions WHERE record_id = ? ORDER BY version_no',
        [rec1.id]
      );
      assert.strictEqual(rows.length, 1);
      const rv = rows[0];
      assert.strictEqual(Number(rv.version_no), 1);
      assert.strictEqual(Number(rv.correction_id), corrId);
      // 记录快照
      assert.strictEqual(Number(rv.old_completed_qty), 100);
      assert.strictEqual(Number(rv.new_completed_qty), 120);
      assert.strictEqual(Number(rv.old_defect_qty), 5);
      assert.strictEqual(Number(rv.new_defect_qty), 3);
      assert.strictEqual(Number(rv.old_work_hours), 8);
      assert.strictEqual(Number(rv.new_work_hours), 7.5);
      // 工单快照：旧 305/13/16（100+200, 5+8, 8+8）
      assert.strictEqual(Number(rv.old_order_completed_qty), 300);
      assert.strictEqual(Number(rv.old_order_defect_qty), 13);
      assert.strictEqual(Number(rv.old_order_work_hours), 16);
    });

    await test('重算: 工单完成数/不良数/工时 = 全部最新有效记录之和', async () => {
      const detail = await request('GET', `/workorders/${orderId}`);
      const d = detail.body.data;
      // 记录1: 120/3/7.5，记录2: 200/8/8
      assert.strictEqual(d.completed_qty, 320, `完成数应为 320，实际 ${d.completed_qty}`);
      assert.strictEqual(d.defect_qty, 11, `不良数应为 11，实际 ${d.defect_qty}`);
      assert.strictEqual(d.total_work_hours, 15.5, `工时应为 15.5，实际 ${d.total_work_hours}`);
    });

    await test('时间线: 原始上报 + v1 修订，按版本升序', async () => {
      const r = await request('GET', `/corrections/records/${rec1.id}/timeline`, null, H(WORKER));
      assert.ok(r.body.success);
      const tl = r.body.data.timeline;
      assert.strictEqual(tl.length, 2);
      assert.strictEqual(tl[0].version_no, 0);
      assert.strictEqual(tl[0].completed_qty, 100);
      assert.strictEqual(tl[1].version_no, 1);
      assert.strictEqual(tl[1].completed_qty, 120);
      assert.strictEqual(tl[1].approver_name, '张主管');
      assert.ok(tl[1].order_snapshot);
      assert.strictEqual(tl[1].order_snapshot.new_completed_qty, 320);
    });

    // =======================================================================
    // 七、已批准后允许对新版本再次申请（v2 链路）
    // =======================================================================
    let corrId2 = null;
    await test('二次纠错: 上一申请已处理后可以再次申请并批准，版本升到 2', async () => {
      const app = await request('POST', '/corrections', {
        record_id: rec1.id,
        corrected_completed_qty: 125, corrected_defect_qty: 2,
        corrected_work_hours: 7.5, corrected_defect_reason: '外壳轻微划痕',
        corrected_remark: '上午班(二次复核)', reason: '又核对了一遍数量'
      }, H(WORKER));
      assert.strictEqual(app.status, 201, app.body.message);
      corrId2 = app.body.data.id;
      createdCorrectionIds.push(corrId2);

      const approve = await request('POST', `/corrections/${corrId2}/approve`, {}, H(MANAGER));
      assert.strictEqual(approve.status, 200, approve.body.message);
      assert.strictEqual(approve.body.data.version_no, 2);
      const [rev] = await db.query(
        'SELECT id FROM record_revisions WHERE correction_id = ?', [corrId2]
      );

      const [rows] = await db.query('SELECT current_version FROM production_records WHERE id = ?', [rec1.id]);
      assert.strictEqual(Number(rows[0].current_version), 2);
    });

    await test('审计历史: 同一记录保留 2 个修订版本，时间线 3 个节点', async () => {
      const [rows] = await db.query('SELECT COUNT(*) AS n FROM record_revisions WHERE record_id = ?', [rec1.id]);
      assert.strictEqual(Number(rows[0].n), 2);
      const tl = await request('GET', `/corrections/records/${rec1.id}/timeline`, null, H(WORKER));
      assert.strictEqual(tl.body.data.timeline.length, 3);
    });

    // =======================================================================
    // 八、驳回链路：记录与工单不变，可重新申请
    // =======================================================================
    let rejectId = null;
    await test('驳回: 主管驳回后记录/工单不变，申请人可重新申请', async () => {
      const app = await request('POST', '/corrections', {
        record_id: rec2.id,
        corrected_completed_qty: 210, corrected_defect_qty: 8,
        corrected_work_hours: 8, corrected_remark: '下午班', reason: '少计10件'
      }, H(WORKER));
      assert.strictEqual(app.status, 201);
      rejectId = app.body.data.id;
      createdCorrectionIds.push(rejectId);

      const rej = await request('POST', `/corrections/${rejectId}/reject`,
        { review_comment: '缺少质检凭证，驳回' }, H(MANAGER));
      assert.strictEqual(rej.status, 200);
      assert.strictEqual(rej.body.data.status, 2);

      const [recRows] = await db.query('SELECT completed_qty, current_version FROM production_records WHERE id = ?', [rec2.id]);
      assert.strictEqual(Number(recRows[0].completed_qty), 200);
      assert.strictEqual(Number(recRows[0].current_version), 0);

      // 驳回后可重新申请
      const reApp = await request('POST', '/corrections', {
        record_id: rec2.id,
        corrected_completed_qty: 205, corrected_defect_qty: 8,
        corrected_work_hours: 8, corrected_remark: '下午班', reason: '凭证已补齐，少计5件'
      }, H(WORKER));
      assert.strictEqual(reApp.status, 201);
      createdCorrectionIds.push(reApp.body.data.id);
    });

    // =======================================================================
    // 九、重算：状态回退与不良率告警
    // =======================================================================
    await test('重算: 仅 1 条记录的工单，批准把数值改成全 0 => 状态回到待生产(0)', async () => {
      const oid = await createOrder({ plan_qty: 100, line_id: 1 });
      const rec = await submitRecord(oid, WORKER, {
        completed_qty: 30, defect_qty: 2, work_hours: 3
      });
      const before = await request('GET', `/workorders/${oid}`);
      assert.strictEqual(before.body.data.status, 1);

      const app = await request('POST', '/corrections', {
        record_id: rec.id,
        corrected_completed_qty: 0, corrected_defect_qty: 0,
        corrected_work_hours: 0, corrected_defect_reason: '', corrected_remark: '',
        reason: '误报到该工单'
      }, H(WORKER));
      assert.strictEqual(app.status, 201);
      createdCorrectionIds.push(app.body.data.id);

      const approve = await request('POST', `/corrections/${app.body.data.id}/approve`, {}, H(MANAGER));
      assert.strictEqual(approve.status, 200);
      assert.strictEqual(approve.body.data.work_order.status, 0);
      assert.strictEqual(approve.body.data.work_order.completed_qty, 0);

      const after = await request('GET', `/workorders/${oid}`);
      assert.strictEqual(after.body.data.status, 0);
      assert.strictEqual(after.body.data.completed_qty, 0);
      assert.strictEqual(after.body.data.defect_qty, 0);
      assert.strictEqual(after.body.data.total_work_hours, 0);
    });

    await test('重算: 纠正后不良率超阈值 => 批准返回告警标记', async () => {
      const oid = await createOrder({ plan_qty: 100, line_id: 1, threshold: 5 });
      const rec = await submitRecord(oid, WORKER, {
        completed_qty: 95, defect_qty: 1, work_hours: 2
      });
      const app = await request('POST', '/corrections', {
        record_id: rec.id,
        corrected_completed_qty: 80, corrected_defect_qty: 20,
        corrected_work_hours: 2, reason: '不良漏记20件'
      }, H(WORKER));
      assert.strictEqual(app.status, 201);
      createdCorrectionIds.push(app.body.data.id);

      const approve = await request('POST', `/corrections/${app.body.data.id}/approve`, {}, H(MANAGER));
      assert.strictEqual(approve.status, 200);
      assert.strictEqual(approve.body.data.work_order.defect_alert, true);
      assert.strictEqual(approve.body.data.work_order.defect_rate, 20);
      assert.ok(/超过阈值/.test(approve.body.message));
    });

    // =======================================================================
    // 十、回滚 / 不可变审计
    // =======================================================================
    await test('回滚: 触发器禁止更新 record_revisions => 报错且数据不变', async () => {
      const [[rv]] = await db.query('SELECT id, new_completed_qty FROM record_revisions WHERE record_id = ? LIMIT 1', [rec1.id]);
      await assert.rejects(
        () => db.query('UPDATE record_revisions SET new_completed_qty = 999 WHERE id = ?', [rv.id]),
        /禁止更新/
      );
      const [rows] = await db.query('SELECT new_completed_qty FROM record_revisions WHERE id = ?', [rv.id]);
      assert.notStrictEqual(Number(rows[0].new_completed_qty), 999);
    });

    await test('回滚: 触发器禁止删除 record_revisions', async () => {
      const [[rv]] = await db.query('SELECT id FROM record_revisions WHERE record_id = ? LIMIT 1', [rec1.id]);
      await assert.rejects(
        () => db.query('DELETE FROM record_revisions WHERE id = ?', [rv.id]),
        /禁止删除/
      );
      const [rows] = await db.query('SELECT id FROM record_revisions WHERE id = ?', [rv.id]);
      assert.strictEqual(rows.length, 1);
    });

    await test('回滚: 触发器禁止篡改生产记录归属字段（order_id/user_id）', async () => {
      await assert.rejects(
        () => db.query('UPDATE production_records SET user_id = ? WHERE id = ?', [OTHER_WORKER.id, rec1.id]),
        /标识\/归属字段不可修改/
      );
      const [rows] = await db.query('SELECT user_id FROM production_records WHERE id = ?', [rec1.id]);
      assert.strictEqual(Number(rows[0].user_id), WORKER.id);
    });

    await test('回滚: 模拟事务中修订写入后步骤失败 => 整体回滚，记录/工单/申请均不变', async () => {
      // 为该场景准备：新工单 + 新记录 + 新申请
      const oid = await createOrder({ plan_qty: 100, line_id: 1 });
      const rec = await submitRecord(oid, WORKER, {
        completed_qty: 40, defect_qty: 2, work_hours: 4
      });
      const app = await request('POST', '/corrections', {
        record_id: rec.id,
        corrected_completed_qty: 50, corrected_defect_qty: 1,
        corrected_work_hours: 4, reason: '回滚测试用申请'
      }, H(WORKER));
      assert.strictEqual(app.status, 201);
      const cid = app.body.data.id;
      createdCorrectionIds.push(cid);

      const conn = await dbConn();
      try {
        await conn.beginTransaction();
        // 复刻审批事务的写操作
        await conn.query(
          `UPDATE record_corrections SET status = 1, reviewer_id = ?, review_comment = '回滚测试', reviewed_at = NOW()
            WHERE id = ? AND status = 0`,
          [MANAGER.id, cid]
        );
        await conn.query(
          `UPDATE production_records SET completed_qty = 50, defect_qty = 1, work_hours = 4,
                  current_version = current_version + 1, last_revised_at = NOW()
            WHERE id = ?`,
          [rec.id]
        );
        await conn.query(
          'UPDATE work_orders SET completed_qty = 50, defect_qty = 1, total_work_hours = 4, status = 1 WHERE id = ?',
          [oid]
        );
        // 第一条修订版本写入成功（version_no=1）
        const insertRevision = `
          INSERT INTO record_revisions
            (record_id, correction_id, version_no,
             old_completed_qty, new_completed_qty, old_defect_qty, new_defect_qty,
             old_work_hours, new_work_hours,
             old_order_completed_qty, new_order_completed_qty,
             old_order_defect_qty, new_order_defect_qty,
             old_order_work_hours, new_order_work_hours,
             old_order_status, new_order_status, approved_by)
          VALUES (?, ?, 1, 40, 50, 2, 1, 4, 4, 40, 50, 2, 1, 4, 4, 1, 1, ?)`;
        await conn.query(insertRevision, [rec.id, cid, MANAGER.id]);
        // 故意制造失败：同事务再插一条相同 (record_id, version_no) => 唯一约束冲突
        await conn.query(insertRevision, [rec.id, cid, MANAGER.id]);
        await conn.commit();
        assert.fail('应当因重复 version_no 抛错');
      } catch (e) {
        await conn.rollback();
        assert.ok(/ER_DUP_ENTRY/.test(e.code || '') || /Duplicate/.test(e.message),
          `期望唯一约束冲突，实际: ${e.code} ${e.message}`);
      } finally {
        await conn.end();
      }

      // 事务外验证：全部维持原值（回滚生效）
      const [corrRows] = await db.query('SELECT status FROM record_corrections WHERE id = ?', [cid]);
      assert.strictEqual(Number(corrRows[0].status), 0, '申请应回滚为待审批');
      const [recRows] = await db.query(
        'SELECT completed_qty, defect_qty, current_version FROM production_records WHERE id = ?', [rec.id]
      );
      assert.strictEqual(Number(recRows[0].completed_qty), 40, '记录应回滚为原值');
      assert.strictEqual(Number(recRows[0].current_version), 0, '版本号应回滚为0');
      const [orderRows] = await db.query(
        'SELECT completed_qty, defect_qty FROM work_orders WHERE id = ?', [oid]
      );
      assert.strictEqual(Number(orderRows[0].completed_qty), 40, '工单应回滚为原值');
      assert.strictEqual(Number(orderRows[0].defect_qty), 2);
      const [revRows] = await db.query('SELECT COUNT(*) AS n FROM record_revisions WHERE correction_id = ?', [cid]);
      assert.strictEqual(Number(revRows[0].n), 0, '不应留下修订版本');

      // 申请仍可被正常批准（证明回滚没有留下锁/脏状态）
      const approve = await request('POST', `/corrections/${cid}/approve`, {}, H(MANAGER));
      assert.strictEqual(approve.status, 200, approve.body.message);
      const [rev2] = await db.query('SELECT id FROM record_revisions WHERE correction_id = ?', [cid]);
    });

    // =======================================================================
    // 十一、列表筛选
    // =======================================================================
    await test('列表: 主管可按 status 筛选待审批/已批准/已驳回', async () => {
      for (const s of [0, 1, 2]) {
        const r = await request('GET', `/corrections?status=${s}&pageSize=200`, null, H(MANAGER));
        assert.ok(r.body.success);
        r.body.data.forEach(c => assert.strictEqual(c.status, s));
      }
    });

    await test('记录列表: 返回 current_version / has_pending_correction / line_name', async () => {
      const r = await request('GET', `/records?order_id=${orderId}`, null, H(WORKER));
      assert.ok(r.body.success);
      const target = r.body.data.find(x => x.id === rec1.id);
      assert.ok(target);
      assert.strictEqual(target.current_version, 2);
      assert.strictEqual(typeof target.has_pending_correction, 'boolean');
      assert.ok(target.line_name);
      assert.ok(target.product_name);
    });

  } finally {
    await cleanup();
  }

  console.log(`\n=== 测试结果: ${pass} 通过, ${fail} 失败 ===\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(e => { console.error('测试框架异常:', e); process.exit(1); });
