import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReportMutable, publishMonthlyReport, reviseConversionRules } from '../src/freeze.js';
import { loadSample } from './helpers.js';

function publishedReport(record) {
  return publishMonthlyReport(record, {
    publishedAt: '2026-09-30T12:00:00+08:00',
    metrics: {
      'drug-1:available_su': {
        key: 'drug-1:available_su',
        drug_id: 'drug-1',
        depends_on: ['conv-drug-1-box-su'],
        value: 246000,
      },
      'drug-1:declaration_count': {
        key: 'drug-1:declaration_count',
        drug_id: 'drug-1',
        depends_on: [],
        value: 7,
      },
    },
  });
}

test('月报发布后保持冻结，禁止改写', async () => {
  const record = await loadSample();
  const report = publishedReport(record);

  assert.equal(report.frozen, true);
  assert.throws(() => assertReportMutable(report), /已发布冻结/);
  assert.doesNotThrow(() => assertReportMutable({ ...report, frozen: false }));
});

test('换算规则修订只重算明确受影响的指标', async () => {
  const record = await loadSample();
  const report = publishedReport(record);
  const nextRules = [{ ...record.conversion_rules[0], factor: 25 }];

  const { report: revised, recomputed, skipped } = reviseConversionRules(
    report,
    nextRules,
    (metric, rules) => {
      const rule = rules.find((r) => r.rule_id === 'conv-drug-1-box-su');
      return { ...metric, value: (metric.value / 20) * rule.factor };
    },
  );

  assert.deepEqual(recomputed, ['drug-1:available_su']);
  assert.deepEqual(skipped, ['drug-1:declaration_count']);
  assert.equal(revised.metrics['drug-1:available_su'].value, 307500);
  assert.equal(revised.metrics['drug-1:declaration_count'].value, 7);
  assert.equal(revised.metrics['drug-1:declaration_count'], report.metrics['drug-1:declaration_count']);
  assert.equal(report.metrics['drug-1:available_su'].value, 246000); // 原报表不被修改
  assert.equal(revised.frozen, true);
});

test('未冻结的报表不能走规则修订流程', async () => {
  const record = await loadSample();
  const draft = { ...publishedReport(record), frozen: false };
  assert.throws(() => reviseConversionRules(draft, [], () => ({})), /已发布冻结/);
});
