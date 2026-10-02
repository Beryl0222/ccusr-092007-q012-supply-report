/**
 * 视图层：同一份对账结果，按"谁在看"给出不同裁剪。
 *
 *  - 值班监管视图：从地区总数下钻差异来源与未决事项，并列区分名义/可用库存；
 *    所有数字都标注 snapshot_id，可在指定快照上原样复算。
 *  - 企业视图：只展示本企业的校验问题、接收状态与采用值；看不到任何他人数据。
 *  - 产线明细（line_ids）只对所属企业与监管可见，园区/地区看到的是脱敏后的
 *    批次级数字，其他企业与无关部门什么都看不到。
 */

import { Decimal } from './decimal.js';

/**
 * 值班下钻视图。
 * @param {object} annotated 经 DecisionLedger.annotate 的对账结果
 * @param {Snapshot} snapshot
 * @param {{id:string, role:string}} viewer
 */
export function dutyDrilldown(annotated, snapshot, viewer) {
  if (viewer.role !== 'regulator') throw new Error('值班下钻视图仅对监管人员开放');

  const byKind = new Map();
  for (const f of annotated.findings) {
    const list = byKind.get(f.kind) ?? [];
    list.push({
      id: f.id,
      kind: f.kind,
      severity: f.severity,
      subject_ids: f.subject_ids,
      metric: f.metric,
      values: f.values,
      message: f.message,
      proposed: f.proposed,
      decision_state: f.decision?.state,
      adopted_value: f.decision?.adopted_value ?? null,
    });
    byKind.set(f.kind, list);
  }

  return {
    viewer: { id: viewer.id, role: viewer.role },
    snapshot: { snapshot_id: annotated.snapshot_id, captured_at: annotated.captured_at },
    standard_unit: annotated.standard_unit,
    unit_rule: annotated.unit_rule,
    region_totals: annotated.aggregate_totals.map((t) => ({
      region_id: t.subject_id,
      raw_nominal_std: t.raw_nominal_std,
      raw_available_std: t.raw_available_std,
      consignment_overlap_std: t.consignment_overlap_std,
      deduplicated_nominal_std: t.deduplicated_nominal_std,
      deduplicated_available_std: t.deduplicated_available_std,
      late_nominal_std: t.late_nominal_std,
    })),
    nominal_vs_available: annotated.subjects.map((s) => ({
      subject_id: s.subject_id,
      nominal_std: s.nominal_std,
      available_std: s.available_std,
      unavailable_std: Decimal.of(s.nominal_std).sub(Decimal.of(s.available_std)).toString(),
      by_type: s.by_type,
      late: s.late,
      late_declarations: s.late_declarations,
      lines: s.lines, // 监管可见产线明细
    })),
    difference_sources: {
      hierarchy_overlap: byKind.get('hierarchy_overlap') ?? [],
      consignment_double_count: byKind.get('consignment_double_count') ?? [],
      nominal_vs_available: byKind.get('nominal_vs_available') ?? [],
      unit_conversion: byKind.get('unit_conversion') ?? [],
      late_report: byKind.get('late_report') ?? [],
      missing_evidence: byKind.get('missing_evidence') ?? [],
    },
    open_decisions: annotated.findings
      .filter((f) => f.decision?.state === 'pending')
      .map((f) => ({
        id: f.id,
        kind: f.kind,
        message: f.message,
        proposed: f.proposed,
        subject_ids: f.subject_ids,
      })),
  };
}

/**
 * 企业视图：只含本企业内容。receipts 可选（来自 IntakeRegistry 的回执）。
 * @param {object} annotated
 * @param {Snapshot} snapshot 用于按 declaration_id→subject_id 过滤回执归属
 * @param {{id:string, role:string}} viewer
 * @param {Array<object>} [receipts]
 */
export function enterpriseView(annotated, snapshot, viewer, receipts = []) {
  if (viewer.role !== 'enterprise') throw new Error('企业视图仅对企业主体开放');
  const myId = viewer.id;

  const ownerByDeclaration = new Map(
    (snapshot.data.declarations ?? []).map((d) => [d.declaration_id, d.subject_id]),
  );
  const myReceipts = receipts
    .filter((r) => r.declaration_id && ownerByDeclaration.get(r.declaration_id) === myId)
    .map((r) => ({
      receipt_id: r.receipt_id,
      declaration_id: r.declaration_id,
      received_at: r.received_at,
      status: r.status,
      issues: r.issues,
    }));

  const myFindings = annotated.findings
    .filter((f) => (f.subject_ids ?? []).includes(myId))
    .map((f) => ({
      id: f.id,
      kind: f.kind,
      severity: f.severity,
      metric: f.metric,
      values: f.values,
      // 只保留本企业主体标识，委托相对方等其他主体一律脱敏，避免横向可见
      subject_ids: [myId],
      involves_other_party: (f.subject_ids ?? []).some((id) => id !== myId),
      message: f.message,
      proposed: f.proposed,
      decision_state: f.decision?.state,
      adopted_value: f.decision?.adopted_value ?? null, // 采用值对当事企业透明
    }));

  const mySubject = annotated.subjects.find((s) => s.subject_id === myId) ?? null;

  return {
    viewer: { id: myId, role: 'enterprise' },
    snapshot_id: annotated.snapshot_id,
    receipts: myReceipts,
    stock: mySubject
      ? {
          nominal_std: mySubject.nominal_std,
          available_std: mySubject.available_std,
          by_type: mySubject.by_type,
          late: mySubject.late,
          lines: mySubject.lines, // 本企业可看自己的产线明细
        }
      : null,
    findings: myFindings,
    visible_others: [], // 明确不暴露任何其他主体数据
  };
}

/**
 * 园区/地区视图：看得到下级的批次级数字与差异，但产线明细脱敏。
 */
export function aggregateView(annotated, snapshot, viewer) {
  if (viewer.role !== 'park' && viewer.role !== 'region') {
    throw new Error('汇总视图仅对园区/地区开放');
  }
  const descendantIds = new Set(snapshot.descendantsOf(viewer.id).map((s) => s.id));
  descendantIds.add(viewer.id);

  const redactLines = (lines) =>
    lines.map((l) => ({
      batch_id: l.batch_id,
      batch_type: l.batch_type,
      status: l.status,
      quantity_std: l.quantity_std,
      counts_as_available: l.counts_as_available,
      consignment_id: l.consignment_id,
      role_scope: l.role_scope,
      line_ids: undefined, // 产线明细对园区/地区也不开放
      line_detail: 'redacted',
    }));

  return {
    viewer: { id: viewer.id, role: viewer.role },
    snapshot_id: annotated.snapshot_id,
    subjects: annotated.subjects
      .filter((s) => descendantIds.has(s.subject_id))
      .map((s) => ({
        subject_id: s.subject_id,
        nominal_std: s.nominal_std,
        available_std: s.available_std,
        by_type: s.by_type,
        late: {
          nominal_std: s.late.nominal_std,
          available_std: s.late.available_std,
          by_type: s.late.by_type,
          lines: redactLines(s.late.lines ?? []),
        },
        lines: redactLines(s.lines),
      })),
    findings: annotated.findings
      .filter((f) => (f.subject_ids ?? []).some((id) => descendantIds.has(id)))
      .map((f) => ({
        id: f.id,
        kind: f.kind,
        severity: f.severity,
        subject_ids: f.subject_ids,
        metric: f.metric,
        values: f.values,
        message: f.message,
        proposed: f.proposed,
        decision_state: f.decision?.state,
        adopted_value: f.decision?.adopted_value ?? null,
      })),
  };
}

/** 无关联方（其他企业、无关部门）：空视图，调用方据此返回"无可见数据"。 */
export function emptyView(viewer) {
  return { viewer: { id: viewer.id, role: viewer.role }, subjects: [], findings: [], receipts: [], note: '无权查看该范围数据' };
}

/** 统一入口：按角色与主体归属选择视图。 */
export function viewFor(annotated, snapshot, viewer, { receipts = [] } = {}) {
  if (viewer.role === 'regulator') return dutyDrilldown(annotated, snapshot, viewer);
  if (viewer.role === 'enterprise') {
    const known = annotated.subjects.some((s) => s.subject_id === viewer.id);
    return known ? enterpriseView(annotated, snapshot, viewer, receipts) : emptyView(viewer);
  }
  if (viewer.role === 'park' || viewer.role === 'region') {
    return snapshot.subject(viewer.id) ? aggregateView(annotated, snapshot, viewer) : emptyView(viewer);
  }
  return emptyView(viewer);
}
