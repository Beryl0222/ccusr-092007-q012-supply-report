import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBatches, classifyDeclaration } from '../src/batches.js';
import { loadSample } from './helpers.js';

test('迟报、更正、退货回库、质量隔离各自另成批次', async () => {
  const record = await loadSample();
  const batches = buildBatches(record);
  const byKind = new Map(batches.map((b) => [b.kind, b.declaration_ids]));

  assert.deepEqual(byKind.get('on_time'), [
    'decl-ent-a-2026-09',
    'decl-park-2026-09',
    'decl-region-2026-09',
  ]);
  assert.deepEqual(byKind.get('late'), ['decl-ent-b-2026-09']);
  assert.deepEqual(byKind.get('correction'), ['decl-ent-a-corr-01']);
  assert.deepEqual(byKind.get('return_to_stock'), ['decl-ent-a-return-01']);
  assert.deepEqual(byKind.get('quality_isolation'), ['decl-ent-b-iso-01']);

  const batchIds = batches.map((b) => b.batch_id);
  assert.equal(new Set(batchIds).size, batchIds.length);
});

test('迟报按提交时间与截止时间判定', async () => {
  const record = await loadSample();
  const byId = new Map(record.declarations.map((d) => [d.declaration_id, d]));

  assert.equal(classifyDeclaration(byId.get('decl-ent-a-2026-09')), 'on_time');
  assert.equal(classifyDeclaration(byId.get('decl-ent-b-2026-09')), 'late');
});
