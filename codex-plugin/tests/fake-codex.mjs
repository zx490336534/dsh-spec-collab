#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { markdown } from './fixture.mjs'

const prompt = readFileSync(0, 'utf8')
const option = name => process.argv[process.argv.indexOf(name) + 1]
const schema = JSON.parse(readFileSync(option('--output-schema'), 'utf8'))
if (option('--sandbox') !== 'read-only' || !prompt.includes('订单报表验证项目')) process.exit(21)
if (prompt.includes('模拟返回无效结果')) {
  writeFileSync(option('--output-last-message'), '{"invalid": true}')
  process.exit(0)
}
if (prompt.includes('模拟延迟审核')) await delay(2_000)

let result = { maturitySummary: '已结合项目资料核对当前需求。', items: [], patch: null }
if (schema.properties.body) {
  result = { body: '已复核导出规则。权限来源和空结果行为已在当前正文中说明。' }
} else if (prompt.includes('产品初审。') && !prompt.includes('AC-EXPORT-001')) {
  result = {
    maturitySummary: '导出依据和空结果行为待产品确认。',
    patch: null,
    items: [{
      type: 'scope',
      severity: 'blocking',
      statement: '导出范围与报表筛选的关系未定义。',
      epistemicStatus: 'TO_VERIFY',
      impact: '运营人员容易拿到与当前报表范围不同的数据。',
      question: '导出使用哪些筛选条件？',
      recommendedOptions: ['沿用当前筛选，下载本月查询结果', '固定本月范围，忽略其他筛选', '发起导出时单独选择日期'],
      sourceAnchors: [{ heading: '原始需求与来源', quote: '运营人员需要把本月报表导出为 CSV' }],
      affectedSections: ['范围与非范围'],
      affectedAcceptanceIds: [],
      ownerRole: 'product',
      status: 'open',
      evidence: [],
    }],
  }
} else if (prompt.includes('产品复审。') && !prompt.includes('AC-EXPORT-001')) {
  const existing = prompt.match(/"reviewItems":\[\{"type":.*?"id":"([^"]+)"/)?.[1]
  result = {
    maturitySummary: '产品已选择沿用当前筛选，可以审阅候选正文。',
    items: [],
    patch: {
      proposedMarkdown: markdown,
      summary: '补齐导出范围、权限和验收标准',
      affectedReviewItemIds: existing ? [existing] : [],
      affectedSections: ['范围与非范围', '需求与验收标准'],
      affectedAcceptanceIds: ['AC-EXPORT-001', 'AC-EXPORT-002', 'AC-EXPORT-003'],
    },
  }
}
writeFileSync(option('--output-last-message'), JSON.stringify(result))
