import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { UnitRuleBook } from '../src/units.js';
import { Snapshot } from '../src/snapshot.js';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadScenario(name = 'scenario_2026_09.json') {
  const raw = JSON.parse(await readFile(join(here, '..', 'fixtures', name), 'utf8'));
  return raw;
}

/** 九月窗口快照（换算规则 v1：每盒 10 支）。 */
export function septemberSnapshot(raw) {
  return new Snapshot(raw, '2026-09-21T17:00:00+08:00');
}

/** 十月快照：规则 v2（每盒 12 支）已生效。 */
export function octoberSnapshot(raw) {
  return new Snapshot(raw, '2026-10-02T09:00:00+08:00');
}

export function ruleBook(raw) {
  return new UnitRuleBook(raw.unit_rules);
}

export const SNAPSHOT_TIMES = {
  sept: '2026-09-21T17:00:00+08:00',
  oct: '2026-10-02T09:00:00+08:00',
};
