/**
 * 库存状态与批次口径。
 *
 * 批次类型互不混报，迟报 / 更正 / 退货回库 / 质量隔离均另成批次：
 * - normal          窗口内正常批次
 * - late            迟报批次（截止时间之后到达）
 * - correction      更正批次（取代同 correction_target 的旧批次，旧批次留痕）
 * - return_to_stock 退货回库
 * - quarantine      质量隔离
 *
 * 名义库存 = 全部实物批次；可用库存 = 名义库存扣除质量隔离（以及未来扩展的
 * 其他不可发运状态）。隔离货仍是"名下的货"，所以计入名义、不计入可用。
 */

import { Decimal } from './decimal.js';

export const BATCH_TYPES = Object.freeze({
  NORMAL: 'normal',
  LATE: 'late',
  CORRECTION: 'correction',
  RETURN_TO_STOCK: 'return_to_stock',
  QUARANTINE: 'quarantine',
});

export const BATCH_STATUS = Object.freeze({
  AVAILABLE: 'available',
  QUARANTINED: 'quarantined',
});

/** 计入名义库存但不可用的状态。 */
const NON_AVAILABLE_STATUS = new Set([BATCH_STATUS.QUARANTINED]);

/** 这些批次类型本身代表实物变动，计入库存；更正批次取代旧批次（在 intake 处理）。 */
const STOCK_BATCH_TYPES = new Set([
  BATCH_TYPES.NORMAL,
  BATCH_TYPES.LATE,
  BATCH_TYPES.CORRECTION,
  BATCH_TYPES.RETURN_TO_STOCK,
  BATCH_TYPES.QUARANTINE,
]);

/**
 * 把批次按标准单位汇总为名义/可用库存。
 * @param {Array<object>} batches 已接收、已应用更正取代的批次
 * @param {(q:string, fromUnit:string)=>{quantity:Decimal}} convert 换算函数
 * @returns {{nominal: Decimal, available: Decimal, byType: object, lines: Array}}
 */
export function summarizeBatches(batches, convert) {
  const byType = {};
  const lines = [];
  let nominal = Decimal.zero;
  let available = Decimal.zero;

  for (const b of batches) {
    if (!STOCK_BATCH_TYPES.has(b.batch_type)) continue;
    if (b.superseded) continue; // 被更正取代的旧批次只留痕，不再计数
    const { quantity } = convert(b.quantity, b.unit);
    const isAvailable = !NON_AVAILABLE_STATUS.has(b.status);
    nominal = nominal.add(quantity);
    if (isAvailable) available = available.add(quantity);

    const slot = (byType[b.batch_type] ??= { nominal: Decimal.zero, available: Decimal.zero });
    slot.nominal = slot.nominal.add(quantity);
    if (isAvailable) slot.available = slot.available.add(quantity);

    lines.push({
      batch_id: b.batch_id,
      batch_type: b.batch_type,
      status: b.status,
      quantity_std: quantity.toString(),
      counts_as_available: isAvailable,
      consignment_id: b.consignment_id ?? null,
      role_scope: b.role_scope ?? null,
      line_ids: b.line_ids ?? [],
    });
  }

  return { nominal, available, byType, lines };
}
