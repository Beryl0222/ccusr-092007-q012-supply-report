/**
 * 人工采用台账：对账引擎只提出差异与建议值（proposed），具体采用哪个值
 * 必须由有权监管人员确认（adopted）。系统不替人拍板，也不做药品调拨。
 *
 * 采用记录锚定快照：同一 finding 在不同快照上可重新决策；已发布月报引用的
 * 快照冻结后，落在其上的决策也随之冻结。
 */

const ROLE_CAN_DECIDE = new Set(['regulator']);

export class DecisionLedger {
  constructor() {
    this._decisions = new Map(); // key: snapshot_id/finding_id
    this._frozenSnapshots = new Set();
  }

  freezeSnapshot(snapshotId) {
    this._frozenSnapshots.add(snapshotId);
  }

  isFrozen(snapshotId) {
    return this._frozenSnapshots.has(snapshotId);
  }

  _key(snapshotId, findingId) {
    return `${snapshotId}/${findingId}`;
  }

  /**
   * 登记采用值。
   * @param {object} arg
   * @param {string} arg.snapshot_id
   * @param {string} arg.finding_id
   * @param {{role:string, id:string}} arg.actor 操作人
   * @param {string} arg.adopted_value 采用值（标准单位字符串）
   * @param {string} [arg.reason]
   * @param {string} arg.decided_at ISO 时间
   */
  adopt({ snapshot_id, finding_id, actor, adopted_value, reason = null, decided_at }) {
    if (!actor || !ROLE_CAN_DECIDE.has(actor.role)) {
      throw new Error('只有监管人员有权确认采用值');
    }
    if (this.isFrozen(snapshot_id)) {
      throw new Error(`快照 ${snapshot_id} 已随月报冻结，不能再登记采用值`);
    }
    const key = this._key(snapshot_id, finding_id);
    if (this._decisions.has(key)) {
      const prev = this._decisions.get(key);
      throw new Error(`差异 ${finding_id} 已有采用值（${prev.adopted_value}），更正须走更正批次`);
    }
    // 校验是合法十进制，避免把脏值写入台账
    const value = DecimalCheck(adopted_value);
    const record = Object.freeze({
      snapshot_id,
      finding_id,
      adopted_value: value,
      reason,
      decided_by: actor.id,
      decided_at,
    });
    this._decisions.set(key, record);
    return record;
  }

  get(snapshotId, findingId) {
    return this._decisions.get(this._key(snapshotId, findingId)) ?? null;
  }

  /** 给对账结果附上每条差异的采用状态，供视图层使用。 */
  annotate(reconcileResult) {
    return {
      ...reconcileResult,
      findings: reconcileResult.findings.map((f) => {
        const d = this.get(reconcileResult.snapshot_id, f.id);
        return {
          ...f,
          decision: d
            ? { adopted_value: d.adopted_value, decided_by: d.decided_by, decided_at: d.decided_at, state: 'resolved' }
            : { state: f.requires_decision ? 'pending' : 'no_decision_required' },
        };
      }),
    };
  }

  listFor(snapshotId) {
    return [...this._decisions.values()].filter((d) => d.snapshot_id === snapshotId);
  }
}

function DecimalCheck(s) {
  // 与 decimal.js 同一格式约束，本地校验避免循环依赖
  if (!/^-?\d+(\.\d+)?$/.test(String(s).trim())) throw new Error(`采用值不是合法十进制数: ${s}`);
  return String(s).trim();
}
