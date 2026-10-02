# 重点药品报送对账

监管部门对齐药企、园区和地区上报的重点药品生产供应事实。系统只做事实对账：
自动找出上下级汇总及委托链的重叠，具体采用哪个值仍交给有权人员确认，不做药品调拨。

`fixtures/supply_declaration.json` 保存一条经过脱敏的业务样例，源代码只定义读取这份样例所需的最小合同。后续模块应保持既有标识和时间含义，新增状态必须说明迁移方式。

## 模块分工

- `src/contracts.js` — 最小数据合同（schema_version / record_id），保持不变。
- `src/declaration.js` — 申报声明校验：统计范围、单位换算、生产关系、库存状态、时间窗、证明材料六项要素；校验问题按主体归集。
- `src/overlap.js` — 重叠检测：委托链（委托方/受托方重复计入）与上下级汇总重叠，输出待确认发现。
- `src/adoption.js` — 采用值确认：仅 `regulator` 角色可确认；未确认的重叠保留在未决事项。
- `src/receipts.js` — 接收回执：企业重试提交返回同一回执（编号与接收时间不变）。
- `src/batches.js` — 批次归类：迟报、更正、退货回库、质量隔离各自另成批次，不与按期申报混批。
- `src/reconcile.js` — 对账复算：以无下级的主体申报为准，在指定快照上复算；区分名义库存与真正可用库存；值班视图从地区总数下钻差异来源与未决事项。
- `src/freeze.js` — 月报发布后冻结；换算规则修订只重算 `depends_on` 命中被改规则的指标。
- `src/views.js` — 分角色视图：企业端仅见自身校验问题、回执与采用值；产线明细仅本企业与监管角色可见。

## 状态与批次的迁移约定

- 库存状态枚举：`available`、`quality_isolated`。既有记录缺少 `inventory_status` 时一律视为 `available`。
- 申报批次类型：`original`、`correction`、`return_to_stock`、`quality_isolation`；迟报由 `submitted_at` 超过 `submission_deadline` 推导，不单独设类型。
- 更正批次通过 `supersedes` 指向被更正申报，按 `line_id` 覆盖对应行，不改写原始批次。
- 退货回库与质量隔离作为独立批次申报，库存复算在指定快照上按提交时间生效。

## 本地检查

运行 `npm test`。
