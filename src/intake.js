/**
 * 企业申报接收：
 *  - 幂等：同一 idempotency_key 的重试必须返回同一张回执（receipt_id 由
 *    幂等键确定性派生），重复提交不产生第二条记录。
 *  - 校验问题随回执返回，只做结构性/合规性校验；跨主体的事实核对在对账引擎。
 *  - 迟报、更正、退货回库、质量隔离均另成批次；更正批次取代旧批次但留痕。
 *  - 月报冻结后，落在冻结窗口的申报被拒收（要求改走下一期）。
 */

import { createHash } from 'node:crypto';
import { BATCH_TYPES, BATCH_STATUS } from './inventory.js';

const ALLOWED_BATCH_TYPES = new Set(Object.values(BATCH_TYPES));
const ALLOWED_STATUS = new Set(Object.values(BATCH_STATUS));

export class IntakeRegistry {
  /**
   * @param {object} opts
   * @param {Array<object>} [opts.subjects] 已登记主体
   * @param {Set<string>} [opts.frozenPeriods] 已冻结月报期间
   */
  constructor({ subjects = [], frozenPeriods = new Set() } = {}) {
    this._subjectIds = new Set(subjects.map((s) => s.id));
    this._frozenPeriods = frozenPeriods;
    /** @type {Map<string, {receipt: object, payloadHash: string}>} */
    this._keys = new Map();
    /** @type {Map<string, object>} declaration_id → 已接收申报 */
    this._declarations = new Map();
    /** @type {Map<string, {batch: object, superseded_by: string, at: string}>} */
    this._superseded = new Map();
  }

  freezePeriod(period) {
    this._frozenPeriods.add(period);
  }

  get acceptedDeclarations() {
    return [...this._declarations.values()];
  }

  /**
   * 接收一次企业提交。
   * @param {object} declaration 申报内容
   * @param {object} ctx
   * @param {string} ctx.idempotency_key 企业生成的幂等键
   * @param {string} ctx.period 期间，如 2026-09
   * @param {string} ctx.received_at 接收时间 ISO
   * @param {string} ctx.deadline 窗口截止时间 ISO
   */
  submit(declaration, { idempotency_key, period, received_at, deadline }) {
    if (!idempotency_key) throw new Error('缺少幂等键');

    // 冻结窗口：月报发布后该期不再接收，提示企业改走下一期
    if (this._frozenPeriods.has(period)) {
      return this._receipt(idempotency_key, declaration, received_at, [
        { code: 'PERIOD_FROZEN', severity: 'error', message: `${period} 月报已发布冻结，请在下一期申报` },
      ], true);
    }

    const payloadHash = hashOf(declaration);
    const seen = this._keys.get(idempotency_key);
    if (seen) {
      // 重试：无论调用多少次都返回同一张回执；同键不同载荷则明确拒绝
      if (seen.payloadHash !== payloadHash) {
        throw new Error(`幂等键 ${idempotency_key} 已用于不同内容的提交`);
      }
      return seen.receipt;
    }

    const issues = validate(declaration, this._subjectIds);
    const rejected = issues.some((i) => i.severity === 'error');

    // 更正批次先做跨申报校验（必须指明目标且目标存在）
    if (!rejected) {
      for (const b of declaration.batches ?? []) {
        if (b.batch_type === BATCH_TYPES.CORRECTION) {
          if (!b.correction_target) {
            issues.push({
              code: 'CORRECTION_WITHOUT_TARGET',
              severity: 'error',
              batch_id: b.batch_id,
              message: `更正批次 ${b.batch_id} 缺少 correction_target`,
            });
          } else if (!this._findBatch(b.correction_target)) {
            issues.push({
              code: 'CORRECTION_TARGET_MISSING',
              severity: 'error',
              batch_id: b.batch_id,
              message: `更正目标批次 ${b.correction_target} 不存在`,
            });
          }
        }
      }
    }

    // 迟报判定在回执生成前完成：窗口后到达的普通批次另成迟报批次
    if (!rejected) {
      const late = new Date(received_at).getTime() > new Date(deadline).getTime();
      for (const b of declaration.batches ?? []) {
        if (late && b.batch_type === BATCH_TYPES.NORMAL) {
          b.batch_type = BATCH_TYPES.LATE;
          issues.push({
            code: 'LATE_BATCH',
            severity: 'warning',
            batch_id: b.batch_id,
            message: `批次 ${b.batch_id} 迟于截止时间 ${deadline}，已另成迟报批次`,
          });
        }
      }
    }

    const finalRejected = rejected || issues.some((i) => i.severity === 'error');
    const receipt = this._receipt(idempotency_key, declaration, received_at, issues, finalRejected);

    if (!finalRejected) {
      this._applyCorrections(declaration, received_at);
      this._declarations.set(declaration.declaration_id, declaration);
    }
    this._keys.set(idempotency_key, { receipt, payloadHash });
    return receipt;
  }

  /** 被取代旧批次的留痕（供审计与视图展示）。 */
  supersededBatches() {
    return [...this._superseded.entries()].map(([batch_id, v]) => ({ batch_id, ...v }));
  }

  _receipt(idempotencyKey, declaration, receivedAt, issues, rejected) {
    return Object.freeze({
      receipt_id: `rcpt-${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)}`,
      idempotency_key: idempotencyKey,
      declaration_id: declaration.declaration_id ?? null,
      received_at: receivedAt,
      status: rejected ? 'rejected' : issues.length ? 'accepted_with_issues' : 'accepted',
      issues: Object.freeze(issues.map(Object.freeze)),
    });
  }

  /** 旧批次留痕：校验已在提交阶段完成，这里只做取代标记。 */
  _applyCorrections(declaration, receivedAt) {
    for (const b of declaration.batches ?? []) {
      if (b.batch_type !== BATCH_TYPES.CORRECTION) continue;
      const target = this._findBatch(b.correction_target);
      target.superseded = true;
      this._superseded.set(b.correction_target, {
        batch: target,
        superseded_by: b.batch_id,
        at: receivedAt,
      });
    }
  }

  _findBatch(batchId) {
    for (const decl of this._declarations.values()) {
      const hit = (decl.batches ?? []).find((b) => b.batch_id === batchId && !b.superseded);
      if (hit) return hit;
    }
    return null;
  }
}

function validate(declaration, subjectIds) {
  const issues = [];
  if (!declaration.declaration_id) issues.push({ code: 'MISSING_ID', severity: 'error', message: '缺少 declaration_id' });
  if (!declaration.subject_id) {
    issues.push({ code: 'MISSING_SUBJECT', severity: 'error', message: '缺少 subject_id' });
  } else if (subjectIds.size && !subjectIds.has(declaration.subject_id)) {
    issues.push({ code: 'UNKNOWN_SUBJECT', severity: 'error', subject_id: declaration.subject_id, message: `未登记主体 ${declaration.subject_id}` });
  }
  for (const b of declaration.batches ?? []) {
    if (!b.batch_id) issues.push({ code: 'MISSING_BATCH_ID', severity: 'error', message: '存在缺少 batch_id 的批次' });
    if (!ALLOWED_BATCH_TYPES.has(b.batch_type)) {
      issues.push({ code: 'BAD_BATCH_TYPE', severity: 'error', batch_id: b.batch_id, message: `批次 ${b.batch_id} 类型非法: ${b.batch_type}` });
    }
    if (!ALLOWED_STATUS.has(b.status)) {
      issues.push({ code: 'BAD_STATUS', severity: 'error', batch_id: b.batch_id, message: `批次 ${b.batch_id} 库存状态非法: ${b.status}` });
    }
    if (!/^\d+(\.\d+)?$/.test(String(b.quantity)) || Number(b.quantity) <= 0) {
      issues.push({ code: 'BAD_QUANTITY', severity: 'error', batch_id: b.batch_id, message: `批次 ${b.batch_id} 数量非法: ${b.quantity}` });
    }
    if (!b.unit) issues.push({ code: 'MISSING_UNIT', severity: 'error', batch_id: b.batch_id, message: `批次 ${b.batch_id} 缺少单位` });
    if (!b.evidence_ids?.length) {
      issues.push({ code: 'NO_EVIDENCE', severity: 'warning', batch_id: b.batch_id, message: `批次 ${b.batch_id} 没有附证明材料` });
    }
    // 退货回库、质量隔离必须自成批次，不允许混在 normal 里
    if (b.status === BATCH_STATUS.QUARANTINED && b.batch_type !== BATCH_TYPES.QUARANTINE) {
      issues.push({ code: 'QUARANTINE_MUST_BE_OWN_BATCH', severity: 'error', batch_id: b.batch_id, message: '质量隔离必须另成 quarantine 批次' });
    }
  }
  return issues;
}

function hashOf(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
