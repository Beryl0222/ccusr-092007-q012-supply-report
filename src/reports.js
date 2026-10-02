/**
 * 月报：
 *  - 发布（publish）后冻结：发布所依据的快照、对账结果、采用值全部固定，
 *    后续申报或更正不得改写已发布数字。
 *  - 复算（recompute）始终锚定指定快照，同一快照 + 同一规则版本必得同一结果。
 *  - 换算规则修订时，只重算规则 affected_metrics 声明的指标，其他指标保持不变。
 */

import { reconcile } from './reconcile.js';

const METRIC_BUILDERS = {
  // 指标名 → 从对账结果取值
  nominal_quantity_std: (r) => r.aggregate_totals[0]?.deduplicated_nominal_std ?? null,
  available_quantity_std: (r) => r.aggregate_totals[0]?.deduplicated_available_std ?? null,
  consignment_overlap_std: (r) => r.aggregate_totals[0]?.consignment_overlap_std ?? null,
  late_nominal_std: (r) => r.aggregate_totals[0]?.late_nominal_std ?? null,
};

export class MonthlyReportRegistry {
  /**
   * @param {UnitRuleBook} ruleBook
   * @param {DecisionLedger} ledger
   */
  constructor(ruleBook, ledger) {
    this.ruleBook = ruleBook;
    this.ledger = ledger;
    /** @type {Map<string, object>} period → 已发布月报 */
    this._published = new Map();
  }

  /**
   * 在指定快照上生成月报（未发布，可反复试算）。
   * @param {string} period
   * @param {Snapshot} snapshot
   */
  build(period, snapshot) {
    const result = reconcile(snapshot, this.ruleBook);
    const annotated = this.ledger.annotate(result);
    const metrics = {};
    for (const [name, take] of Object.entries(METRIC_BUILDERS)) {
      metrics[name] = take(annotated);
    }
    const pending = annotated.findings.filter((f) => f.decision?.state === 'pending');
    return {
      period,
      snapshot_id: snapshot.snapshot_id,
      captured_at: snapshot.captured_at,
      unit_rule: result.unit_rule,
      standard_unit: result.standard_unit,
      metrics,
      open_findings: pending.map((f) => ({ id: f.id, kind: f.kind, message: f.message, proposed: f.proposed })),
      status: 'draft',
    };
  }

  /** 发布月报：冻结快照与采用值，数字自此不可变。 */
  publish(report) {
    if (this._published.has(report.period)) {
      throw new Error(`${report.period} 月报已发布，不能重复发布`);
    }
    this.ledger.freezeSnapshot(report.snapshot_id);
    const frozen = Object.freeze({
      ...report,
      status: 'published_frozen',
      published_at: new Date().toISOString(),
    });
    this._published.set(report.period, frozen);
    return frozen;
  }

  get(period) {
    return this._published.get(period) ?? null;
  }

  /**
   * 规则修订后的定向重算：只重算受影响指标，其余指标与依据原样保留。
   * 已发布月报本身不动；重算结果作为下一期草稿或修订建议存在。
   *
   * @param {object} published 已发布月报
   * @param {Snapshot} newSnapshot 新快照（含新规则，captured_at 落在新生效区间）
   * @param {string} changedRuleId 修订的换算规则
   */
  recomputeWithRuleRevision(published, newSnapshot, changedRuleId) {
    if (published.status !== 'published_frozen') throw new Error('只能基于已发布月报做修订重算');
    const newRule = this.ruleBook.resolve(changedRuleId, newSnapshot.captured_at);

    const rebuilt = this.build(published.period, newSnapshot);
    const recomputedMetrics = {};
    const unchangedMetrics = {};
    for (const [name, value] of Object.entries(published.metrics)) {
      if (this.ruleBook.metricAffected(newRule, name)) {
        recomputedMetrics[name] = rebuilt.metrics[name];
      } else {
        unchangedMetrics[name] = value; // 未声明受影响的指标绝不重算
      }
    }
    return {
      period: published.period,
      based_on_published_snapshot: published.snapshot_id,
      recomputed_on_snapshot: newSnapshot.snapshot_id,
      rule_change: { rule_id: changedRuleId, new_version: newRule.version, new_factor: newRule.factor },
      recomputed_metrics: recomputedMetrics,
      unchanged_metrics: unchangedMetrics,
      status: 'revision_proposal',
      note: '已发布月报保持冻结；本结果仅为修订建议，采用须由监管人员确认',
    };
  }
}
