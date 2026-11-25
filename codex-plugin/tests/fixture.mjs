export const title = '运营报表导出'
export const raw = '运营人员需要把本月报表导出为 CSV，方便在表格中核对订单。'
export const product = { participantId: 'fixture-product', nickname: '林舟', role: 'product', kind: 'human' }
export const engineering = { participantId: 'fixture-engineering', nickname: '周遥', role: 'engineering', kind: 'human' }
export const markdown = `# ${title}

## 原始需求与来源

${raw}

## 目标与用户结果

授权运营人员可以把当前筛选的订单报表导出，并在表格中核对统计口径与订单金额。

## 范围与非范围

支持运营工作台的订单报表导出，保留当前日期筛选条件。不包含定时推送、订单编辑和财务对账。

## 业务术语与规则

CSV 为逗号分隔值文件，编码使用 UTF-8。导出字段依次为订单号、下单时间和订单金额。只有拥有报表查看权限的运营人员能发起导出。

## 需求与验收标准

- **AC-EXPORT-001**：前提：授权运营人员筛选本月订单；操作：点击导出；预期结果：下载 CSV，文件包含本月筛选结果和三列标题。
- **AC-EXPORT-002**：前提：当前筛选没有订单；操作：点击导出；预期结果：提示没有可导出数据，并且浏览器没有下载文件。
- **AC-EXPORT-003**：前提：账号没有报表查看权限；操作：打开报表或发起导出；预期结果：拒绝进入或下载。

## 测试约束

使用隔离环境和两种权限的测试账号，以固定日期创建三笔虚构订单和一个空结果。测试文件中只使用合成订单数据。
`
