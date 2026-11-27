import { browserUuid } from '../src/client/browser-uuid.ts'
import type { ParticipantRole, ParticipantSnapshot, RequirementRecord } from '../src/protocol.ts'
import { hasVersionConfirmation, readyAdmission } from '../src/ready-admission.ts'
import { enterStage, readiness, readyMarkdown, versionChanged } from '../src/spec-lifecycle.ts'
import { buildStructuredDiff } from '../src/structured-diff.ts'

const title = '报表导出结果保留多久'
const participants: Record<ParticipantRole, ParticipantSnapshot> = {
  product: { participantId: 'demo-product', role: 'product', nickname: '演示产品', kind: 'human' },
  engineering: { participantId: 'demo-engineering', role: 'engineering', nickname: '演示研发', kind: 'human' },
}
const roles = ['product', 'engineering'] as const

function spec(hours?: number): string {
  const rule = hours === undefined ? '保留时长待澄清。' : `生成完成后保留 ${hours} 小时，超时后拒绝下载，并提示用户重新导出。`
  return `## 目标与用户结果
用户离开报表页后，仍可在导出记录中找到最近生成的报表。

## 范围与非范围
支持本人下载已生成的报表。分享与批量导出不在此次范围。

## 业务术语与规则
报表生成完成时开始计时。下载权限限定为发起导出的账号。

## 验收标准
- **AC-01**：${rule}

## 测试约束
使用固定时钟和两个虚构账号验证到期边界及下载权限。`
}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const applyButton = el<HTMLButtonElement>('apply')
const precheckButton = el<HTMLButtonElement>('precheck')
const confirmButton = el<HTMLButtonElement>('confirm')
const downloadButton = el<HTMLButtonElement>('download')
const saveButton = el<HTMLButtonElement>('save')
const duration = el<HTMLInputElement>('duration')
const roleSelect = el<HTMLSelectElement>('role')

let record: RequirementRecord
let hours: number | undefined
let version: number
let role: ParticipantRole

function reset(): void {
  const now = Date.now()
  record = {
    id: 'DEMO-001', title, currentCommit: '演示-v1', stage: 'product-review', stageCycle: 0,
    workspaceId: 'demo-report', createdAt: now, updatedAt: now,
    sources: [], reviewItems: [], comments: [], patches: [], decisions: [],
    confirmations: [], actionItems: [], aiRuns: [], aiConversations: [],
  }
  hours = undefined
  version = 1
  role = 'product'
  roleSelect.value = role
  duration.value = '24'
  el<HTMLDetailsElement>('suggestion').open = false
}

function saveVersion(nextHours: number): void {
  version += 1
  versionChanged(record, spec(hours), { commit: `演示-v${version}`, markdown: spec(nextHours) }, Date.now(), browserUuid)
  hours = nextHours
  duration.value = String(nextHours)
}

function render(notice?: string): void {
  const admission = readyAdmission(record, readiness(spec(hours), record))
  const roleConfirmed = hasVersionConfirmation(record, role)
  el('version').textContent = record.currentCommit
  el('spec').textContent = spec(hours)
  el('stage').textContent = record.stage === 'ready' ? 'Ready' : hours === undefined ? '产品初审' : '产研共审'
  for (const signer of roles) {
    const active = hasVersionConfirmation(record, signer)
    const invalidated = record.confirmations.some(item => item.role === signer && item.status === 'invalidated')
    const status = el(`status-${signer}`)
    status.textContent = active ? '已确认当前版本' : invalidated ? '旧确认已失效' : '待确认'
    status.dataset.confirmed = String(active)
  }

  const reviewed = admission.engineeringReviewed
  el('precheck-state').textContent = reviewed ? '当前版本预审已通过' : '当前版本待预审'
  applyButton.disabled = hours !== undefined
  precheckButton.disabled = hours === undefined || reviewed
  roleSelect.disabled = hours === undefined
  confirmButton.disabled = !reviewed || roleConfirmed
  el<HTMLFieldSetElement>('adjustment').disabled = hours === undefined
  saveButton.disabled = !duration.validity.valid || duration.valueAsNumber === hours
  downloadButton.disabled = record.stage !== 'ready' && admission.error !== undefined
  if (notice !== undefined) el('result').textContent = notice
}

const diff = buildStructuredDiff(spec(), spec(24))
const diffList = el('diff')
for (const line of diff.hunks.flatMap(hunk => hunk.lines).filter(line => line.type !== 'context')) {
  const row = document.createElement('li')
  row.className = line.type
  row.textContent = `${line.type === 'added' ? '新增' : '移除'}　${line.text.replaceAll('**', '').replace(/^- /, '')}`
  diffList.append(row)
}

applyButton.addEventListener('click', () => {
  saveVersion(24)
  enterStage(record, 'joint-review')
  render('已采纳建议并保存演示-v2。可以开始研发预审。')
  precheckButton.focus()
})

precheckButton.addEventListener('click', () => {
  const now = Date.now()
  record.aiRuns.push({
    id: browserUuid(), requirementId: record.id, commit: record.currentCommit, kind: 'engineering-precheck',
    status: 'completed', requestedBy: participants.engineering, createdAt: now, updatedAt: now,
  })
  render('预设研发预审已通过。请分别以产品和研发身份确认当前版本。')
  roleSelect.focus()
})

roleSelect.addEventListener('change', () => {
  role = roleSelect.value === 'engineering' ? 'engineering' : 'product'
  render()
})

confirmButton.addEventListener('click', () => {
  const participant = participants[role]
  record.confirmations.push({
    id: browserUuid(), requirementId: record.id, commit: record.currentCommit, role, participant,
    scope: 'version', status: 'active', createdAt: Date.now(),
  })
  render(`${participant.nickname}已确认${record.currentCommit}。`)
  if (downloadButton.disabled) roleSelect.focus()
  else downloadButton.focus()
})

duration.addEventListener('input', () => {
  saveButton.disabled = !duration.validity.valid || duration.valueAsNumber === hours
})
el<HTMLFormElement>('edit').addEventListener('submit', event => {
  event.preventDefault()
  if (saveButton.disabled) return
  const confirmed = record.confirmations.some(item => item.status === 'active')
  saveVersion(duration.valueAsNumber)
  render(`已保存${record.currentCommit}。${confirmed ? '旧确认已失效。' : ''}请重新运行预审。`)
  precheckButton.focus()
})

downloadButton.addEventListener('click', () => {
  const markdown = spec(hours)
  if (record.stage !== 'ready' && readyAdmission(record, readiness(markdown, record)).error) return
  enterStage(record, 'ready')
  const content = readyMarkdown(record, markdown)
  const url = URL.createObjectURL(new Blob([`> Spec Collab 单文件演示 · 虚构需求、预设审核结果及模拟确认\n\n${content}`], {
    type: 'text/markdown;charset=utf-8',
  }))
  const link = document.createElement('a')
  link.href = url
  link.download = `DEMO-001-v${version}-ready-spec.md`
  document.body.append(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  render(`${record.currentCommit} 已通过 Ready 检查并开始下载。`)
})

el('reset').addEventListener('click', () => {
  reset()
  render('演示已重置。')
  el('suggestion-toggle').focus()
})
reset()
render('先展开审核问题，查看并采纳候选修改。')
