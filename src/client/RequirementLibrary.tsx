import { useId, useState } from 'react'
import type { Notification, ParticipantSnapshot, RequirementStage, RequirementSummary, ReviewWorkspaceSummary } from '../protocol.ts'
import css from './workbench.module.css'

export const stageLabels: Record<RequirementStage, string> = {
  'product-review': '澄清',
  'product-confirmation': '产品确认',
  'joint-review': '产研确认',
  ready: '已就绪',
}

export const stages = Object.keys(stageLabels) as RequirementStage[]
type Status = 'all' | 'archived' | RequirementStage
const defaults = { workspaceId: '', participantId: '', risk: false, unread: false, insights: false }

export function StageTrack({ stage }: { stage: RequirementStage }) {
  const current = stages.indexOf(stage)
  return <ol className={css.stageTrack} aria-label="需求进度">
    {stages.map((step, index) => <li key={step} aria-current={index === current ? 'step' : undefined} data-progress={index < current ? 'done' : index === current ? 'current' : 'pending'}>
      <span aria-hidden="true">{index < current ? '✓' : index + 1}</span>{stageLabels[step]}
    </li>)}
  </ol>
}

interface LibraryProps {
  requirements: RequirementSummary[]
  workspaces: ReviewWorkspaceSummary[]
  participants: ParticipantSnapshot[]
  notifications: Notification[]
  loading: boolean
  error?: string | undefined
  activeId?: string | undefined
  onCreate: () => void
  onRetry: () => void
  onOpen: (id: string) => void
  onRename: (item: RequirementSummary) => void
  onArchive: (item: RequirementSummary) => void
  onDelete: (item: RequirementSummary) => void
}

export function RequirementLibrary({ requirements, workspaces, participants, notifications, loading, error, activeId, onCreate, onRetry, onOpen, onRename, onArchive, onDelete }: LibraryProps) {
  const searchId = useId()
  const [status, setStatus] = useState<Status>('all')
  const [query, setQuery] = useState('')
  const [filters, setFilters] = useState(defaults)
  const [actionsId, setActionsId] = useState<string>()
  const workspaceTitles = new Map(workspaces.map(item => [item.workspaceId, item.title]))
  const unread = new Set(notifications.filter(item => item.readAt === undefined).map(item => item.requirementId))
  const active = requirements.filter(item => item.archivedAt === undefined)
  const counts = Object.fromEntries(stages.map(stage => [stage, active.filter(item => item.stage === stage).length]))
  const filterCount = Object.values(filters).filter(Boolean).length
  const search = query.trim().toLocaleLowerCase()
  const visible = requirements.filter(item => {
    const workspaceTitle = item.workspaceId ? workspaceTitles.get(item.workspaceId) : undefined
    return (status === 'archived' ? item.archivedAt !== undefined : item.archivedAt === undefined && (status === 'all' || item.stage === status))
      && (!search || `${item.title}\n${item.id}\n${workspaceTitle ?? ''}`.toLocaleLowerCase().includes(search))
      && (!filters.workspaceId || item.workspaceId === filters.workspaceId)
      && (!filters.participantId || item.participantIds.includes(filters.participantId))
      && (!filters.risk || item.metrics.riskCount > 0)
      && (!filters.unread || unread.has(item.id))
      && (!filters.insights || item.metrics.insightCount > 0)
  }).sort((left, right) => right.updatedAt - left.updatedAt)
  const resetFilters = (): void => { setFilters(defaults); setQuery('') }
  function chooseStatus(next: Status): void { setStatus(next); setActionsId(undefined) }

  return <main className={css.library} aria-label="需求库">
    <div className={css.libraryContent}>
      <div className={css.libraryMasthead}>
        <div>
          <h1>需求库</h1>
          {requirements.length > 0 && <p>{active.length - (counts.ready ?? 0)} 条进行中<span aria-hidden="true"> / </span>{counts.ready ?? 0} 条已就绪</p>}
        </div>
        <button className={css.primaryAction} onClick={onCreate}><span aria-hidden="true">＋</span> 新建需求</button>
      </div>
      <div className={css.libraryToolbar}>
        <label htmlFor={searchId} className={css.librarySearch}><span className={css.searchGlyph} aria-hidden="true"/><span className={css.srOnly}>搜索需求</span><input id={searchId} type="search" value={query} placeholder="搜索需求、编号或工作区" onChange={event => setQuery(event.target.value)}/></label>
        <details className={css.libraryFilters}>
          <summary>筛选{filterCount > 0 && <b>{filterCount}</b>}</summary>
          <div className={css.libraryFilterFields}>
            <label>工作区<select value={filters.workspaceId} onChange={event => setFilters(current => ({ ...current, workspaceId: event.target.value }))}><option value="">全部工作区</option>{workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title}</option>)}</select></label>
            <label>参与者<select value={filters.participantId} onChange={event => setFilters(current => ({ ...current, participantId: event.target.value }))}><option value="">全部参与者</option>{participants.map(person => <option key={person.participantId} value={person.participantId}>{person.nickname}</option>)}</select></label>
            <div>
              <label><input type="checkbox" checked={filters.risk} onChange={event => setFilters(current => ({ ...current, risk: event.target.checked }))}/>有风险</label>
              <label><input type="checkbox" checked={filters.unread} onChange={event => setFilters(current => ({ ...current, unread: event.target.checked }))}/>有未读</label>
              <label><input type="checkbox" checked={filters.insights} onChange={event => setFilters(current => ({ ...current, insights: event.target.checked }))}/>有洞察</label>
            </div>
          </div>
        </details>
      </div>
      <div className={css.libraryScopes} role="group" aria-label="按阶段筛选需求">
        <button aria-pressed={status === 'all'} onClick={() => chooseStatus('all')}>全部 <b>{active.length}</b></button>
        {stages.map(stage => <button key={stage} aria-pressed={status === stage} onClick={() => chooseStatus(stage)}>{stageLabels[stage]} <b>{counts[stage] ?? 0}</b></button>)}
        <button aria-pressed={status === 'archived'} onClick={() => chooseStatus('archived')}>已归档</button>
        {(filterCount > 0 || search) && <button className={css.clearFilters} onClick={resetFilters}>清除筛选</button>}
      </div>
      {error ? <div className={css.libraryEmpty}><h2>需求库加载失败</h2><p>{error}</p><button onClick={onRetry}>重试</button></div> : loading ? <div className={css.libraryEmpty} role="status">正在加载需求…</div> : visible.length > 0 ? <ul className={css.libraryCards} aria-label="需求列表">
        {visible.map(item => {
          const workspace = (item.workspaceId && workspaceTitles.get(item.workspaceId)) || (item.workspaceId ? '已关联工作区' : '未关联工作区')
          const pending = item.metrics.pendingActionCount
          const open = actionsId === item.id
          return <li className={css.libraryCard} key={item.id} data-stage={item.stage}>
            <button type="button" className={css.cardOpen} data-requirement-id={item.id} onClick={() => { setActionsId(undefined); onOpen(item.id) }}>
              <span className={css.cardStatus}><i aria-hidden="true"/>{item.archivedAt !== undefined ? '已归档' : stageLabels[item.stage]}{unread.has(item.id) && <small>有未读</small>}</span>
              <strong>{item.title}</strong>
              <span className={css.cardWorkspace}>{workspace}</span>
              <span className={css.cardFoot}><time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</time><span>{item.metrics.riskCount > 0 ? `${item.metrics.riskCount} 项风险` : pending > 0 ? `${pending} 项待办` : ''}</span></span>
            </button>
            <div className={css.cardActionsMenu} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setActionsId(current => current === item.id ? undefined : current) }} onKeyDown={event => {
              if (event.key !== 'Escape' || !open) return
              event.stopPropagation()
              event.currentTarget.querySelector('button')?.focus()
              setActionsId(undefined)
            }}>
              <button className={css.cardMore} aria-label={`${item.title} 更多操作`} aria-expanded={open} onClick={() => setActionsId(open ? undefined : item.id)}>···</button>
              {open && <div className={css.cardMenu}>
                <button onClick={() => { setActionsId(undefined); onRename(item) }}>重命名</button>
                <button onClick={() => { setActionsId(undefined); onArchive(item) }}>{item.archivedAt !== undefined ? '取消归档' : '归档需求'}</button>
                <button className={css.dangerText} onClick={() => { setActionsId(undefined); onDelete(item) }}>删除需求</button>
              </div>}
            </div>
            {activeId === item.id && <span className={css.srOnly}>上次打开</span>}
          </li>
        })}
      </ul> : <div className={css.libraryEmpty}>
        <h2>{search || filterCount ? '没有匹配的需求' : status === 'archived' ? '还没有归档需求' : status === 'all' ? '还没有需求' : `没有处于${stageLabels[status]}阶段的需求`}</h2>
        {search || filterCount ? <button onClick={resetFilters}>清除筛选</button> : status === 'all' ? <p>点击「新建需求」，写下要解决的问题和期望结果。</p> : <button onClick={() => chooseStatus('all')}>查看全部需求</button>}
      </div>}
    </div>
  </main>
}
