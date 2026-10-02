/**
 * 对账引擎：只做事实核对，自动找出
 *  1) 上下级汇总重叠（园区/地区上报值 vs 下级实体重算值）
 *  2) 委托链重叠（委托方与受托方把同一批货各计一次）
 *  3) 单位换算差异（上报所用规则版本 vs 快照时点规则）
 *  4) 名义库存与可用库存差异（质量隔离等不可发运状态）
 *  5) 时间窗不符（迟报）与证明材料缺失
 *
 * 引擎对每个差异只给 proposed（建议值与计算依据），不自动采用；
 * 采用哪个值由有权监管人员在 decisions 台账中确认。
 *
 * 口径分桶：每个主体有 window（窗口内）与 late（迟报）两套数。
 * 地区/园区"窗口总数"只取 window 桶；迟报货物单列，是否追纳由人工决定。
 */

import { Decimal } from './decimal.js';
import { summarizeBatches } from './inventory.js';

let findingSeq = 0;
const nextFindingId = () => `F-${String(++findingSeq).padStart(3, '0')}`;

/**
 * @param {Snapshot} snapshot
 * @param {UnitRuleBook} ruleBook
 */
export function reconcile(snapshot, ruleBook) {
  findingSeq = 0;
  const snap = snapshot;
  const standardUnit = snap.data.standard_unit ?? inferUnit(snap);
  const activeRule = resolveRule(ruleBook, snap.captured_at);

  const convert = (quantity, fromUnit) => {
    if (fromUnit === standardUnit) {
      return { quantity: Decimal.of(quantity), rule_id: null, version: null };
    }
    if (!activeRule) throw new Error(`缺少 ${fromUnit}→${standardUnit} 的换算规则`);
    return ruleBook.convert(quantity, activeRule);
  };

  const declarations = snap.data.declarations ?? [];
  const entityDecls = declarations.filter((d) => d.kind !== 'aggregate');
  const aggregateDecls = declarations.filter((d) => d.kind === 'aggregate');

  // ---- 逐主体（实体层）重算：窗口桶 / 迟报桶 -------------------------------
  const subjectStats = new Map();
  for (const decl of entityDecls) {
    const win = snap.checkWindow(decl.submitted_at);
    const summary = summarizeBatches(decl.batches ?? [], convert);
    const stats = subjectStats.get(decl.subject_id) ?? emptySubjectStats();
    mergeInto(win.inWindow ? stats.window : stats.late, summary);
    if (!win.inWindow) stats.late_declarations.push(decl.declaration_id);
    subjectStats.set(decl.subject_id, stats);
  }

  // ---- 委托链重叠 -----------------------------------------------------------
  const consignmentOverlaps = findConsignmentOverlaps(entityDecls, convert, snap);

  // ---- 汇总主体（园区/地区）核对 --------------------------------------------
  const findings = [];
  for (const agg of aggregateDecls) {
    findings.push(...checkAggregate(agg, snap, subjectStats, consignmentOverlaps, nextFindingId));
  }

  // ---- 委托链本身的差异 ------------------------------------------------------
  for (const ov of consignmentOverlaps) {
    findings.push({
      id: nextFindingId(),
      kind: 'consignment_double_count',
      severity: 'high',
      subject_ids: [ov.consignor_id, ov.consignee_id],
      metric: 'nominal_quantity_std',
      values: {
        overlap_std: ov.overlap_std,
        raw_nominal_std: ov.raw_nominal_std,
        deduplicated_nominal_std: ov.deduplicated_nominal_std,
      },
      sources: ov.sources,
      message: `委托生产 ${ov.consignment_id} 被委托方与受托方各计一次，重叠 ${ov.overlap_std} ${standardUnit}`,
      proposed: {
        // 实物在受托方，建议扣除委托方一侧的申报口径；是否如此由人工确认
        value: ov.deduplicated_nominal_std,
        basis: 'dedup_consignor_side__physical_goods_at_consignee',
      },
      requires_decision: true,
      status: 'open',
    });
  }

  // ---- 隔离 / 迟报 / 证明材料 ------------------------------------------------
  findings.push(...statusAndWindowFindings(snap, subjectStats, nextFindingId));
  findings.push(...evidenceFindings(snap, entityDecls, nextFindingId));

  // ---- 地区总数（最上层）：原始 / 去重 / 含迟报 多口径 -----------------------
  const regions = snap.subjects.filter((s) => s.role === 'region');
  const totals = regions.map((r) => rollupRegion(r.id, snap, subjectStats, consignmentOverlaps));

  return {
    snapshot_id: snap.snapshot_id,
    captured_at: snap.captured_at,
    standard_unit: standardUnit,
    unit_rule: activeRule
      ? { rule_id: activeRule.rule_id, version: activeRule.version, factor: activeRule.factor }
      : null,
    subjects: [...subjectStats.entries()].map(([subject_id, s]) => ({
      subject_id,
      nominal_std: s.window.nominal.toString(),
      available_std: s.window.available.toString(),
      by_type: serializeByType(s.window.byType),
      lines: s.window.lines,
      late: {
        nominal_std: s.late.nominal.toString(),
        available_std: s.late.available.toString(),
        by_type: serializeByType(s.late.byType),
        lines: s.late.lines,
      },
      late_declarations: s.late_declarations,
    })),
    consignment_overlaps: consignmentOverlaps.map((o) => ({
      consignment_id: o.consignment_id,
      consignor_id: o.consignor_id,
      consignee_id: o.consignee_id,
      overlap_std: o.overlap_std,
    })),
    aggregate_totals: totals,
    findings: findings.sort(bySeverity),
    open_finding_ids: findings.filter((f) => f.status === 'open').map((f) => f.id),
  };
}

function resolveRule(ruleBook, at) {
  try {
    return ruleBook.resolve('box-to-vial', at);
  } catch {
    return null;
  }
}

function emptyBucket() {
  return { nominal: Decimal.zero, available: Decimal.zero, byType: {}, lines: [] };
}

function emptySubjectStats() {
  return { window: emptyBucket(), late: emptyBucket(), late_declarations: [] };
}

function mergeInto(bucket, summary) {
  bucket.nominal = bucket.nominal.add(summary.nominal);
  bucket.available = bucket.available.add(summary.available);
  bucket.lines.push(...summary.lines);
  for (const [k, v] of Object.entries(summary.byType)) {
    const slot = (bucket.byType[k] ??= { nominal: Decimal.zero, available: Decimal.zero });
    slot.nominal = slot.nominal.add(v.nominal);
    slot.available = slot.available.add(v.available);
  }
}

function checkAggregate(agg, snap, subjectStats, overlaps, nextId) {
  const findings = [];
  const leafIds = expandCoveredLeaves(agg.rollup?.covers ?? [], snap);

  // 窗口总数只取 window 桶
  let rawNominal = Decimal.zero;
  let rawAvailable = Decimal.zero;
  for (const id of leafIds) {
    const st = subjectStats.get(id);
    if (!st) continue;
    rawNominal = rawNominal.add(st.window.nominal);
    rawAvailable = rawAvailable.add(st.window.available);
  }

  // 委托重叠只在同一汇总覆盖范围内发生时才在此扣除
  let overlapNominal = Decimal.zero;
  for (const ov of overlaps) {
    if (leafIds.has(ov.consignor_id) && leafIds.has(ov.consignee_id)) {
      overlapNominal = overlapNominal.add(Decimal.of(ov.overlap_std));
    }
  }
  const dedupNominal = rawNominal.sub(overlapNominal);
  const dedupAvailable = rawAvailable.sub(overlapNominal);

  const reportedNominal = agg.rollup?.nominal_quantity_std != null ? Decimal.of(agg.rollup.nominal_quantity_std) : null;
  const reportedAvailable = agg.rollup?.available_quantity_std != null ? Decimal.of(agg.rollup.available_quantity_std) : null;
  const ruleVersion = agg.rollup?.converted_with_version ?? null;

  const compare = (metric, reported, recomputedRaw, recomputedDedup) => {
    if (reported === null || reported.equals(recomputedDedup)) return;
    const matchesRaw = reported.equals(recomputedRaw);
    findings.push({
      id: nextId(),
      kind: 'hierarchy_overlap',
      severity: 'high',
      subject_ids: [agg.subject_id, ...leafIds],
      metric,
      values: {
        reported_std: reported.toString(),
        recomputed_raw_std: recomputedRaw.toString(),
        recomputed_deduplicated_std: recomputedDedup.toString(),
        delta_vs_deduplicated_std: reported.sub(recomputedDedup).toString(),
      },
      sources: [{ declaration_id: agg.declaration_id }],
      unit_rule_version_reported: ruleVersion,
      message: matchesRaw
        ? `${snap.subject(agg.subject_id)?.name ?? agg.subject_id} 上报 ${reported} 等于未去重口径，委托生产被重复计入`
        : `${snap.subject(agg.subject_id)?.name ?? agg.subject_id} 上报 ${reported} 与下级重算不一致（去重后 ${recomputedDedup}）`,
      proposed: { value: recomputedDedup.toString(), basis: 'deduplicated_rollup' },
      requires_decision: true,
      status: 'open',
    });
  };

  compare('nominal_quantity_std', reportedNominal, rawNominal, dedupNominal);
  compare('available_quantity_std', reportedAvailable, rawAvailable, dedupAvailable);
  return findings;
}

function expandCoveredLeaves(coveredIds, snap) {
  const leafIds = new Set();
  for (const id of coveredIds) {
    const subject = snap.subject(id);
    if (subject && (subject.role === 'park' || subject.role === 'region')) {
      snap.descendantsOf(id).filter((d) => d.role === 'enterprise').forEach((d) => leafIds.add(d.id));
    } else {
      leafIds.add(id);
    }
  }
  return leafIds;
}

function findConsignmentOverlaps(entityDecls, convert, snap) {
  const out = [];
  for (const c of snap.data.consignments ?? []) {
    const sides = [];
    for (const decl of entityDecls) {
      const win = snap.checkWindow(decl.submitted_at);
      if (!win.inWindow) continue; // 迟报批次不参与委托重叠核对
      for (const b of decl.batches ?? []) {
        if (b.consignment_id === c.consignment_id && !b.superseded) {
          const { quantity } = convert(b.quantity, b.unit);
          sides.push({
            subject_id: decl.subject_id,
            role_scope: b.role_scope,
            batch_id: b.batch_id,
            declaration_id: decl.declaration_id,
            quantity_std: quantity.toString(),
          });
        }
      }
    }
    const consignorSide = sides.find((s) => s.role_scope === 'consignor' && s.subject_id === c.consignor_id);
    const consigneeSide = sides.find((s) => s.role_scope === 'consignee' && s.subject_id === c.consignee_id);
    if (consignorSide && consigneeSide) {
      const overlap = Decimal.of(consignorSide.quantity_std);
      const raw = overlap.add(Decimal.of(consigneeSide.quantity_std));
      out.push({
        consignment_id: c.consignment_id,
        consignor_id: c.consignor_id,
        consignee_id: c.consignee_id,
        overlap_std: overlap.toString(),
        raw_nominal_std: raw.toString(),
        deduplicated_nominal_std: consigneeSide.quantity_std,
        sources: sides,
      });
    }
  }
  return out;
}

function statusAndWindowFindings(snap, subjectStats, nextId) {
  const findings = [];
  for (const [subjectId, st] of subjectStats) {
    // 窗口内的名义/可用差异（质量隔离）
    const unavailable = st.window.nominal.sub(st.window.available);
    if (!unavailable.isZero()) {
      findings.push({
        id: nextId(),
        kind: 'nominal_vs_available',
        severity: 'medium',
        subject_ids: [subjectId],
        metric: 'available_quantity_std',
        values: {
          nominal_std: st.window.nominal.toString(),
          available_std: st.window.available.toString(),
          unavailable_std: unavailable.toString(),
        },
        sources: st.window.lines.filter((l) => !l.counts_as_available).map((l) => ({ batch_id: l.batch_id })),
        message: `质量隔离等不可发运库存 ${unavailable} 计入名义库存、不计入可用库存`,
        proposed: { value: st.window.available.toString(), basis: 'exclude_quarantined' },
        requires_decision: false, // 口径性事实，登记即可
        status: 'informational',
      });
    }
    for (const declId of st.late_declarations) {
      findings.push({
        id: nextId(),
        kind: 'late_report',
        severity: 'medium',
        subject_ids: [subjectId],
        metric: null,
        values: {
          declaration_id: declId,
          deadline: snap.data.window.deadline,
          late_nominal_std: st.late.nominal.toString(),
          late_available_std: st.late.available.toString(),
        },
        sources: [{ declaration_id: declId }, ...st.late.lines.map((l) => ({ batch_id: l.batch_id }))],
        message: `申报 ${declId} 迟于窗口截止时间，已另成批次、不并入窗口总数（迟报名义 ${st.late.nominal}）`,
        proposed: { action: 'exclude_from_window_total', basis: 'late_report_filed_separately' },
        requires_decision: true, // 是否追纳入月报由人工决定
        status: 'open',
      });
    }
  }
  return findings;
}

function evidenceFindings(snap, entityDecls, nextId) {
  const findings = [];
  const known = new Set((snap.data.evidence ?? []).map((e) => e.id));
  for (const decl of entityDecls) {
    for (const b of decl.batches ?? []) {
      for (const evId of b.evidence_ids ?? []) {
        if (!known.has(evId)) {
          findings.push({
            id: nextId(),
            kind: 'missing_evidence',
            severity: 'medium',
            subject_ids: [decl.subject_id],
            metric: null,
            values: { batch_id: b.batch_id, evidence_id: evId },
            sources: [{ batch_id: b.batch_id }],
            message: `批次 ${b.batch_id} 引用的证明材料 ${evId} 未登记`,
            proposed: null,
            requires_decision: true,
            status: 'open',
          });
        }
      }
    }
  }
  return findings;
}

function rollupRegion(regionId, snap, subjectStats, overlaps) {
  const enterprises = snap.descendantsOf(regionId).filter((s) => s.role === 'enterprise');
  let rawNominal = Decimal.zero;
  let rawAvailable = Decimal.zero;
  let lateNominal = Decimal.zero;
  for (const e of enterprises) {
    const st = subjectStats.get(e.id);
    if (!st) continue;
    rawNominal = rawNominal.add(st.window.nominal);
    rawAvailable = rawAvailable.add(st.window.available);
    lateNominal = lateNominal.add(st.late.nominal);
  }
  let overlap = Decimal.zero;
  for (const ov of overlaps) {
    const inside = enterprises.some((e) => e.id === ov.consignor_id)
      && enterprises.some((e) => e.id === ov.consignee_id);
    if (inside) overlap = overlap.add(Decimal.of(ov.overlap_std));
  }
  return {
    subject_id: regionId,
    raw_nominal_std: rawNominal.toString(), // 未去重窗口名义
    raw_available_std: rawAvailable.toString(),
    consignment_overlap_std: overlap.toString(),
    deduplicated_nominal_std: rawNominal.sub(overlap).toString(), // 事实对账建议口径
    deduplicated_available_std: rawAvailable.sub(overlap).toString(),
    late_nominal_std: lateNominal.toString(), // 迟报另列，不进上面两个总数
  };
}

function serializeByType(byType) {
  const out = {};
  for (const [k, v] of Object.entries(byType)) {
    out[k] = { nominal_std: v.nominal.toString(), available_std: v.available.toString() };
  }
  return out;
}

function inferUnit(snap) {
  const agg = (snap.data.declarations ?? []).find((d) => d.rollup?.unit);
  return agg?.rollup?.unit ?? 'vial';
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
function bySeverity(a, b) {
  return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || a.id.localeCompare(b.id);
}
