/**
 * 工单重算纯逻辑单元测试（无需数据库，直接 node test/recompute.test.js）
 * 覆盖：按全部最新有效记录汇总、状态流转、阈值告警、差异计算
 */
const assert = require('assert');
const {
  summarizeRecords, deriveOrderStatus, buildDiff, round2
} = require('../services/recompute');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); console.log('  ✅ PASS', name); pass++; }
  catch (e) { console.log('  ❌ FAIL', name, '\n     ', e.message); fail++; }
}

console.log('\n=== 重算纯逻辑单元测试 ===\n');

test('summarizeRecords: 多条记录汇总完成数/不良数/工时', () => {
  const s = summarizeRecords([
    { completed_qty: 100, defect_qty: 5, work_hours: 8 },
    { completed_qty: 200, defect_qty: 10, work_hours: 7.5 }
  ]);
  assert.strictEqual(s.completed_qty, 300);
  assert.strictEqual(s.defect_qty, 15);
  assert.strictEqual(s.work_hours, 15.5);
});

test('summarizeRecords: 空记录汇总为 0，不良率 0 且不告警', () => {
  const s = summarizeRecords([]);
  assert.deepStrictEqual(
    { c: s.completed_qty, d: s.defect_qty, h: s.work_hours, r: s.defect_rate, a: s.defect_alert },
    { c: 0, d: 0, h: 0, r: 0, a: false }
  );
});

test('summarizeRecords: 不良率按 不良/(完成+不良)*100 保留2位小数', () => {
  const s = summarizeRecords([{ completed_qty: 90, defect_qty: 10, work_hours: 1 }]);
  assert.strictEqual(s.defect_rate, 10);
  const s2 = summarizeRecords([{ completed_qty: 80, defect_qty: 3, work_hours: 0 }]);
  assert.strictEqual(s2.defect_rate, round2(3 / 83 * 100));
});

test('summarizeRecords: DECIMAL 字符串入参也能正确求和（mysql2 可能返回字符串）', () => {
  const s = summarizeRecords([
    { completed_qty: '10', defect_qty: '2', work_hours: '3.50' },
    { completed_qty: '5', defect_qty: '0', work_hours: '2.50' }
  ]);
  assert.strictEqual(s.completed_qty, 15);
  assert.strictEqual(s.defect_qty, 2);
  assert.strictEqual(s.work_hours, 6);
});

test('告警: 不良率 > 阈值(默认5%) 才告警，等于阈值不告警', () => {
  const alert = summarizeRecords([{ completed_qty: 80, defect_qty: 10, work_hours: 1 }], 5);
  assert.strictEqual(alert.defect_alert, true);
  const eq = summarizeRecords([{ completed_qty: 95, defect_qty: 5, work_hours: 1 }], 5);
  assert.strictEqual(eq.defect_alert, false);
  const below = summarizeRecords([{ completed_qty: 96, defect_qty: 4, work_hours: 1 }], 5);
  assert.strictEqual(below.defect_alert, false);
});

test('告警: 自定义阈值 2.5%', () => {
  const s = summarizeRecords([{ completed_qty: 100, defect_qty: 3, work_hours: 1 }], 2.5);
  assert.strictEqual(s.defect_alert, true);
});

test('状态: 待生产(0) 有活动量 => 生产中(1)', () => {
  assert.strictEqual(deriveOrderStatus(0, { completed_qty: 1, defect_qty: 0, work_hours: 0 }), 1);
  assert.strictEqual(deriveOrderStatus(0, { completed_qty: 0, defect_qty: 1, work_hours: 0 }), 1);
  assert.strictEqual(deriveOrderStatus(0, { completed_qty: 0, defect_qty: 0, work_hours: 2 }), 1);
});

test('状态: 纠错把记录改回全 0 时，生产中(1) 工单回到待生产(0)', () => {
  assert.strictEqual(deriveOrderStatus(1, { completed_qty: 0, defect_qty: 0, work_hours: 0 }), 0);
});

test('状态: 已完成(2)/已暂停(3) 是人工决策，重算不覆盖', () => {
  const zero = { completed_qty: 0, defect_qty: 0, work_hours: 0 };
  assert.strictEqual(deriveOrderStatus(2, zero), 2);
  assert.strictEqual(deriveOrderStatus(3, zero), 3);
  const busy = { completed_qty: 100, defect_qty: 1, work_hours: 5 };
  assert.strictEqual(deriveOrderStatus(2, busy), 2);
  assert.strictEqual(deriveOrderStatus(3, busy), 3);
});

test('buildDiff: 标记变化字段，未变化字段 changed=false', () => {
  const diff = buildDiff(
    { completed_qty: 100, defect_qty: 5, work_hours: 8, defect_reason: '划痕', remark: '' },
    { completed_qty: 110, defect_qty: 5, work_hours: 8, defect_reason: '划痕', remark: '补录备注' }
  );
  const byField = Object.fromEntries(diff.map(d => [d.field, d]));
  assert.strictEqual(byField.completed_qty.changed, true);
  assert.strictEqual(byField.completed_qty.oldValue, 100);
  assert.strictEqual(byField.completed_qty.newValue, 110);
  assert.strictEqual(byField.defect_qty.changed, false);
  assert.strictEqual(byField.work_hours.changed, false);
  assert.strictEqual(byField.remark.changed, true);
});

test('buildDiff: null 与空串视为相同（数据库 NULL ↔ 表单空值）', () => {
  const diff = buildDiff(
    { completed_qty: 1, defect_qty: 0, work_hours: 1, defect_reason: null, remark: null },
    { completed_qty: 1, defect_qty: 0, work_hours: 1, defect_reason: '', remark: '' }
  );
  assert.ok(diff.every(d => d.changed === false), '仅 null->空串 不应算作差异');
});

test('buildDiff: 工时按数值比较，"8" 与 8 不算差异', () => {
  const diff = buildDiff(
    { completed_qty: 1, defect_qty: 0, work_hours: '8.00', defect_reason: '', remark: '' },
    { completed_qty: 1, defect_qty: 0, work_hours: 8, defect_reason: '', remark: '' }
  );
  assert.strictEqual(diff.find(d => d.field === 'work_hours').changed, false);
});

console.log(`\n=== 测试结果: ${pass} 通过, ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
