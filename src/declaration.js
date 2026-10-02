/**
 * 申报声明校验：各责任主体必须声明统计范围、单位换算、生产关系、
 * 库存状态、时间窗和证明材料。校验问题按主体归集，供企业端自查。
 */

/** 库存状态枚举。迁移方式：既有记录缺少 inventory_status 时一律视为 available。 */
export const INVENTORY_STATUSES = Object.freeze(['available', 'quality_isolated']);

/** 申报批次类型。original 之外的四类（迟报由时间推导）均另成批次。 */
export const DECLARATION_KINDS = Object.freeze([
  'original',
  'correction',
  'return_to_stock',
  'quality_isolation',
]);

/** 查找某药品从 fromUnit 到 toUnit 的换算规则，未定义时返回 null。 */
export function findConversionRule(rules, drugId, fromUnit, toUnit) {
  return (rules ?? []).find(
    (r) => r.drug_id === drugId && r.from_unit === fromUnit && r.to_unit === toUnit,
  ) ?? null;
}

/**
 * 校验整份申报记录，返回问题列表。
 * 每个问题都带 actor_id / declaration_id，企业端只展示自己的部分。
 */
export function validateDeclarationSet(record) {
  const issues = [];
  const push = (decl, code, message, lineId) => {
    issues.push({
      actor_id: decl?.actor_id ?? null,
      declaration_id: decl?.declaration_id ?? null,
      code,
      message,
      ...(lineId ? { line_id: lineId } : {}),
    });
  };

  const evidenceIds = new Set((record.evidence ?? []).map((e) => e.evidence_id));
  const relations = new Map((record.production_relations ?? []).map((r) => [r.relation_id, r]));
  const declarationIds = new Set((record.declarations ?? []).map((d) => d.declaration_id));
  const standardUnit = record.standard_unit;

  for (const decl of record.declarations ?? []) {
    if (!decl.scope?.level) push(decl, 'MISSING_SCOPE', '缺少统计范围声明');
    if (!DECLARATION_KINDS.includes(decl.kind)) {
      push(decl, 'UNKNOWN_KIND', `未知申报批次类型: ${decl.kind}`);
    }
    const window = decl.window;
    if (!window || !(Date.parse(window.start) < Date.parse(window.end))) {
      push(decl, 'BAD_WINDOW', '时间窗缺失或起止时间颠倒');
    }
    if (!decl.submission_deadline || Number.isNaN(Date.parse(decl.submission_deadline))) {
      push(decl, 'MISSING_DEADLINE', '缺少报送截止时间');
    }
    if (Number.isNaN(Date.parse(decl.submitted_at))) {
      push(decl, 'MISSING_SUBMITTED_AT', '缺少提交时间');
    }
    if (decl.kind === 'correction' && !declarationIds.has(decl.supersedes)) {
      push(decl, 'BAD_SUPERSEDES', '更正批次未指明有效的被更正申报');
    }

    for (const line of decl.lines ?? []) {
      if (!INVENTORY_STATUSES.includes(line.inventory_status)) {
        push(decl, 'UNKNOWN_STATUS', `未知库存状态: ${line.inventory_status}`, line.line_id);
      }
      if (
        line.unit !== standardUnit
        && !findConversionRule(record.conversion_rules, line.drug_id, line.unit, standardUnit)
      ) {
        push(decl, 'MISSING_CONVERSION_RULE', `缺少换算规则: ${line.drug_id} ${line.unit} -> ${standardUnit}`, line.line_id);
      }
      for (const ev of line.evidence ?? []) {
        if (!evidenceIds.has(ev)) push(decl, 'UNKNOWN_EVIDENCE', `证明材料不存在: ${ev}`, line.line_id);
      }
      if (line.relation_id) {
        const rel = relations.get(line.relation_id);
        if (!rel) {
          push(decl, 'UNKNOWN_RELATION', `生产关系不存在: ${line.relation_id}`, line.line_id);
        } else {
          const expected = decl.actor_id === rel.delegator
            ? 'delegator'
            : decl.actor_id === rel.trustee
              ? 'trustee'
              : null;
          if (expected === null || line.relation_role !== expected) {
            push(decl, 'RELATION_MISMATCH', '生产关系角色与声明主体不一致', line.line_id);
          }
        }
      }
    }
  }
  return issues;
}
