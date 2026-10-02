import { findConversionRule } from './declaration.js';
import { findOverlaps } from './overlap.js';
import { classifyDeclaration } from './batches.js';

/**
 * 对账复算：以最底层责任主体（无下级的企业）的申报为准重算库存，
 * 避免层级汇总重复计数；委托链重叠只在有权人员确认后才抵扣。
 * 名义库存 = 全部在账数量；真正可用库存 = 名义 − 质量隔离 − 已确认重复。
 */

/** 把某药品的数量换算成标准单位。缺少换算规则时抛错（校验阶段应已拦截）。 */
export function toStandardUnits(record, drugId, qty, unit) {
  if (unit === record.standard_unit) return qty;
  const rule = findConversionRule(record.conversion_rules, drugId, unit, record.standard_unit);
  if (!rule) throw new Error(`缺少换算规则: ${drugId} ${unit} -> ${record.standard_unit}`);
  return qty * rule.factor;
}

/** 无下级的责任主体（叶子），复算只采用它们的申报。 */
function leafActorIds(record) {
  const parents = new Set((record.actors ?? []).map((a) => a.parent).filter(Boolean));
  return new Set((record.actors ?? []).filter((a) => !parents.has(a.actor_id)).map((a) => a.actor_id));
}

/**
 * 指定快照时刻生效的申报集合：
 * 只纳入 submitted_at 不晚于快照的批次；可见的更正批次按 line_id
 * 覆盖被更正申报的对应行，被覆盖行带上 corrected_by 标记。
 */
export function effectiveDeclarations(record, snapshotAt) {
  const ts = Date.parse(snapshotAt);
  const visible = (record.declarations ?? []).filter((d) => Date.parse(d.submitted_at) <= ts);
  const byId = new Map(visible.map((d) => [d.declaration_id, d]));

  const correctedLines = new Map();
  const corrections = visible
    .filter((d) => d.kind === 'correction')
    .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
  for (const corr of corrections) {
    const target = byId.get(corr.supersedes);
    if (!target || target.kind === 'correction') continue;
    const lines = correctedLines.get(target.declaration_id)
      ?? new Map((target.lines ?? []).map((l) => [l.line_id, l]));
    for (const line of corr.lines ?? []) {
      lines.set(line.line_id, { ...line, corrected_by: corr.declaration_id });
    }
    correctedLines.set(target.declaration_id, lines);
  }

  return visible
    .filter((d) => d.kind !== 'correction')
    .map((d) => (correctedLines.has(d.declaration_id)
      ? { ...d, lines: [...correctedLines.get(d.declaration_id).values()] }
      : d));
}

/**
 * 在指定快照上复算各药品的名义库存与真正可用库存（标准单位）。
 * @param {object[]} [adoptions] 已确认的采用值（adoption.js 输出）
 * @returns {{
 *   snapshot_at: string,
 *   standard_unit: string,
 *   drugs: Record<string, {nominal_su: number, quality_isolated_su: number,
 *     available_su: number, unconfirmed_overlap_su: number}>,
 *   pending_items: object[],
 *   declarations_used: string[]
 * }}
 */
export function recomputeAtSnapshot(record, snapshotAt, { adoptions = [], findings } = {}) {
  findings ??= findOverlaps(record);
  const leaves = leafActorIds(record);
  const effective = effectiveDeclarations(record, snapshotAt).filter((d) => leaves.has(d.actor_id));

  const drugs = new Map();
  const bucket = (drugId) => {
    if (!drugs.has(drugId)) {
      drugs.set(drugId, {
        nominal_su: 0,
        quality_isolated_su: 0,
        available_su: 0,
        unconfirmed_overlap_su: 0,
      });
    }
    return drugs.get(drugId);
  };

  for (const decl of effective) {
    for (const line of decl.lines ?? []) {
      const su = toStandardUnits(record, line.drug_id, line.qty, line.unit);
      const acc = bucket(line.drug_id);
      acc.nominal_su += su;
      if (line.inventory_status === 'quality_isolated') acc.quality_isolated_su += su;
      else acc.available_su += su;
    }
  }

  // 委托链重叠：已确认的按采用值抵扣；未确认的记为未决，不擅自抵扣。
  const adoptedByFinding = new Map(adoptions.map((a) => [a.finding_id, a]));
  const pending = [];
  for (const finding of findings) {
    if (finding.kind !== 'entrusted_chain') continue;
    const candidateSu = toStandardUnits(
      record, finding.drug_id,
      finding.candidate_double_count.qty, finding.candidate_double_count.unit,
    );
    const adoption = adoptedByFinding.get(finding.finding_id);
    if (adoption) {
      const deductSu = toStandardUnits(
        record, finding.drug_id,
        adoption.adopted_value.qty, adoption.adopted_value.unit,
      );
      const acc = bucket(finding.drug_id);
      acc.nominal_su -= deductSu;
      acc.available_su -= deductSu;
    } else {
      bucket(finding.drug_id).unconfirmed_overlap_su += candidateSu;
      pending.push({ ...finding, impact_su: candidateSu });
    }
  }

  return {
    snapshot_at: snapshotAt,
    standard_unit: record.standard_unit,
    drugs: Object.fromEntries(drugs),
    pending_items: pending,
    declarations_used: effective.map((d) => d.declaration_id),
  };
}

/**
 * 值班下钻视图：从地区总数进入差异来源与未决事项。
 * @returns {{
 *   snapshot_at: string,
 *   region: {actor_id: string, declared: Record<string, number>},
 *   recomputed: ReturnType<typeof recomputeAtSnapshot>,
 *   difference_sources: object[],
 *   pending_items: object[]
 * }}
 */
export function drillDownRegionTotal(record, snapshotAt, { adoptions = [] } = {}) {
  const findings = findOverlaps(record);
  const recomputed = recomputeAtSnapshot(record, snapshotAt, { adoptions, findings });

  const regionActor = (record.actors ?? []).find((a) => a.kind === 'region');
  const regionDecl = (record.declarations ?? []).find(
    (d) => d.actor_id === regionActor?.actor_id && d.kind === 'original',
  );
  const declared = {};
  for (const line of regionDecl?.lines ?? []) {
    declared[line.drug_id] = (declared[line.drug_id] ?? 0)
      + toStandardUnits(record, line.drug_id, line.qty, line.unit);
  }

  const adoptedIds = new Set(adoptions.map((a) => a.finding_id));
  const differenceSources = [];
  for (const finding of findings) {
    if (finding.kind !== 'entrusted_chain') continue;
    differenceSources.push({
      kind: 'entrusted_double_count',
      finding_id: finding.finding_id,
      drug_id: finding.drug_id,
      impact_su: toStandardUnits(
        record, finding.drug_id,
        finding.candidate_double_count.qty, finding.candidate_double_count.unit,
      ),
      status: adoptedIds.has(finding.finding_id) ? 'confirmed' : 'pending',
    });
  }
  for (const [drugId, acc] of Object.entries(recomputed.drugs)) {
    if (acc.quality_isolated_su > 0) {
      differenceSources.push({
        kind: 'quality_isolation',
        drug_id: drugId,
        impact_su: acc.quality_isolated_su,
        status: 'confirmed',
        detail: '质量隔离部分计入名义库存，不计入可用库存',
      });
    }
  }
  const lateIds = (record.declarations ?? [])
    .filter((d) => classifyDeclaration(d) === 'late')
    .map((d) => d.declaration_id);
  if (lateIds.length) {
    differenceSources.push({
      kind: 'late_declaration',
      declaration_ids: lateIds,
      status: 'pending',
      detail: '迟报批次另成批次，是否纳入本期由有权人员确认',
    });
  }

  return {
    snapshot_at: snapshotAt,
    region: { actor_id: regionActor?.actor_id ?? null, declared },
    recomputed,
    difference_sources: differenceSources,
    pending_items: recomputed.pending_items,
  };
}
