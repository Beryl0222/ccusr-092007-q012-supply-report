import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.js';
import { loadScenario, septemberSnapshot, ruleBook } from './helpers.js';

const raw = await loadScenario();
const snap = septemberSnapshot(raw);
const result = reconcile(snap, ruleBook(raw));

const subject = (id) => result.subjects.find((s) => s.subject_id === id);
const region = result.aggregate_totals.find((t) => t.subject_id === 'REG-1');
const findingKinds = () => result.findings.map((f) => f.kind);

test('快照可复算：同内容同时间生成同一 snapshot_id', async () => {
  const again = septemberSnapshot(await loadScenario());
  assert.equal(again.snapshot_id, snap.snapshot_id);
});

test('药企按盒上报被换算成标准单位支', () => {
  // 甲窗口内 200 盒自有 + 100 盒委托方侧 = 300 盒 = 3000 支
  assert.equal(subject('ENT-A').nominal_std, '3000');
  assert.equal(result.unit_rule.factor, '10');
});

test('名义库存与真正可用库存分列（窗口内质量隔离扣除）', () => {
  // 乙窗口内 170 自有 + 100 受托 + 30 退货 = 300 盒名义，其中 10 盒隔离
  assert.equal(subject('ENT-B').nominal_std, '3100');
  assert.equal(subject('ENT-B').available_std, '3000');
  assert.equal(subject('ENT-B').by_type.quarantine.nominal_std, '100');
});

test('迟报另成批次且不并入窗口总数', () => {
  // 甲 9/22 上报的 20 盒质量隔离 = 200 支，只进 late 桶
  assert.equal(subject('ENT-A').nominal_std, '3000');
  assert.equal(subject('ENT-A').late.nominal_std, '200');
  assert.ok(findingKinds().includes('late_report'));
});

test('委托链重叠被识别：委托方与受托方双计 1000 支', () => {
  const ov = result.consignment_overlaps.find((o) => o.consignment_id === 'C-001');
  assert.equal(ov.overlap_std, '1000');
  assert.equal(ov.consignor_id, 'ENT-A');
  assert.equal(ov.consignee_id, 'ENT-B');
  assert.ok(findingKinds().includes('consignment_double_count'));
});

test('地区三口径并列：原始 6100、去重 5100、迟报另列 200', () => {
  assert.equal(region.raw_nominal_std, '6100');
  assert.equal(region.consignment_overlap_std, '1000');
  assert.equal(region.deduplicated_nominal_std, '5100');
  assert.equal(region.deduplicated_available_std, '5000');
  assert.equal(region.late_nominal_std, '200');
});

test('园区换算且去重正确 → 不产生上下级差异；地区双计 → 产生差异', () => {
  const hier = result.findings.filter((f) => f.kind === 'hierarchy_overlap');
  assert.equal(hier.length, 2); // 地区名义、地区可用各一条
  assert.deepEqual(hier.map((f) => f.subject_ids[0]), ['REG-1', 'REG-1']);
  // 建议采用值即去重值，但状态为待人工确认
  const nominalFinding = hier.find((f) => f.metric === 'nominal_quantity_std');
  assert.equal(nominalFinding.proposed.value, '5100');
  assert.equal(nominalFinding.status, 'open');
});

test('系统只提建议值，不自动采用', () => {
  assert.ok(result.open_finding_ids.length > 0);
  for (const f of result.findings) {
    if (f.requires_decision) assert.equal(f.status, 'open');
  }
});

test('证明材料全部可核验时不报缺失', () => {
  assert.equal(findingKinds().includes('missing_evidence'), false);
});
