import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmAdoption, pendingItems } from '../src/adoption.js';
import { findOverlaps } from '../src/overlap.js';
import { loadSample } from './helpers.js';

test('只有有权角色能确认采用值', async () => {
  const record = await loadSample();
  const [finding] = findOverlaps(record).filter((f) => f.kind === 'entrusted_chain');

  assert.throws(
    () => confirmAdoption({
      finding, adoptedValue: { qty: 12000, unit: 'box' }, adoptedBy: 'user-1', role: 'enterprise',
    }),
    /无权确认采用值/,
  );

  const adoption = confirmAdoption({
    finding,
    adoptedValue: { qty: 12000, unit: 'box' },
    adoptedBy: 'reg-1',
    role: 'regulator',
    confirmedAt: '2026-09-24T09:00:00+08:00',
  });
  assert.equal(adoption.finding_id, finding.finding_id);
  assert.equal(adoption.status, 'confirmed');
});

test('未确认的重叠保留在未决事项中', async () => {
  const record = await loadSample();
  const findings = findOverlaps(record);
  assert.equal(pendingItems(findings, []).length, findings.length);

  const entrusted = findings.find((f) => f.kind === 'entrusted_chain');
  const adoption = confirmAdoption({
    finding: entrusted,
    adoptedValue: { qty: 12000, unit: 'box' },
    adoptedBy: 'reg-1',
    role: 'regulator',
  });
  const remaining = pendingItems(findings, [adoption]);
  assert.equal(remaining.length, findings.length - 1);
  assert.ok(remaining.every((f) => f.finding_id !== entrusted.finding_id));
});
