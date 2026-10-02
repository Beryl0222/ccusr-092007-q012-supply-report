/**
 * 单位换算规则：版本化、按生效时间解析。
 * 规则修订（如每盒 10 支 → 12 支）不回头改写历史快照；月报重算时按
 * 快照时点选规则，并只重算 affected_metrics 里声明的指标。
 */

import { Decimal } from './decimal.js';

export class UnitRuleBook {
  /** @param {Array<object>} rules */
  constructor(rules) {
    this.rules = rules.map((r) => ({ ...r }));
  }

  /**
   * 取某一时点生效的换算规则版本。
   * @param {string} ruleId
   * @param {string|Date} at ISO 时间
   */
  resolve(ruleId, at) {
    const t = new Date(at).getTime();
    const hits = this.rules
      .filter((r) => r.rule_id === ruleId)
      .filter((r) => new Date(r.effective_from).getTime() <= t)
      .filter((r) => !r.effective_to || new Date(r.effective_to).getTime() >= t)
      .sort((a, b) => b.version - a.version);
    if (!hits.length) throw new Error(`时点 ${at} 没有生效的换算规则 ${ruleId}`);
    return hits[0];
  }

  /** 按指定规则版本换算（复算快照时用，避免误用新规则）。 */
  convert(quantity, rule) {
    return {
      quantity: Decimal.of(quantity).mul(Decimal.of(rule.factor)),
      rule_id: rule.rule_id,
      version: rule.version,
      to_unit: rule.to_unit,
    };
  }

  /** 规则修订后，判断指标是否需要重算。 */
  metricAffected(rule, metricName) {
    return rule.affected_metrics.includes(metricName);
  }
}
