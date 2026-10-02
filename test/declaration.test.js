import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDeclarationSet } from '../src/declaration.js';
import { loadSample } from './helpers.js';

test('业务样例通过全部声明要素校验', async () => {
  const record = await loadSample();
  assert.deepEqual(validateDeclarationSet(record), []);
});

test('校验问题带主体标识，便于企业端只展示自己的问题', async () => {
  const record = await loadSample();
  const broken = structuredClone(record);
  broken.declarations[0].lines[0].evidence = ['ev-missing'];
  broken.declarations[1].lines[0].inventory_status = 'unknown_status';
  delete broken.declarations[1].window;

  const issues = validateDeclarationSet(broken);
  const byCode = new Map(issues.map((i) => [i.code, i]));
  assert.equal(byCode.get('UNKNOWN_EVIDENCE').actor_id, 'ent-a');
  assert.equal(byCode.get('UNKNOWN_STATUS').actor_id, 'ent-b');
  assert.equal(byCode.get('BAD_WINDOW').actor_id, 'ent-b');
});

test('缺少换算规则与生产关系角色不一致会被拦截', async () => {
  const record = await loadSample();
  const broken = structuredClone(record);
  broken.conversion_rules = [];
  broken.declarations[1].lines[0].relation_role = 'delegator';

  const codes = validateDeclarationSet(broken).map((i) => i.code);
  assert.ok(codes.includes('MISSING_CONVERSION_RULE'));
  assert.ok(codes.includes('RELATION_MISMATCH'));
});
