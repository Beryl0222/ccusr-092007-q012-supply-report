/**
 * 批次归类：迟报、更正、退货回库和质量隔离均另成批次，
 * 不与按期原始申报混批，便于分别追踪与复算。
 */
export const BATCH_KINDS = Object.freeze([
  'on_time',
  'late',
  'correction',
  'return_to_stock',
  'quality_isolation',
]);

/**
 * 判定单个申报所属批次。
 * 显式批次类型（更正/退货回库/质量隔离）优先；
 * 原始申报按提交时间是否超过截止时间区分按期与迟报。
 */
export function classifyDeclaration(decl) {
  switch (decl.kind) {
    case 'correction':
      return 'correction';
    case 'return_to_stock':
      return 'return_to_stock';
    case 'quality_isolation':
      return 'quality_isolation';
    case 'original':
      return Date.parse(decl.submitted_at) > Date.parse(decl.submission_deadline)
        ? 'late'
        : 'on_time';
    default:
      throw new Error(`无法归类的申报批次类型: ${decl.kind}`);
  }
}

/**
 * 把整份记录归成若干批次，按 BATCH_KINDS 顺序返回，空批次不出现。
 * 每个批次：{ batch_id, kind, declaration_ids }。
 */
export function buildBatches(record) {
  const grouped = new Map(BATCH_KINDS.map((kind) => [kind, []]));
  for (const decl of record.declarations ?? []) {
    grouped.get(classifyDeclaration(decl)).push(decl.declaration_id);
  }
  return BATCH_KINDS
    .filter((kind) => grouped.get(kind).length > 0)
    .map((kind) => ({
      batch_id: `${record.period}:${kind}`,
      kind,
      declaration_ids: grouped.get(kind),
    }));
}
