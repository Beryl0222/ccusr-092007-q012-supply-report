import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.js';
import { DecisionLedger } from '../src/decisions.js';
import { viewFor } from '../src/views.js';
import { loadScenario, septemberSnapshot, ruleBook } from './helpers.js';

const raw = await loadScenario();
const snap = septemberSnapshot(raw);
const annotated = new DecisionLedger().annotate(reconcile(snap, ruleBook(raw)));

test('值班视图：从地区总数进入差异来源、未决事项与名义/可用', () => {
  const v = viewFor(annotated, snap, { id: 'OFFICER-1', role: 'regulator' });
  const region = v.region_totals.find((t) => t.region_id === 'REG-1');
  assert.equal(region.raw_nominal_std, '6100');
  assert.equal(region.deduplicated_nominal_std, '5100');

  // 差异来源可追到委托双计与上下级重叠
  assert.ok(v.difference_sources.consignment_double_count.length >= 1);
  assert.ok(v.difference_sources.hierarchy_overlap.some((f) => f.subject_ids.includes('REG-1')));
  // 未决事项列出建议值
  assert.ok(v.open_decisions.every((d) => d.proposed));
  assert.ok(v.open_decisions.some((d) => d.kind === 'late_report'));
  // 名义/可用并列
  const b = v.nominal_vs_available.find((s) => s.subject_id === 'ENT-B');
  assert.equal(b.nominal_std, '3100');
  assert.equal(b.available_std, '3000');
  assert.equal(b.unavailable_std, '100');
  // 监管可见产线明细
  assert.ok(b.lines.some((l) => l.line_ids.includes('B-L1')));
  // 视图带快照锚点
  assert.equal(v.snapshot.snapshot_id, snap.snapshot_id);
});

test('企业视图：只见自己的校验问题、采用值与自有产线', () => {
  const receipts = [
    { receipt_id: 'R-A', declaration_id: 'DEC-A', received_at: '2026-09-20T09:00:00+08:00', status: 'accepted', issues: [] },
    { receipt_id: 'R-B', declaration_id: 'DEC-B', received_at: '2026-09-20T10:30:00+08:00', status: 'accepted', issues: [] },
  ];
  const view = viewFor(annotated, snap, { id: 'ENT-A', role: 'enterprise' }, { receipts });
  // 只拿到自己的回执
  assert.deepEqual(view.receipts.map((r) => r.declaration_id), ['DEC-A']);
  // 差异只涉及自己
  assert.ok(view.findings.length > 0);
  assert.ok(view.findings.every((f) => f.subject_ids.includes('ENT-A')));
  // 看不到乙的任何数据
  assert.ok(!JSON.stringify(view).includes('ENT-B'));
  assert.ok(!JSON.stringify(view).includes('B-L1'));
  // 可看自己的产线
  assert.ok(view.stock.lines.some((l) => l.line_ids.includes('A-L1')));
});

test('园区视图：可见下级批次数字与差异，但产线明细脱敏', () => {
  const view = viewFor(annotated, snap, { id: 'PARK-X', role: 'park' });
  const ids = view.subjects.map((s) => s.subject_id).sort();
  assert.deepEqual(ids, ['ENT-A', 'ENT-B']);
  for (const s of view.subjects) {
    assert.ok(s.lines.every((l) => l.line_detail === 'redacted'));
    assert.ok(!JSON.stringify(s.lines).includes('L1'));
  }
});

test('其他企业与无关部门看不到任何数据', () => {
  const stranger = viewFor(annotated, snap, { id: 'ENT-Z', role: 'enterprise' });
  assert.deepEqual(stranger.subjects, []);
  assert.equal(stranger.findings.length, 0);

  const outsider = viewFor(annotated, snap, { id: 'DEPT-OTHER', role: 'other_department' });
  assert.deepEqual(outsider.subjects, []);
  assert.equal(outsider.findings.length, 0);
});

test('企业视图可看到监管对自己相关差异的采用值', () => {
  const ledger = new DecisionLedger();
  const result = reconcile(snap, ruleBook(raw));
  const f = result.findings.find((x) => x.kind === 'consignment_double_count');
  ledger.adopt({ snapshot_id: snap.snapshot_id, finding_id: f.id, actor: { id: 'R1', role: 'regulator' }, adopted_value: '1000', decided_at: '2026-09-22T09:00:00+08:00' });
  const view = viewFor(ledger.annotate(result), snap, { id: 'ENT-A', role: 'enterprise' });
  const mine = view.findings.find((x) => x.id === f.id);
  assert.equal(mine.decision_state, 'resolved');
  assert.equal(mine.adopted_value, '1000');
});
