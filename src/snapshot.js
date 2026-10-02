/**
 * 不可变快照：对账与月报都锚定在某个快照上，保证"在指定快照上复算结果"可重复。
 * 快照内容做规范化哈希，内容不变则 snapshot_id 不变。
 */

import { createHash } from 'node:crypto';

/** 键排序后序列化，使哈希与字段书写顺序无关。 */
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const parts = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`);
  return `{${parts.join(',')}}`;
}

export function hashContent(value) {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export class Snapshot {
  /**
   * @param {object} scenario 完整情景数据（申报、规则、层级、委托关系……）
   * @param {string} capturedAt ISO 时间，决定换算规则版本与迟报判定
   */
  constructor(scenario, capturedAt) {
    this.data = deepFreeze(structuredClone(scenario));
    this.captured_at = capturedAt;
    this.snapshot_id = `snap-${hashContent({ data: this.data, captured_at: capturedAt }).slice(0, 16)}`;
    Object.freeze(this);
  }

  get subjects() {
    return this.data.subjects ?? (this.data.subject ? [this.data.subject] : []);
  }

  subject(id) {
    return this.subjects.find((s) => s.id === id) ?? null;
  }

  /** 直接下级主体。 */
  childrenOf(subjectId) {
    return this.subjects.filter((s) => s.parent_id === subjectId);
  }

  /** 全部后代主体（含多层级汇总）。 */
  descendantsOf(subjectId) {
    const out = [];
    const walk = (id) => {
      for (const child of this.childrenOf(id)) {
        out.push(child);
        walk(child.id);
      }
    };
    walk(subjectId);
    return out;
  }

  consignment(id) {
    return (this.data.consignments ?? []).find((c) => c.consignment_id === id) ?? null;
  }

  /**
   * 申报批次是否落在时间窗内。窗口截止后到达即迟报，迟报另成批次、不进窗口数。
   * @returns {{inWindow: boolean, deadline: string, submittedAt: string}}
   */
  checkWindow(submittedAt, window = this.data.window) {
    return {
      inWindow: new Date(submittedAt).getTime() <= new Date(window.deadline).getTime(),
      deadline: window.deadline,
      submittedAt,
    };
  }
}

function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}
