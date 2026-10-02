import test from 'node:test';
import assert from 'node:assert/strict';
import { IntakeRegistry } from '../src/intake.js';

const subjects = [{ id: 'ENT-A' }, { id: 'ENT-B' }];
const deadline = '2026-09-21T18:00:00+08:00';

const baseDeclaration = () => ({
  declaration_id: 'DEC-T1',
  kind: 'entity',
  subject_id: 'ENT-A',
  drug_id: 'DRG-001',
  submitted_at: '2026-09-20T09:00:00+08:00',
  batches: [
    { batch_id: 'b1', batch_type: 'normal', status: 'available', quantity: '100', unit: 'box', evidence_ids: ['e1'] },
  ],
});

test('企业重试必须返回同一张回执（幂等）', () => {
  const reg = new IntakeRegistry({ subjects });
  const decl = baseDeclaration();
  const ctx = { idempotency_key: 'key-1', period: '2026-09', received_at: '2026-09-20T09:05:00+08:00', deadline };
  const first = reg.submit(decl, ctx);
  const second = reg.submit(baseDeclaration(), { ...ctx, received_at: '2026-09-20T09:06:00+08:00' });
  assert.equal(second.receipt_id, first.receipt_id);
  assert.equal(second.received_at, first.received_at); // 回执不被重试覆盖
  assert.equal(reg.acceptedDeclarations.length, 1);
});

test('同一幂等键配不同内容被拒绝', () => {
  const reg = new IntakeRegistry({ subjects });
  const ctx = { idempotency_key: 'key-2', period: '2026-09', received_at: '2026-09-20T09:05:00+08:00', deadline };
  reg.submit(baseDeclaration(), ctx);
  const changed = baseDeclaration();
  changed.batches[0].quantity = '200';
  assert.throws(() => reg.submit(changed, ctx), /已用于不同内容/);
});

test('迟报的普通批次自动另成 late 批次并在回执中告知', () => {
  const reg = new IntakeRegistry({ subjects });
  const receipt = reg.submit(baseDeclaration(), {
    idempotency_key: 'key-3', period: '2026-09', received_at: '2026-09-22T10:00:00+08:00', deadline,
  });
  assert.equal(receipt.status, 'accepted_with_issues');
  assert.equal(receipt.issues.some((i) => i.code === 'LATE_BATCH'), true);
  assert.equal(reg.acceptedDeclarations[0].batches[0].batch_type, 'late');
});

test('更正批次取代旧批次但旧批次留痕', () => {
  const reg = new IntakeRegistry({ subjects });
  reg.submit(baseDeclaration(), { idempotency_key: 'k-a', period: '2026-09', received_at: '2026-09-20T09:05:00+08:00', deadline });
  const correction = {
    declaration_id: 'DEC-T2', kind: 'entity', subject_id: 'ENT-A', drug_id: 'DRG-001',
    submitted_at: '2026-09-20T12:00:00+08:00',
    batches: [
      { batch_id: 'b1-fix', batch_type: 'correction', status: 'available', quantity: '90', unit: 'box', correction_target: 'b1', evidence_ids: ['e2'] },
    ],
  };
  const receipt = reg.submit(correction, { idempotency_key: 'k-b', period: '2026-09', received_at: '2026-09-20T12:05:00+08:00', deadline });
  assert.equal(receipt.status, 'accepted');
  assert.equal(reg.acceptedDeclarations.find((d) => d.declaration_id === 'DEC-T1').batches[0].superseded, true);
  const trail = reg.supersededBatches();
  assert.equal(trail.length, 1);
  assert.equal(trail[0].batch_id, 'b1');
  assert.equal(trail[0].superseded_by, 'b1-fix');
});

test('退货回库与质量隔离各自成批次；隔离状态混进 normal 直接报错', () => {
  const reg = new IntakeRegistry({ subjects });
  const good = {
    declaration_id: 'D-R', kind: 'entity', subject_id: 'ENT-A', drug_id: 'D',
    submitted_at: '2026-09-20T09:00:00+08:00',
    batches: [
      { batch_id: 'r1', batch_type: 'return_to_stock', status: 'available', quantity: '5', unit: 'box', evidence_ids: ['e'] },
      { batch_id: 'q1', batch_type: 'quarantine', status: 'quarantined', quantity: '3', unit: 'box', evidence_ids: ['e'] },
    ],
  };
  assert.equal(reg.submit(good, { idempotency_key: 'k-ret', period: '2026-09', received_at: '2026-09-20T09:05:00+08:00', deadline }).status, 'accepted');

  const bad = {
    declaration_id: 'D-BAD', kind: 'entity', subject_id: 'ENT-A', drug_id: 'D',
    submitted_at: '2026-09-20T09:00:00+08:00',
    batches: [
      { batch_id: 'x1', batch_type: 'normal', status: 'quarantined', quantity: '3', unit: 'box', evidence_ids: ['e'] },
    ],
  };
  const receipt = reg.submit(bad, { idempotency_key: 'k-bad', period: '2026-09', received_at: '2026-09-20T09:05:00+08:00', deadline });
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.issues.some((i) => i.code === 'QUARANTINE_MUST_BE_OWN_BATCH'), true);
});

test('月报冻结后该期申报被拒收并指引下一期', () => {
  const reg = new IntakeRegistry({ subjects, frozenPeriods: new Set(['2026-09']) });
  const receipt = reg.submit(baseDeclaration(), { idempotency_key: 'k-frozen', period: '2026-09', received_at: '2026-09-25T09:00:00+08:00', deadline });
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.issues[0].code, 'PERIOD_FROZEN');
  assert.equal(reg.acceptedDeclarations.length, 0);
});
