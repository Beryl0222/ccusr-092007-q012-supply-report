import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../src/decimal.js';
import { UnitRuleBook } from '../src/units.js';

test('Decimal 精确运算，无浮点误差', () => {
  assert.equal(Decimal.of('0.1').add(Decimal.of('0.2')).toString(), '0.3');
  assert.equal(Decimal.of('10').mul(Decimal.of('12')).toString(), '120');
  assert.equal(Decimal.of('5100').sub(Decimal.of('1000')).toString(), '4100');
  assert.equal(Decimal.zero.isZero(), true);
  assert.throws(() => Decimal.of('abc'));
});

test('换算规则按时点解析版本，修订不回溯历史', () => {
  const book = new UnitRuleBook([
    { rule_id: 'box-to-vial', version: 1, factor: '10', effective_from: '2026-01-01T00:00:00+08:00', effective_to: '2026-09-30T23:59:59+08:00', affected_metrics: ['nominal_quantity_std', 'available_quantity_std'] },
    { rule_id: 'box-to-vial', version: 2, factor: '12', effective_from: '2026-10-01T00:00:00+08:00', effective_to: null, affected_metrics: ['nominal_quantity_std', 'available_quantity_std'] },
  ]);
  assert.equal(book.resolve('box-to-vial', '2026-09-20T09:00:00+08:00').version, 1);
  assert.equal(book.resolve('box-to-vial', '2026-10-02T09:00:00+08:00').version, 2);
  assert.equal(book.convert('100', book.resolve('box-to-vial', '2026-10-02T09:00:00+08:00')).quantity.toString(), '1200');
});

test('规则只标记声明过的指标为受影响', () => {
  const book = new UnitRuleBook([]);
  const rule = { rule_id: 'r', affected_metrics: ['nominal_quantity_std'] };
  assert.equal(book.metricAffected(rule, 'nominal_quantity_std'), true);
  assert.equal(book.metricAffected(rule, 'available_quantity_std'), false);
});
