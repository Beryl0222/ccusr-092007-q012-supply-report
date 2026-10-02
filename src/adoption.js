/**
 * 采用值确认：系统只负责找出重叠，具体采用哪个值由有权人员确认。
 * 未确认的重叠一律留在未决事项中，复算时不擅自抵扣。
 */

/** 有权确认采用值的角色。 */
export const ADOPTION_ROLES = Object.freeze(['regulator']);

/**
 * 确认某条重叠发现的采用值。
 * @param {object} finding 重叠发现（overlap.js 输出）
 * @param {{qty: number, unit: string}} adoptedValue 采用值（带单位）
 * @param {string} adoptedBy 确认人标识
 * @param {string} role 确认人角色，必须在 ADOPTION_ROLES 内
 * @param {string} [confirmedAt] 确认时间（ISO 字符串）
 */
export function confirmAdoption({ finding, adoptedValue, adoptedBy, role, confirmedAt }) {
  if (!ADOPTION_ROLES.includes(role)) {
    throw new Error(`角色 ${role} 无权确认采用值`);
  }
  if (!finding?.finding_id) throw new Error('缺少待确认的重叠发现');
  return Object.freeze({
    finding_id: finding.finding_id,
    adopted_value: adoptedValue,
    adopted_by: adoptedBy,
    status: 'confirmed',
    confirmed_at: confirmedAt ?? new Date().toISOString(),
  });
}

/** 仍未确认的重叠发现，即值班视图中的未决事项。 */
export function pendingItems(findings, adoptions) {
  const confirmed = new Set((adoptions ?? []).map((a) => a.finding_id));
  return (findings ?? []).filter((f) => !confirmed.has(f.finding_id));
}
