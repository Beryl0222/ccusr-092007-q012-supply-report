/**
 * 重叠检测：后端自动找出上下级汇总及委托链的重叠。
 * 系统只给出重叠事实与候选重复量，采用哪个值仍由有权人员确认（见 adoption.js）。
 */

/** 返回全部重叠发现，status 恒为 pending，等待确认。 */
export function findOverlaps(record) {
  return [
    ...findEntrustedChainOverlaps(record),
    ...findHierarchicalOverlaps(record),
  ];
}

/**
 * 委托链重叠：同一委托生产关系被委托方与受托方同时计入库存。
 * 候选重复量取两侧申报量的较小值（同一物理库存被算了两次）。
 */
function findEntrustedChainOverlaps(record) {
  const findings = [];
  for (const rel of record.production_relations ?? []) {
    if (rel.type !== 'entrusted') continue;
    const sides = { delegator: [], trustee: [] };
    for (const decl of record.declarations ?? []) {
      if (decl.kind !== 'original') continue;
      for (const line of decl.lines ?? []) {
        if (line.relation_id === rel.relation_id && sides[line.relation_role]) {
          sides[line.relation_role].push({ declaration_id: decl.declaration_id, line });
        }
      }
    }
    if (!sides.delegator.length || !sides.trustee.length) continue;

    const sum = (entries) => entries.reduce((acc, e) => acc + e.line.qty, 0);
    const unit = sides.delegator[0].line.unit;
    const candidate = Math.min(sum(sides.delegator), sum(sides.trustee));
    findings.push({
      finding_id: `ovk-${rel.relation_id}`,
      kind: 'entrusted_chain',
      drug_id: rel.drug_id,
      relation_id: rel.relation_id,
      parties: [rel.delegator, rel.trustee],
      declarations: {
        delegator: sides.delegator.map((e) => e.declaration_id),
        trustee: sides.trustee.map((e) => e.declaration_id),
      },
      candidate_double_count: { qty: candidate, unit },
      status: 'pending',
      detail: '委托生产同时计入委托方与受托方，直接汇总会重复计数',
    });
  }
  return findings;
}

/**
 * 上下级汇总重叠：上级申报的 scope.children 与下级自身的原始申报
 * 覆盖同一药品，层级之间直接相加会重复计数。
 */
function findHierarchicalOverlaps(record) {
  const originalsByActor = new Map();
  for (const decl of record.declarations ?? []) {
    if (decl.kind !== 'original') continue;
    const list = originalsByActor.get(decl.actor_id) ?? [];
    list.push(decl);
    originalsByActor.set(decl.actor_id, list);
  }

  const findings = [];
  for (const decl of record.declarations ?? []) {
    for (const child of decl.scope?.children ?? []) {
      const parentDrugs = new Set((decl.lines ?? []).map((l) => l.drug_id));
      for (const childDecl of originalsByActor.get(child) ?? []) {
        const shared = (childDecl.lines ?? [])
          .map((l) => l.drug_id)
          .filter((drug) => parentDrugs.has(drug));
        for (const drug of new Set(shared)) {
          findings.push({
            finding_id: `ovh-${decl.declaration_id}-${childDecl.declaration_id}-${drug}`,
            kind: 'hierarchical',
            drug_id: drug,
            parent: { actor_id: decl.actor_id, declaration_id: decl.declaration_id },
            child: { actor_id: child, declaration_id: childDecl.declaration_id },
            status: 'pending',
            detail: '上下级汇总范围重叠，跨层级直接相加会重复计数',
          });
        }
      }
    }
  }
  return findings;
}
