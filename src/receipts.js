import { createHash } from 'node:crypto';

/**
 * 接收回执：企业提交重试必须返回同一回执。
 * 回执编号由 declaration_id 确定性派生，首次接收时间由存储记住，
 * 无论重试多少次，返回的 receipt_id 与 received_at 都保持不变。
 */
export class ReceiptStore {
  #byDeclarationId = new Map();

  /**
   * @param {object} declaration 申报批次（需含 declaration_id / actor_id）
   * @param {string} [now] 首次接收时间（ISO 字符串），重试时忽略
   */
  issue(declaration, now = new Date().toISOString()) {
    const key = declaration.declaration_id;
    const existing = this.#byDeclarationId.get(key);
    if (existing) return existing;

    const receipt = Object.freeze({
      receipt_id: `rcpt-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
      declaration_id: key,
      actor_id: declaration.actor_id,
      status: 'received',
      received_at: now,
    });
    this.#byDeclarationId.set(key, receipt);
    return receipt;
  }

  /** 按申报编号查询已发回执，未接收过返回 null。 */
  lookup(declarationId) {
    return this.#byDeclarationId.get(declarationId) ?? null;
  }
}
