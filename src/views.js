/**
 * 分角色视图：企业端仅展示自己的校验问题、接收状态和采用值；
 * 产线明细仅申报主体自身与监管角色可见，其他企业与无关部门一律脱敏。
 */

/** 可查看产线明细的特权角色。 */
const PRIVILEGED_ROLES = new Set(['regulator']);

/**
 * 企业端视图：只含本主体的申报、校验问题、回执与涉及本主体的采用值。
 */
export function enterpriseView(record, actorId, {
  issues = [],
  receipts = [],
  findings = [],
  adoptions = [],
} = {}) {
  const involvesActor = (f) => f.parties?.includes(actorId)
    || f.parent?.actor_id === actorId
    || f.child?.actor_id === actorId;
  const ownFindings = (findings ?? []).filter(involvesActor);
  const ownFindingIds = new Set(ownFindings.map((f) => f.finding_id));
  const adoptedIds = new Set((adoptions ?? []).map((a) => a.finding_id));

  return {
    actor_id: actorId,
    declarations: (record.declarations ?? []).filter((d) => d.actor_id === actorId),
    validation_issues: (issues ?? []).filter((i) => i.actor_id === actorId),
    receipts: (receipts ?? []).filter((r) => r.actor_id === actorId),
    adopted_values: (adoptions ?? []).filter((a) => ownFindingIds.has(a.finding_id)),
    pending_findings: ownFindings.filter((f) => !adoptedIds.has(f.finding_id)),
  };
}

/**
 * 按查看者身份脱敏单条申报。
 * 申报主体自身与监管角色看到原文；其他企业、无关部门看不到产线明细。
 */
export function maskDeclarationForViewer(decl, viewer) {
  if (viewer.actor_id === decl.actor_id || PRIVILEGED_ROLES.has(viewer.role)) {
    return decl;
  }
  if (!decl.production_line_details) return decl;
  const { production_line_details, ...rest } = decl;
  return { ...rest, masked_fields: ['production_line_details'] };
}

/** 批量脱敏，供跨主体列表接口使用。 */
export function maskDeclarationsForViewer(declarations, viewer) {
  return (declarations ?? []).map((d) => maskDeclarationForViewer(d, viewer));
}
