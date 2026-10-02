import test from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptStore } from '../src/receipts.js';
import { loadSample } from './helpers.js';

test('企业提交重试返回同一回执：编号与接收时间不变', async () => {
  const record = await loadSample();
  const decl = record.declarations[0];
  const store = new ReceiptStore();

  const first = store.issue(decl, '2026-09-20T09:00:05+08:00');
  const retry = store.issue(decl, '2026-09-20T09:31:42+08:00');

  assert.equal(retry.receipt_id, first.receipt_id);
  assert.equal(retry.received_at, '2026-09-20T09:00:05+08:00');
  assert.equal(retry, first);
});

test('不同申报批次得到不同回执', async () => {
  const record = await loadSample();
  const store = new ReceiptStore();
  const [a, b] = record.declarations;

  const receiptA = store.issue(a);
  const receiptB = store.issue(b);

  assert.notEqual(receiptA.receipt_id, receiptB.receipt_id);
  assert.equal(store.lookup(a.declaration_id).receipt_id, receiptA.receipt_id);
  assert.equal(store.lookup('decl-unknown'), null);
});
