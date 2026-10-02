import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.js';
import { DecisionLedger } from '../src/decisions.js';
import { MonthlyReportRegistry } from '../src/reports.js';
import { loadScenario, septemberSnapshot, octoberSnapshot, ruleBook } from './helpers.js';

const raw = await loadScenario();

test('只有监管人员能确认采用值；决策锚定快照', () => {
  const snap = septemberSnapshot(raw);
  const ledger = new DecisionLedger();
  const result = reconcile(snap, ruleBook(raw));
  const finding = result.findings.find((f) => f.kind === 'hierarchy_overlap' && f.metric === 'nominal_quantity_std');

  assert.throws(
    () => ledger.adopt({ snapshot_id: snap.snapshot_id, finding_id: finding.id, actor: { id: 'ENT-A', role: 'enterprise' }, adopted_value: '5100', decided_at: '2026-09-22T09:00:00+08:00' }),
    /只有监管人员/,
  );

  ledger.adopt({ snapshot_id: snap.snapshot_id, finding_id: finding.id, actor: { id: 'REG-OFFICER-1', role: 'regulator' }, adopted_value: '5100', decided_at: '2026-09-22T09:00:00+08:00' });
  const annotated = ledger.annotate(result);
  const decided = annotated.findings.find((f) => f.id === finding.id);
  assert.equal(decided.decision.state, 'resolved');
  assert.equal(decided.decision.adopted_value, '5100');
});

test('月报发布后冻结：不能重复发布，冻结快照不能再登记决策', () => {
  const snap = septemberSnapshot(raw);
  const ledger = new DecisionLedger();
  const reports = new MonthlyReportRegistry(ruleBook(raw), ledger);
  const draft = reports.build('2026-09', snap);
  assert.equal(draft.metrics.nominal_quantity_std, '5100');
  assert.equal(draft.metrics.available_quantity_std, '5000');
  assert.equal(draft.metrics.late_nominal_std, '200');

  const published = reports.publish(draft);
  assert.equal(published.status, 'published_frozen');
  assert.throws(() => reports.publish(reports.build('2026-09', snap)), /已发布/);
  assert.equal(ledger.isFrozen(snap.snapshot_id), true);

  const someOpen = reconcile(snap, ruleBook(raw)).findings.find((f) => f.status === 'open');
  assert.throws(
    () => ledger.adopt({ snapshot_id: snap.snapshot_id, finding_id: someOpen.id, actor: { id: 'R', role: 'regulator' }, adopted_value: '1', decided_at: '2026-09-25T00:00:00+08:00' }),
    /冻结/,
  );
  // 已发布月报数字不变
  assert.equal(reports.get('2026-09').metrics.nominal_quantity_std, '5100');
});

test('指定快照可复算，结果一致', () => {
  const snap1 = septemberSnapshot(raw);
  const snap2 = septemberSnapshot(raw);
  const ledger = new DecisionLedger();
  const reports = new MonthlyReportRegistry(ruleBook(raw), ledger);
  const a = reports.build('2026-09', snap1);
  const b = reports.build('2026-09', snap2);
  assert.equal(a.snapshot_id, b.snapshot_id);
  assert.deepEqual(a.metrics, b.metrics);
});

test('换算规则修订只重算受影响指标，未声明的指标保持冻结值', () => {
  const sept = septemberSnapshot(raw);
  const oct = octoberSnapshot(raw);
  const ledger = new DecisionLedger();
  const reports = new MonthlyReportRegistry(ruleBook(raw), ledger);
  const published = reports.publish(reports.build('2026-09', sept));

  const proposal = reports.recomputeWithRuleRevision(published, oct, 'box-to-vial');
  // 规则 v2 只声明影响 nominal/available；重叠量与迟报量保持九月冻结值
  assert.equal(proposal.rule_change.new_version, 2);
  assert.equal(proposal.unchanged_metrics.consignment_overlap_std, '1000');
  assert.equal(proposal.unchanged_metrics.late_nominal_std, '200');
  // 受影响指标按 factor 12 重算：去重名义 510 盒 × 12 = 6120 支
  assert.equal(proposal.recomputed_metrics.nominal_quantity_std, '6120');
  assert.equal(proposal.recomputed_metrics.available_quantity_std, '6000');
  // 原月报仍然冻结
  assert.equal(reports.get('2026-09').metrics.nominal_quantity_std, '5100');
  assert.equal(proposal.status, 'revision_proposal');
});
