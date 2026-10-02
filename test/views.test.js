import test from 'node:test';
import assert from 'node:assert/strict';
import { enterpriseView, maskDeclarationForViewer } from '../src/views.js';
import { validateDeclarationSet } from '../src/declaration.js';
import { findOverlaps } from '../src/overlap.js';
import { confirmAdoption } from '../src/adoption.js';
import { ReceiptStore } from '../src/receipts.js';
import { loadSample } from './helpers.js';

test('企业端仅展示自己的校验问题、回执与采用值', async () => {
  const record = await loadSample();
  const broken = structuredClone(record);
  broken.declarations[0].lines[0].evidence = ['ev-missing']; // ent-a 的问题
  broken.declarations[1].lines[0].inventory_status = 'bad'; // ent-b 的问题
  const issues = validateDeclarationSet(broken);

  const store = new ReceiptStore();
  const receipts = record.declarations.map((d) => store.issue(d));

  const entrusted = findOverlaps(record).find((f) => f.kind === 'entrusted_chain');
  const adoption = confirmAdoption({
    finding: entrusted,
    adoptedValue: { qty: 12000, unit: 'box' },
    adoptedBy: 'reg-1',
    role: 'regulator',
  });

  const viewA = enterpriseView(record, 'ent-a', {
    issues, receipts, findings: [entrusted], adoptions: [adoption],
  });
  assert.ok(viewA.validation_issues.every((i) => i.actor_id === 'ent-a'));
  assert.ok(viewA.receipts.every((r) => r.actor_id === 'ent-a'));
  assert.equal(viewA.adopted_values.length, 1);
  assert.equal(viewA.pending_findings.length, 0);

  const viewB = enterpriseView(record, 'ent-b', {
    issues, receipts, findings: [entrusted], adoptions: [adoption],
  });
  assert.ok(viewB.validation_issues.every((i) => i.actor_id === 'ent-b'));
  assert.ok(viewB.declarations.every((d) => d.actor_id === 'ent-b'));
});

test('产线明细仅本企业与监管角色可见', async () => {
  const record = await loadSample();
  const declA = record.declarations.find((d) => d.declaration_id === 'decl-ent-a-2026-09');

  const self = maskDeclarationForViewer(declA, { actor_id: 'ent-a', role: 'enterprise' });
  assert.ok(self.production_line_details);

  const regulator = maskDeclarationForViewer(declA, { actor_id: 'reg-1', role: 'regulator' });
  assert.ok(regulator.production_line_details);

  const otherEnt = maskDeclarationForViewer(declA, { actor_id: 'ent-b', role: 'enterprise' });
  assert.equal(otherEnt.production_line_details, undefined);
  assert.deepEqual(otherEnt.masked_fields, ['production_line_details']);

  const unrelated = maskDeclarationForViewer(declA, { actor_id: 'dept-9', role: 'unrelated_department' });
  assert.equal(unrelated.production_line_details, undefined);
});
