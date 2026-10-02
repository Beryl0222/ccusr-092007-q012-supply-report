import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));

/** 读取业务样例申报记录。 */
export function loadSample() {
  return loadRecord(join(here, '..', 'fixtures', 'supply_declaration.json'));
}
