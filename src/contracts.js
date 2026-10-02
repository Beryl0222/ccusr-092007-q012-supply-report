import { readFile } from 'node:fs/promises';

/**
 * 数据合同：
 *  v1（既有）：schema_version/record_id/domain/occurred_at/revision/source 最小样例。
 *  v2（当前）：在 v1 基础上增加统计范围（subject/window）、单位换算、生产关系、
 *     库存状态（batches）、时间窗与证明材料。新增状态/批次类型必须为枚举扩展，
 *     不得改变既有标识与 occurred_at/revision 的时间含义。
 *
 * v1 记录只读保留；需要进入 v2 流程时用 migrateV1Record 升级，升级不改写
 * record_id、occurred_at、revision。
 */

const SUPPORTED_VERSIONS = new Set([1, 2]);

/** 读取并冻结一条合同记录。v1/v2 均可读，缺必要标识即拒。 */
export async function loadRecord(path) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  if (!SUPPORTED_VERSIONS.has(payload.schema_version)) {
    throw new Error(`不支持的合同版本: ${payload.schema_version}`);
  }
  if (payload.schema_version >= 2) validateV2(payload);
  return Object.freeze(payload);
}

/** v2 必填结构校验（业务跨主体核对在对账引擎，这里只校验单条自洽）。 */
export function validateV2(payload) {
  if (payload.domain !== 'supply_report') throw new Error('v2 domain 必须为 supply_report');
  if (!payload.window?.period || !payload.window?.deadline) throw new Error('v2 缺少时间窗 window.period/deadline');
  const batches = payload.batches
    ?? (payload.declarations ?? []).flatMap((d) => d.batches ?? []);
  for (const b of batches) {
    if (!b.batch_id || !b.batch_type || !b.status || !b.quantity || !b.unit) {
      throw new Error(`批次 ${b.batch_id ?? '?'} 缺少必要字段`);
    }
  }
  return true;
}

/**
 * v1 → v2 迁移：保留既有标识与时间语义，仅补结构外壳；批次需业务侧补报。
 * 迁移说明：v2 新增枚举（batch_type/status）只增不改，旧消费者可继续读 v1 字段。
 */
export function migrateV1Record(v1) {
  if (v1.schema_version !== 1) throw new Error('migrateV1Record 只接受 v1 记录');
  return Object.freeze({
    ...v1,
    schema_version: 2,
    revision: v1.revision, // 迁移不产生新业务版本
    subject: null,
    window: null,
    production_roles: [],
    evidences: [],
    batches: [],
    migrated_from: 1,
  });
}
