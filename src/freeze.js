/**
 * 月报冻结：发布后保持冻结，禁止改写本期申报与指标；
 * 换算规则修订只重算明确受影响的指标（depends_on 命中被改规则），
 * 其余指标保持发布时的值不变。
 */

/** 发布月报，返回冻结的报表对象。metrics 的每项需声明 depends_on（规则编号列表）。 */
export function publishMonthlyReport(record, { metrics, publishedAt }) {
  return {
    period: record.period,
    record_id: record.record_id,
    status: 'published',
    frozen: true,
    published_at: publishedAt ?? new Date().toISOString(),
    conversion_rules: structuredClone(record.conversion_rules ?? []),
    metrics: { ...metrics },
  };
}

/** 已冻结的报表禁止改写，改写前调用本函数把关。 */
export function assertReportMutable(report) {
  if (report?.frozen) throw new Error(`月报 ${report.period} 已发布冻结，禁止改写`);
}

/**
 * 换算规则修订：对比发布时快照的规则，只重算 depends_on 命中
 * 被修订规则的指标。返回新报表与重算清单，原报表不被修改。
 * @param {(metric: object, nextRules: object[]) => object} recomputeMetric
 */
export function reviseConversionRules(report, nextRules, recomputeMetric) {
  if (!report?.frozen) throw new Error('只能修订已发布冻结的月报');

  const previous = new Map((report.conversion_rules ?? []).map((r) => [r.rule_id, r]));
  const changedRuleIds = new Set();
  for (const rule of nextRules ?? []) {
    const old = previous.get(rule.rule_id);
    if (!old || old.factor !== rule.factor || old.effective_from !== rule.effective_from) {
      changedRuleIds.add(rule.rule_id);
    }
  }

  const metrics = { ...report.metrics };
  const recomputed = [];
  const skipped = [];
  for (const [key, metric] of Object.entries(report.metrics)) {
    const affected = (metric.depends_on ?? []).some((id) => changedRuleIds.has(id));
    if (affected) {
      metrics[key] = recomputeMetric(metric, nextRules);
      recomputed.push(key);
    } else {
      skipped.push(key);
    }
  }

  return {
    report: {
      ...report,
      revision: (report.revision ?? 1) + 1,
      conversion_rules: structuredClone(nextRules),
      metrics,
    },
    recomputed,
    skipped,
  };
}
