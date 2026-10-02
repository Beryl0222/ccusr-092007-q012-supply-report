import test from 'node:test';
import assert from 'node:assert/strict';
import { findOverlaps } from '../src/overlap.js';
import { loadSample } from './helpers.js';

test('识别委托链重叠：委托方与受托方同时计入同一批库存', async () => {
  const record = await loadSample();
  const findings = findOverlaps(record);
  const entrusted = findings.filter((f) => f.kind === 'entrusted_chain');

  assert.equal(entrusted.length, 1);
  const [finding] = entrusted;
  assert.equal(finding.relation_id, 'rel-1');
  assert.deepEqual(finding.parties, ['ent-a', 'ent-b']);
  assert.deepEqual(finding.candidate_double_count, { qty: 12000, unit: 'box' });
  assert.equal(finding.status, 'pending');
});

test('识别上下级汇总重叠：园区覆盖企业、地区覆盖园区', async () => {
  const record = await loadSample();
  const hierarchical = findOverlaps(record).filter((f) => f.kind === 'hierarchical');

  assert.equal(hierarchical.length, 3);
  const pairs = hierarchical.map((f) => `${f.parent.actor_id}>${f.child.actor_id}`).sort();
  assert.deepEqual(pairs, ['park-01>ent-a', 'park-01>ent-b', 'region-01>park-01']);
  assert.ok(hierarchical.every((f) => f.status === 'pending'));
});
