import test from 'node:test';
import assert from 'node:assert/strict';
import { drillDownRegionTotal, effectiveDeclarations, recomputeAtSnapshot } from '../src/reconcile.js';
import { confirmAdoption } from '../src/adoption.js';
import { findOverlaps } from '../src/overlap.js';
import { loadSample } from './helpers.js';

const S1 = '2026-09-21T12:00:00+08:00'; // 更正/退货/隔离批次尚未提交
const S2 = '2026-09-24T00:00:00+08:00'; // 全部批次已提交

test('快照复算区分名义库存与真正可用库存', async () => {
  const record = await loadSample();
  const result = recomputeAtSnapshot(record, S1);

  assert.deepEqual(result.drugs['drug-1'], {
    nominal_su: 510000, // (12000 + 1500 + 12000) 盒 × 20
    quality_isolated_su: 30000,
    available_su: 480000,
    unconfirmed_overlap_su: 240000, // 委托链重叠未确认，不擅自抵扣
  });
  assert.equal(result.pending_items.length, 1);
  assert.deepEqual(result.declarations_used.sort(), [
    'decl-ent-a-2026-09',
    'decl-ent-b-2026-09',
  ]);
});

test('快照复算只纳入快照前生效的批次，更正在生效后覆盖原行', async () => {
  const record = await loadSample();

  const before = recomputeAtSnapshot(record, S1);
  assert.equal(before.drugs['drug-1'].quality_isolated_su, 30000); // 1500 盒未更正

  const after = recomputeAtSnapshot(record, S2);
  assert.deepEqual(after.drugs['drug-1'], {
    nominal_su: 528000, // (12000 + 1600 + 12000 + 300 + 500) 盒 × 20
    quality_isolated_su: 42000, // (1600 + 500) 盒 × 20
    available_su: 486000,
    unconfirmed_overlap_su: 240000,
  });

  const effective = effectiveDeclarations(record, S2);
  const corrected = effective.find((d) => d.declaration_id === 'decl-ent-a-2026-09');
  assert.equal(corrected.lines.find((l) => l.line_id === 'a-2').qty, 1600);
  assert.equal(corrected.lines.find((l) => l.line_id === 'a-2').corrected_by, 'decl-ent-a-corr-01');
});

test('确认采用值后复算才抵扣委托链重复', async () => {
  const record = await loadSample();
  const entrusted = findOverlaps(record).find((f) => f.kind === 'entrusted_chain');
  const adoption = confirmAdoption({
    finding: entrusted,
    adoptedValue: { qty: 12000, unit: 'box' },
    adoptedBy: 'reg-1',
    role: 'regulator',
    confirmedAt: '2026-09-24T09:00:00+08:00',
  });

  const result = recomputeAtSnapshot(record, S2, { adoptions: [adoption] });
  assert.equal(result.drugs['drug-1'].available_su, 246000); // 486000 − 240000
  assert.equal(result.drugs['drug-1'].nominal_su, 288000);
  assert.equal(result.drugs['drug-1'].unconfirmed_overlap_su, 0);
  assert.equal(result.pending_items.length, 0);
});

test('值班视图从地区总数进入差异来源与未决事项', async () => {
  const record = await loadSample();
  const view = drillDownRegionTotal(record, S2);

  assert.equal(view.region.actor_id, 'region-01');
  assert.equal(view.region.declared['drug-1'], 480000); // 地区报表口径（委托链重复计入）

  const entrusted = view.difference_sources.find((s) => s.kind === 'entrusted_double_count');
  assert.equal(entrusted.impact_su, 240000);
  assert.equal(entrusted.status, 'pending');

  const isolation = view.difference_sources.find((s) => s.kind === 'quality_isolation');
  assert.equal(isolation.impact_su, 42000);

  const late = view.difference_sources.find((s) => s.kind === 'late_declaration');
  assert.deepEqual(late.declaration_ids, ['decl-ent-b-2026-09']);

  assert.equal(view.pending_items.length, 1);
  assert.equal(view.recomputed.drugs['drug-1'].available_su, 486000);
});
