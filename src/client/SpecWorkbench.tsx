import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import MarkdownIt from 'markdown-it'
import ToastEditor from '@toast-ui/editor'
import '@toast-ui/editor/dist/i18n/zh-cn'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { CollaborationAction, CommentResolution, MyActionItem, ParticipantRole, ParticipantSnapshot, RequirementStage, RequirementVersion, RequirementView, ReviewItemType, ReviewKind, ReviewWorkspaceSummary, SaveConflict } from '../protocol.ts'
import type { SpecApi } from './api.ts'
import { browserUuid } from './browser-uuid.ts'
import { friendlyActionError, workflowState, type TaskView, type WorkflowCommand, type WorkflowState } from './workflow.ts'
import css from './workbench.module.css'

const md = new MarkdownIt({ html: false, linkify: true })
const inlineStyleRule = (pattern: RegExp, markName: 'strong' | 'emph' | 'code'): InputRule => new InputRule(pattern, (state, match, start, end) => {
  const text = match[1]
  const mark = state.schema.marks[markName]
  if (!text || !mark) return null
  return state.tr.delete(start, end).insertText(text, start).addMark(start, start + text.length, mark.create())
})
const markdownShortcutsPlugin = () => ({ wysiwygPlugins: [() => inputRules({ rules: [
  new InputRule(/^(#{1,6})\s$/, (state, match, start, end) => state.tr.delete(start, end).setBlockType(start, start, state.schema.nodes.heading!, { level: match[1]!.length })),
  new InputRule(/^```\s$/, (state, _match, start, end) => state.tr.delete(start, end).setBlockType(start, start, state.schema.nodes.codeBlock!)),
  inlineStyleRule(/\*\*([^*]+)\*\*$/, 'strong'), inlineStyleRule(/(?<!\*)\*([^*]+)\*$/, 'emph'), inlineStyleRule(/`([^`]+)`$/, 'code'),
] })] })
type PrimaryMode = 'tasks' | 'discussion' | 'records'
type RecordView = 'decisions' | 'versions'
type CommentAnchor = { quote: string; prefix: string; suffix: string; heading?: string }
function newParticipant(): ParticipantSnapshot { return { participantId: browserUuid(), nickname: '', role: 'product', kind: 'human' } }
function loadParticipant(): ParticipantSnapshot { try { const value = JSON.parse(localStorage.getItem('dsh-spec-collab.participant') ?? '') as ParticipantSnapshot; if (value.participantId) return { ...value, kind: 'human' } } catch {} return newParticipant() }
function stageLabel(stage: RequirementStage): string { return ({ 'product-review': '产品审核', 'product-confirmation': '产品确认', 'joint-review': '产研共审', ready: 'Ready' })[stage] }
function currentPendingActions(requirement: RequirementView): RequirementView['actionItems'] {
  const currentSourceIds = new Set([
    ...requirement.reviewItems.filter(item => item.commit === requirement.currentCommit).map(item => item.id),
    ...requirement.comments.filter(item => item.commit === requirement.currentCommit).map(item => item.id),
    ...requirement.patches.filter(item => item.baseCommit === requirement.currentCommit).map(item => item.id),
    ...requirement.decisions.filter(item => item.commit === requirement.currentCommit).map(item => item.id),
    ...requirement.confirmations.filter(item => item.commit === requirement.currentCommit).map(item => item.id),
  ])
  return requirement.actionItems.filter(item => item.status === 'pending' && currentSourceIds.has(item.sourceId))
}
export function SpecWorkbench({ api, onClose }: { api: SpecApi; onClose: () => void }) {
  const [requirements, setRequirements] = useState<RequirementView[]>([])
  const [reviewWorkspaces, setReviewWorkspaces] = useState<ReviewWorkspaceSummary[]>([])
  const [participantBindings, setParticipantBindings] = useState<ParticipantSnapshot[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [participant, setParticipant] = useState(loadParticipant)
  const [identityOpen, setIdentityOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [bindWorkspaceOpen, setBindWorkspaceOpen] = useState(false)
  const [bindWorkspaceId, setBindWorkspaceId] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [manageMenuId, setManageMenuId] = useState<string>()
  const [manageTargetId, setManageTargetId] = useState<string>()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [renameTitle, setRenameTitle] = useState('')
  const [documentsOpen, setDocumentsOpen] = useState(true)
  const [reviewOpen, setReviewOpen] = useState(true)
  const [documentsWidth, setDocumentsWidth] = useState(() => Number(localStorage.getItem('dsh-spec-collab.documents-width')) || 220)
  const [reviewWidth, setReviewWidth] = useState(() => Number(localStorage.getItem('dsh-spec-collab.review-width')) || 430)
  const [createForm, setCreateForm] = useState({ title: '', rawRequirement: '', sources: '', workspaceId: '' })
  const [primaryMode, setPrimaryMode] = useState<PrimaryMode>('tasks')
  const [taskView, setTaskView] = useState<TaskView>('review')
  const [recordView, setRecordView] = useState<RecordView>('decisions')
  const [mobilePane, setMobilePane] = useState<'spec' | 'collab'>('spec')
  const [draft, setDraft] = useState('')
  const [summary, setSummary] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveConflict, setSaveConflict] = useState<SaveConflict>()
  const [mergeDraft, setMergeDraft] = useState('')
  const [myItems, setMyItems] = useState<MyActionItem[]>([])
  const [commentText, setCommentText] = useState('')
  const [selection, setSelection] = useState<CommentAnchor>()
  const [draftSelection, setDraftSelection] = useState<CommentAnchor>()
  const visibleRequirements = requirements.filter(item => Boolean(item.archivedAt) === showArchived)
  const selected = requirements.find(item => item.id === selectedId) ?? visibleRequirements[0]
  const manageTarget = requirements.find(item => item.id === manageTargetId)
  const boundRole = participantBindings.find(item => item.participantId === participant.participantId)?.role
  const currentMyItems = selected ? myItems.filter(item => item.requirementId === selected.id) : []
  const currentReviews = selected?.reviewItems.filter(item => item.commit === selected.currentCommit && !['resolved', 'invalidated', 'non-blocking-verify'].includes(item.status)) ?? []
  const pendingPatches = selected?.patches.filter(item => item.baseCommit === selected.currentCommit && item.status === 'pending') ?? []
  const openDiscussions = selected?.comments.filter(item => item.commit === selected.currentCommit && item.status === 'open').length ?? 0
  const failedChecks = selected?.readiness.filter(item => !item.passed).length ?? 0
  const workflow = selected ? workflowState(selected, participant.role) : undefined

  const refresh = async (): Promise<void> => { try { const state = await api.state(); setRequirements(state.requirements); setParticipantBindings(state.participants); const binding = state.participants.find(item => item.participantId === participant.participantId); if (binding && binding.role !== participant.role) setParticipant(current => ({ ...current, role: binding.role })); setSelectedId(current => current && state.requirements.some(item => item.id === current) ? current : state.requirements[0]?.id) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }
  useEffect(() => { void refresh(); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))); return api.events(() => { void refresh() }) }, [])
  useEffect(() => { if (selected) setDraft(selected.version.markdown) }, [selected?.id, selected?.currentCommit])
  useEffect(() => { localStorage.setItem('dsh-spec-collab.participant', JSON.stringify(participant)) }, [participant])
  useEffect(() => { localStorage.setItem('dsh-spec-collab.documents-width', String(documentsWidth)) }, [documentsWidth])
  useEffect(() => { localStorage.setItem('dsh-spec-collab.review-width', String(reviewWidth)) }, [reviewWidth])
  useEffect(() => { if (!registered) { setMyItems([]); return }; void api.myItems(participant).then(setMyItems, error => setNotice(error instanceof Error ? error.message : String(error))) }, [participant.participantId, participant.role, requirements])
  const registered = participant.nickname.trim().length >= 2

  const act = async (factory: (actor: ParticipantSnapshot) => CollaborationAction): Promise<boolean> => {
    if (!registered) { setIdentityOpen(true); setNotice('首次写操作前请登记花名'); return false }
    setBusy(true); setNotice('')
    try {
      const result = await api.action(factory(participant))
      if (!result.ok) {
        if (result.conflict) { setSaveConflict(result.conflict); setMergeDraft(result.conflict.draftMarkdown); setNotice('检测到并发修改。请在三方对比中合并后再提交。'); return false }
        setNotice(friendlyActionError(result.error)); return false
      }
      setSaveConflict(undefined); await refresh(); if (!result.deletedRequirementId) setSelectedId(result.requirement.id); return true
    }
    finally { setBusy(false) }
  }

  const create = async (): Promise<void> => {
    const links = createForm.sources.split('\n').map(value => value.trim()).filter(Boolean)
    const ok = await act(actor => ({ kind: 'requirement.create', participant: actor, title: createForm.title, rawRequirement: createForm.rawRequirement, workspaceId: createForm.workspaceId, sources: links.map((label, index) => ({ id: `source-${index + 1}`, sourceType: /^https?:/.test(label) ? 'link' : 'text', label, ...(/^https?:/.test(label) ? { stableId: label } : {}), accessStatus: /^https?:/.test(label) ? 'unverified' : 'available' })) }))
    if (ok) { setCreateOpen(false); setCreateForm({ title: '', rawRequirement: '', sources: '', workspaceId: '' }); setPrimaryMode('tasks'); setTaskView('review') }
  }
  const bindWorkspace = async (): Promise<void> => { if (!selected || !bindWorkspaceId) return; if (await act(actor => ({ kind: 'requirement.bind-workspace', participant: actor, requirementId: selected.id, workspaceId: bindWorkspaceId }))) { setBindWorkspaceOpen(false); setBindWorkspaceId('') } }
  const save = async (): Promise<void> => { if (!selected) return; const ok = await act(actor => ({ kind: 'version.save', participant: actor, requirementId: selected.id, baseCommit: selected.currentCommit, markdown: draft, summary })); if (ok) { setSummary(''); setNotice('已创建新的 Git commit，等待变更审核') } }
  const requestReview = async (reviewKind: ReviewKind): Promise<void> => { if (!selected) return; await act(actor => ({ kind: 'review.request', participant: actor, requirementId: selected.id, reviewKind })) }
  const confirm = async (role: ParticipantRole): Promise<void> => { if (!selected) return; await act(actor => ({ kind: 'confirmation.create', participant: actor, requirementId: selected.id, role, scope: 'version' })) }
  const advance = async (): Promise<void> => { if (!selected) return; await act(actor => ({ kind: 'stage.advance', participant: actor, requirementId: selected.id })) }
  const executeWorkflow = async (command: WorkflowCommand): Promise<void> => {
    if (!selected || command.kind === 'none') return
    if (command.kind === 'open') { setPrimaryMode('tasks'); setTaskView(command.view); setMobilePane('collab'); return }
    if (command.kind === 'bind-workspace') { setBindWorkspaceOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))); return }
    if (command.kind === 'request-review') { setTaskView('review'); await requestReview(command.reviewKind); return }
    if (command.kind === 'advance') { await advance(); return }
    if (command.kind === 'confirm') { await confirm(command.role); return }
    setTaskView('ready')
    await act(actor => ({ kind: 'ready.generate', participant: actor, requirementId: selected.id }))
  }
  const openMyItem = (item: MyActionItem): void => {
    if (item.target.tab === 'discussion') setPrimaryMode('discussion')
    else if (item.target.tab === 'decisions') { setPrimaryMode('records'); setRecordView('decisions') }
    else { setPrimaryMode('tasks'); setTaskView(item.target.tab === 'patches' ? 'patches' : item.target.tab === 'ready' ? 'ready' : 'review') }
    setMobilePane('collab')
    window.setTimeout(() => document.getElementById(`spec-object-${item.target.objectId}`)?.scrollIntoView({ block: 'center' }), 100)
  }
  const resizePane = (side: 'documents' | 'review', event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault()
    const startX = event.clientX; const startWidth = side === 'documents' ? documentsWidth : reviewWidth
    const move = (pointer: PointerEvent): void => {
      const next = startWidth + (pointer.clientX - startX) * (side === 'documents' ? 1 : -1)
      if (side === 'documents') setDocumentsWidth(Math.min(360, Math.max(160, next)))
      else setReviewWidth(Math.min(600, Math.max(320, next)))
    }
    const stop = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop); document.body.style.cursor = '' }
    document.body.style.cursor = 'col-resize'; window.addEventListener('pointermove', move); window.addEventListener('pointerup', stop)
  }
  const renameRequirement = async (): Promise<void> => { if (!manageTarget) return; if (await act(actor => ({ kind: 'requirement.rename', participant: actor, requirementId: manageTarget.id, title: renameTitle }))) { setRenameOpen(false); setManageTargetId(undefined) } }
  const archiveRequirement = async (target: RequirementView): Promise<void> => { const archived = !target.archivedAt; if (await act(actor => ({ kind: 'requirement.archive', participant: actor, requirementId: target.id, archived }))) { setManageMenuId(undefined); setSelectedId(visibleRequirements.find(item => item.id !== target.id)?.id) } }
  const deleteRequirement = async (): Promise<void> => { if (!manageTarget) return; if (await act(actor => ({ kind: 'requirement.delete', participant: actor, requirementId: manageTarget.id }))) { setDeleteOpen(false); setManageMenuId(undefined); setManageTargetId(undefined) } }

  const captureSelection = (): void => {
    if (!draftSelection) return
    setSelection(draftSelection)
    setDraftSelection(undefined)
    setPrimaryMode('discussion')
    setMobilePane('collab')
  }
  const addComment = async (): Promise<void> => { if (!selected || !selection) return; const ok = await act(actor => ({ kind: 'comment.create', participant: actor, requirementId: selected.id, commit: selected.currentCommit, anchor: selection, body: commentText })); if (ok) { setSelection(undefined); setCommentText(''); setNotice('评论已提交，AI 正在自动分析理解、证据与关联影响') } }

  return <div className={css.workbench}>
    <header className={css.header}>
      <div className={css.titleBlock}>
        <span className={css.productName}>需求共创</span>
        <strong>{selected?.title ?? '把模糊需求变成可交付规范'}</strong>
        {selected && <span>{reviewWorkspaces.find(workspace => workspace.workspaceId === selected.workspaceId)?.title ?? (selected.workspaceId ? '项目已关联' : '未关联项目')} · 版本 {selected.currentCommit.slice(0, 8)}</span>}
      </div>
      {selected && <StageRail stage={selected.stage}/>}
      <div className={css.headerActions}>
        <button className={css.quietButton} aria-label="返回聊天" onClick={onClose}><span aria-hidden="true">←</span><span className={css.backLabel}>返回聊天</span></button>
        <button className={css.identity} onClick={() => setIdentityOpen(true)}>{registered ? `${participant.nickname} · ${participant.role === 'product' ? '产品' : '研发'}` : '登记身份'}</button>
      </div>
    </header>
    <div className={notice ? css.notice : css.noticeHidden}>{notice}<button aria-label="关闭" onClick={() => setNotice('')}>×</button></div>
    <div className={css.mobileViewSwitch}><button className={mobilePane === 'spec' ? css.activeMode : ''} onClick={() => setMobilePane('spec')}>需求正文</button><button className={mobilePane === 'collab' ? css.activeMode : ''} onClick={() => setMobilePane('collab')}>下一步{currentMyItems.length > 0 ? ` · ${currentMyItems.length}` : ''}</button></div>
    <div className={`${css.grid} ${mobilePane === 'spec' ? css.mobileSpec : css.mobileCollab}`} style={{ '--documents-width': documentsOpen ? `${documentsWidth}px` : '0px', '--documents-handle': documentsOpen ? '6px' : '0px', '--review-width': reviewOpen ? `${reviewWidth}px` : '0px', '--review-handle': reviewOpen ? '6px' : '0px' } as CSSProperties}>
      <aside className={`${css.documents} ${documentsOpen ? '' : css.paneClosed}`} aria-label="需求列表">
        <div className={css.paneHead}><strong>{showArchived ? '已归档' : '需求'}</strong><div className={css.paneActions}><button onClick={() => { setShowArchived(value => !value); setSelectedId(undefined); setManageMenuId(undefined) }}>{showArchived ? '返回进行中' : '查看归档'}</button>{!showArchived && <button className={css.createButton} aria-label="新建需求" title="新建需求" onClick={() => { setCreateOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))) }}>＋</button>}<button className={css.iconButton} aria-label="收起需求栏" title="收起需求栏" onClick={() => setDocumentsOpen(false)}>‹</button></div></div>
        <nav>{visibleRequirements.map(item => <div className={css.requirementRow} key={item.id}><button className={`${css.documentButton} ${item.id === selected?.id ? css.selectedDoc : ''}`} onClick={() => { setSelectedId(item.id); setPrimaryMode('tasks') }}><span>{item.title}</span><small><i className={`${css.statusDot} ${css[`stage_${item.stage}`]}`}/>{item.archivedAt ? `归档于 ${new Date(item.archivedAt).toLocaleDateString()}` : `${stageLabel(item.stage)}${item.stage !== 'ready' && currentPendingActions(item).filter(task => task.blocking).length > 0 ? ` · ${currentPendingActions(item).filter(task => task.blocking).length} 项待处理` : ''}`}</small></button><button className={css.rowMenuButton} aria-label={`${item.title} 更多操作`} title="更多操作" onClick={() => { setSelectedId(item.id); setManageMenuId(current => current === item.id ? undefined : item.id) }}>…</button>{manageMenuId === item.id && <div className={css.requirementMenu}><button onClick={() => { setManageTargetId(item.id); setRenameTitle(item.title); setRenameOpen(true); setManageMenuId(undefined) }}>重命名</button><button onClick={() => void archiveRequirement(item)}>{item.archivedAt ? '取消归档' : '归档需求'}</button><button className={css.dangerText} onClick={() => { setManageTargetId(item.id); setDeleteOpen(true); setManageMenuId(undefined) }}>删除需求</button></div>}</div>)}</nav>
        {visibleRequirements.length === 0 && <div className={css.emptyList}><strong>{showArchived ? '还没有归档需求' : '从一个真实问题开始'}</strong><p>{showArchived ? '归档后的需求会出现在这里。' : '输入原始需求，AI 会先帮你找出缺口。'}</p>{!showArchived && <button onClick={() => { setCreateOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))) }}>新建需求</button>}</div>}
      </aside>
      <div className={`${css.resizer} ${documentsOpen ? '' : css.resizerHidden}`} role="separator" aria-label="调整需求栏宽度" aria-orientation="vertical" onPointerDown={event => resizePane('documents', event)}/>
      <main className={css.editorPane}>
        <div className={css.toolbar}><div className={css.editorTitle}>{!documentsOpen && <button className={css.iconButton} aria-label="展开需求栏" title="展开需求栏" onClick={() => setDocumentsOpen(true)}>›</button>}<div><span>正式需求</span><strong>需求正文</strong></div></div><div><span className={draft !== selected?.version.markdown ? css.unsaved : css.editorMeta}>{draft !== selected?.version.markdown ? '有未保存改动' : '所有改动已保存'}</span><input className={css.summaryInput} required aria-label="说明本次改动" value={summary} onChange={event => setSummary(event.target.value)} placeholder="简要说明本次改动"/><button className={css.saveButton} disabled={busy || !selected || draft === selected.version.markdown || !summary.trim()} onClick={() => void save()}>保存版本</button>{!reviewOpen && <button className={css.iconButton} aria-label="展开下一步面板" title="展开下一步面板" onClick={() => setReviewOpen(true)}>‹</button>}</div></div>
        {draftSelection && <div className={css.editorContext}><div className={css.selectionPrompt}><span>已选 {draftSelection.quote.length} 字 · “{draftSelection.quote.replace(/\s+/g, ' ').slice(0, 48)}{draftSelection.quote.length > 48 ? '…' : ''}”</span><button className={css.commentAction} onClick={captureSelection}>添加评论</button><button aria-label="取消文字选择" title="取消文字选择" onClick={() => setDraftSelection(undefined)}>×</button></div></div>}
        {!selected ? <div className={css.emptyMain}><div><span>从问题到共识</span><h2>创建第一份需求</h2><p>写下用户问题和期望结果，AI 会协助补齐范围、规则与验收标准。</p><button className={css.execute} onClick={() => { setCreateOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))) }}>新建需求</button></div></div> : <div className={css.editorBody}><RichMarkdownEditor key={`${selected.id}:${selected.currentCommit}`} markdown={draft} onChange={setDraft} onSelection={quote => setDraftSelection(quote ? { quote, prefix: '', suffix: '' } : undefined)}/></div>}
      </main>
      <div className={`${css.resizer} ${reviewOpen ? '' : css.resizerHidden}`} role="separator" aria-label="调整协作栏宽度" aria-orientation="vertical" onPointerDown={event => resizePane('review', event)}/>
      <aside className={`${css.review} ${reviewOpen ? '' : css.paneClosed}`} aria-label="需求协作">
        <div className={css.primaryNav}><div role="tablist" aria-label="协作视图"><button role="tab" aria-selected={primaryMode === 'tasks'} className={primaryMode === 'tasks' ? css.activeMode : ''} onClick={() => setPrimaryMode('tasks')}>下一步{currentMyItems.length > 0 && <span className={css.tabBadge}>{currentMyItems.length}</span>}</button><button role="tab" aria-selected={primaryMode === 'discussion'} className={primaryMode === 'discussion' ? css.activeMode : ''} onClick={() => setPrimaryMode('discussion')}>讨论{openDiscussions > 0 && <span className={css.tabBadge}>{openDiscussions}</span>}</button><button role="tab" aria-selected={primaryMode === 'records'} className={primaryMode === 'records' ? css.activeMode : ''} onClick={() => setPrimaryMode('records')}>记录</button></div><button className={`${css.iconButton} ${css.collapseRight}`} aria-label="收起下一步面板" title="收起下一步面板" onClick={() => setReviewOpen(false)}>›</button></div>
        {selected && primaryMode === 'tasks' && <>
          {workflow && <WorkflowFocus state={workflow} pendingForMe={currentMyItems.length} onExecute={() => void executeWorkflow(workflow.command)}/>}
          {currentMyItems.length > 0 && <TaskQueue items={currentMyItems} open={openMyItem}/>}
          <div className={css.contextNav} role="tablist" aria-label="待处理内容"><button role="tab" aria-selected={taskView === 'review'} className={taskView === 'review' ? css.activeContext : ''} onClick={() => setTaskView('review')}>问题{currentReviews.length > 0 && <span>{currentReviews.length}</span>}</button><button role="tab" aria-selected={taskView === 'patches'} className={taskView === 'patches' ? css.activeContext : ''} onClick={() => setTaskView('patches')}>AI 建议{pendingPatches.length > 0 && <span>{pendingPatches.length}</span>}</button><button role="tab" aria-selected={taskView === 'ready'} className={taskView === 'ready' ? css.activeContext : ''} onClick={() => setTaskView('ready')}>完成条件{failedChecks > 0 && <span>{failedChecks}</span>}</button></div>
          <div className={css.threadList}>{taskView === 'review' && <ReviewPanel requirement={selected} act={act} api={api}/>} {taskView === 'patches' && <PatchPanel requirement={selected} act={act}/>} {taskView === 'ready' && <ReadyPanel requirement={selected} act={act}/>}</div>
        </>}
        {selected && primaryMode === 'discussion' && <div className={css.threadList}><DiscussionPanel requirement={selected} selection={selection} text={commentText} setText={setCommentText} cancel={() => setSelection(undefined)} submit={addComment} participant={participant} act={act} api={api}/></div>}
        {selected && primaryMode === 'records' && <><div className={css.contextNav} role="tablist" aria-label="需求记录"><button role="tab" aria-selected={recordView === 'decisions'} className={recordView === 'decisions' ? css.activeContext : ''} onClick={() => setRecordView('decisions')}>关键决策</button><button role="tab" aria-selected={recordView === 'versions'} className={recordView === 'versions' ? css.activeContext : ''} onClick={() => setRecordView('versions')}>版本历史</button></div><div className={css.threadList}>{recordView === 'decisions' && <DecisionPanel requirement={selected} act={act}/>} {recordView === 'versions' && <VersionPanel requirement={selected} api={api}/>}</div></>}
        {!selected && <div className={css.emptyAside}><strong>等待创建需求</strong><p>创建后，下一步操作会显示在这里。</p></div>}
      </aside>
    </div>
    <footer className={css.footer}><span>AI 可以检查和建议，最终版本始终由人确认</span><span>{selected ? `${stageLabel(selected.stage)} · ${selected.currentCommit.slice(0, 8)} · ${selected.aiRuns.at(-1)?.status === 'running' ? 'AI 分析中' : '版本已记录'}` : '从原始需求开始'}</span></footer>
    {identityOpen && <IdentityDialog value={participant} {...(boundRole === undefined ? {} : { boundRole })} onChange={setParticipant} close={() => setIdentityOpen(false)}/>} {createOpen && <CreateDialog value={createForm} setValue={setCreateForm} workspaces={reviewWorkspaces} close={() => setCreateOpen(false)} submit={() => void create()} busy={busy}/>} {bindWorkspaceOpen && selected && <WorkspaceDialog value={bindWorkspaceId} setValue={setBindWorkspaceId} workspaces={reviewWorkspaces} close={() => { setBindWorkspaceOpen(false); setBindWorkspaceId('') }} submit={() => void bindWorkspace()} busy={busy}/>} {renameOpen && <RenameDialog title={renameTitle} setTitle={setRenameTitle} close={() => { setRenameOpen(false); setManageTargetId(undefined) }} submit={() => void renameRequirement()} busy={busy}/>} {deleteOpen && manageTarget && <DeleteDialog title={manageTarget.title} close={() => { setDeleteOpen(false); setManageTargetId(undefined) }} submit={() => void deleteRequirement()} busy={busy}/>} {saveConflict && <ConflictDialog conflict={saveConflict} value={mergeDraft} setValue={setMergeDraft} close={() => setSaveConflict(undefined)} busy={busy} submit={() => void act(actor => ({ kind: 'version.save', participant: actor, requirementId: saveConflict.requirementId, baseCommit: saveConflict.currentCommit, markdown: mergeDraft, summary })).then(ok => { if (ok) { setDraft(mergeDraft); setSummary(''); setSaveConflict(undefined); setNotice('冲突已合并并创建新的 Git commit') } })}/>}
  </div>
}

const stageSteps: Array<{ stage: RequirementStage; label: string }> = [
  { stage: 'product-review', label: '澄清' },
  { stage: 'product-confirmation', label: '产品确认' },
  { stage: 'joint-review', label: '产研确认' },
  { stage: 'ready', label: '已就绪' },
]
function StageRail({ stage }: { stage: RequirementStage }) {
  const activeIndex = stageSteps.findIndex(item => item.stage === stage)
  return <ol className={css.stageRail} aria-label="需求进度">{stageSteps.map((item, index) => <li className={index < activeIndex ? css.stageDone : index === activeIndex ? css.stageCurrent : ''} key={item.stage} aria-current={index === activeIndex ? 'step' : undefined}><span>{index < activeIndex ? '✓' : index + 1}</span><b>{item.label}</b></li>)}</ol>
}
function WorkflowFocus({ state, pendingForMe, onExecute }: { state: WorkflowState; pendingForMe: number; onExecute: () => void }) {
  return <section className={css.workflowFocus}>
    <div className={css.workflowEyebrow}><span>{state.eyebrow}</span>{pendingForMe > 0 && <small>{pendingForMe} 项与你相关</small>}</div>
    <h2>{state.title}</h2>
    <p>{state.detail}</p>
    <button className={css.execute} disabled={state.disabled} title={state.disabledReason} onClick={onExecute}>{state.command.kind === 'none' && state.disabled ? <span className={css.runningDot}/> : null}{state.actionLabel}<span aria-hidden="true">→</span></button>
    {state.disabledReason && <small className={css.disabledReason}>{state.disabledReason}</small>}
  </section>
}
const taskTypeLabel: Record<MyActionItem['type'], string> = { reply: '需要回复', confirm: '需要确认', review: '需要审核', reconfirm: '需要重新确认' }
function TaskQueue({ items, open }: { items: MyActionItem[]; open: (item: MyActionItem) => void }) {
  const sorted = items.slice().sort((left, right) => Number(right.blocking) - Number(left.blocking) || right.updatedAt - left.updatedAt)
  return <details className={css.taskQueue}><summary><span>与你相关的事项</span><b>{items.length}</b></summary><div>{sorted.map(item => <button key={item.id} onClick={() => open(item)}><span>{item.blocking ? '优先' : '普通'}</span><div><strong>{taskTypeLabel[item.type]}</strong><small>{new Date(item.updatedAt).toLocaleString()}</small></div><i aria-hidden="true">›</i></button>)}</div></details>
}

function RichMarkdownEditor({ markdown, onChange, onSelection }: { markdown: string; onChange: (markdown: string) => void; onSelection: (quote: string) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<ToastEditor>()
  const interacted = useRef(false)
  const syncing = useRef(false)
  const onChangeRef = useRef(onChange)
  const onSelectionRef = useRef(onSelection)
  onChangeRef.current = onChange
  onSelectionRef.current = onSelection
  useEffect(() => {
    if (!host.current) return
    const editor = new ToastEditor({ el: host.current, initialValue: markdown, initialEditType: 'wysiwyg', hideModeSwitch: true, toolbarItems: [], plugins: [markdownShortcutsPlugin], height: '100%', language: 'zh-CN', usageStatistics: false, autofocus: false })
    const markInteraction = (): void => { interacted.current = true }
    const change = (): void => { if (interacted.current && !syncing.current) onChangeRef.current(editor.getMarkdown()) }
    const selection = (): void => onSelectionRef.current(editor.getSelectedText().trim())
    editor.on('change', change)
    host.current.addEventListener('beforeinput', markInteraction)
    host.current.addEventListener('paste', markInteraction)
    host.current.addEventListener('drop', markInteraction)
    host.current.addEventListener('pointerdown', markInteraction)
    host.current.addEventListener('mouseup', selection)
    host.current.addEventListener('keyup', selection)
    instance.current = editor
    return () => { host.current?.removeEventListener('beforeinput', markInteraction); host.current?.removeEventListener('paste', markInteraction); host.current?.removeEventListener('drop', markInteraction); host.current?.removeEventListener('pointerdown', markInteraction); host.current?.removeEventListener('mouseup', selection); host.current?.removeEventListener('keyup', selection); editor.destroy() }
  }, [])
  useEffect(() => {
    const editor = instance.current
    if (!editor || editor.getMarkdown() === markdown) return
    syncing.current = true
    editor.setMarkdown(markdown)
    syncing.current = false
  }, [markdown])
  return <div className={css.richEditor} ref={host}/>
}

type Act = (factory: (actor: ParticipantSnapshot) => CollaborationAction) => Promise<boolean>
const reviewKindLabel: Record<ReviewKind, string> = { 'product-first': '需求缺口检查', 'product-second': '正文整理检查', 'engineering-precheck': '研发可行性检查', 'change-review': '改动影响检查' }
const reviewTypeLabel: Record<ReviewItemType, string> = { goal: '目标', evidence: '依据', 'history-conflict': '历史冲突', 'current-implementation': '当前实现', scope: '范围', semantics: '规则语义', completeness: '完整性', acceptance: '验收', risk: '风险' }
const statusLabel: Record<string, string> = { queued: '排队中', running: '分析中', completed: '已完成', failed: '失败', open: '待处理', answered: '已回答待整理', 'joint-review': '待产研共议', 'non-blocking-verify': '保留待核对', resolved: '已解决', invalidated: '已失效', pending: '待确认', accepted: '已接受', rejected: '未采用', stale: '已过期', blocking: '阻塞', major: '重要', minor: '一般' }
const evidenceStatusLabel: Record<string, string> = { FACT: '已有依据', INFERENCE: '根据现有信息推断', ASSUMPTION: '暂定规则', TO_VERIFY: '待核对' }
function MarkdownBody({ text, className = '' }: { text: string; className?: string | undefined }) { return <div className={`${css.markdownBody} ${className}`} dangerouslySetInnerHTML={{ __html: md.render(text) }}/> }
type ReviewItemView = RequirementView['reviewItems'][number]
export function ReviewPanel({ requirement, act, api }: { requirement: RequirementView; act: Act; api: SpecApi }) {
  const [selectedItemId, setSelectedItemId] = useState<string>()
  const closeSelectedItem = useCallback(() => setSelectedItemId(undefined), [])
  const current = requirement.reviewItems.filter(item => item.commit === requirement.currentCommit).slice().sort((left, right) => Number(right.severity === 'blocking') - Number(left.severity === 'blocking') || right.updatedAt - left.updatedAt)
  const historical = requirement.reviewItems.filter(item => item.commit !== requirement.currentCommit)
  const active = current.filter(item => !['resolved', 'invalidated', 'non-blocking-verify'].includes(item.status))
  const deferred = current.filter(item => item.status === 'non-blocking-verify')
  const pendingCount = active.length
  const settledCount = current.length - pendingCount
  const selectedItem = [...current, ...historical].find(item => item.id === selectedItemId)
  const currentRuns = requirement.aiRuns.filter(run => run.commit === requirement.currentCommit)
  return <>
    <div className={css.panelSummary}><div><strong>问题检查清单</strong><span>{pendingCount > 0 ? `${pendingCount} 项待处理 · ${active.filter(item => item.severity === 'blocking').length} 项阻塞下一阶段` : '当前版本已全部处理'}</span></div>{current.length > 0 && <div className={css.checklistMeter}><small>{settledCount}/{current.length}</small><progress aria-label={`已处理 ${settledCount} 项，共 ${current.length} 项`} value={settledCount} max={current.length}/></div>}</div>
    {currentRuns.length > 0 && <details className={css.runHistory}><summary>查看本轮 AI 检查记录（{currentRuns.length}）</summary>{currentRuns.slice().reverse().map(run => <div className={css.run} key={run.id}><div><strong>{reviewKindLabel[run.kind]}</strong><span>{statusLabel[run.status] ?? run.status}</span></div>{run.maturitySummary && <MarkdownBody text={run.maturitySummary}/>} {run.error && <p className={css.chatError}>{friendlyActionError(run.error)}</p>}{run.sessionId && <AiConversation api={api} requirementId={requirement.id} sessionId={run.sessionId}/>}</div>)}</details>}
    {current.length === 0 && <div className={css.emptyPanel}><strong>等待 AI 完成检查</strong><p>检查结果会按优先级出现在这里。</p></div>}
    {active.length > 0 && <ReviewChecklist items={active} open={setSelectedItemId}/>}
    {deferred.length > 0 && <details className={css.historyGroup}><summary>保留待核对 · {deferred.length}</summary><ReviewChecklist items={deferred} open={setSelectedItemId}/></details>}
    {historical.length > 0 && <details className={css.historyGroup}><summary>历史问题 · {historical.length}</summary><ReviewChecklist items={historical.slice().reverse()} open={setSelectedItemId}/></details>}
    {selectedItem && <ReviewDecisionDialog key={selectedItem.id} item={selectedItem} requirementId={requirement.id} act={act} close={closeSelectedItem}/>}
  </>
}
function ReviewChecklist({ items, open }: { items: ReviewItemView[]; open: (itemId: string) => void }) {
  return <div className={css.reviewChecklist}>{items.map(item => <ReviewChecklistRow key={item.id} item={item} open={open}/>)}</div>
}
function ReviewChecklistRow({ item, open }: { item: ReviewItemView; open: (itemId: string) => void }) {
  const settled = ['resolved', 'invalidated', 'non-blocking-verify'].includes(item.status)
  const question = item.question.trim() || item.statement.trim()
  return <button id={`spec-object-${item.id}`} className={`${css.reviewChecklistRow} ${item.severity === 'blocking' && !settled ? css.reviewChecklistBlocking : ''} ${settled ? css.reviewChecklistSettled : ''}`} title={question} aria-haspopup="dialog" onClick={() => open(item.id)}>
    <span className={css.reviewCheckBox} aria-hidden="true">{settled ? '✓' : ''}</span>
    <span className={css.reviewCheckCopy}><span className={css.reviewCheckMeta}><b>{reviewTypeLabel[item.type]}</b><small>{item.evidence.length > 0 ? `${item.evidence.length} 条依据` : evidenceStatusLabel[item.epistemicStatus]}</small></span><strong>{question}</strong></span>
    <span className={css.reviewCheckStatus}>{statusLabel[item.status] ?? item.status}</span><span className={css.reviewCheckArrow} aria-hidden="true">›</span>
  </button>
}
const dispositionLabel = { context: '补充我的判断', evidence: '补充依据或案例', accept: '这个结论可以直接采用', 'accept-modified': '采用，并同步修改正文', reject: '不采用，并说明原因', 'to-verify': '现在无法确认，保留待核对', 'joint-review': '交给产品和研发共同确认' } as const
function ReviewDecisionDialog({ item, requirementId, act, close }: { item: ReviewItemView; requirementId: string; act: Act; close: () => void }) {
  const [disposition, setDisposition] = useState<keyof typeof dispositionLabel>('context')
  const [body, setBody] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const recommendations = item.recommendedOptions?.map(option => option.trim()).filter(Boolean).slice(0, 5) ?? []
  const canRespond = !item.response && item.status === 'open'
  useEffect(() => {
    const dialog = dialogRef.current
    const focusableSelector = 'button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
    const focusable = (): HTMLElement[] => dialog ? Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)) : []
    if (dialog && !dialog.contains(document.activeElement)) (dialog.querySelector<HTMLElement>('textarea') ?? focusable()[0])?.focus()
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
      if (event.key !== 'Tab') return
      const controls = focusable()
      if (controls.length === 0) { event.preventDefault(); return }
      const first = controls[0]!
      const last = controls[controls.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', keydown)
    return () => { window.removeEventListener('keydown', keydown); returnFocusRef.current?.focus() }
  }, [close])
  const choose = (option: string): void => { setBody(option); setDisposition('accept-modified') }
  const submit = async (): Promise<void> => { if (await act(actor => ({ kind: 'review.respond', participant: actor, requirementId, reviewItemId: item.id, disposition, body }))) close() }
  const sendToJointReview = async (): Promise<void> => { if (await act(actor => ({ kind: 'review.respond', participant: actor, requirementId, reviewItemId: item.id, disposition: 'joint-review', body: '转产研共同决策' }))) close() }
  return <div className={`${css.modal} ${css.reviewDecisionModal}`} onMouseDown={event => { if (event.currentTarget === event.target) close() }}>
    <section ref={dialogRef} className={css.reviewDecisionDialog} role="dialog" aria-modal="true" aria-labelledby={`review-dialog-${item.id}`}>
      <header className={css.reviewDecisionHeader}><div><div className={css.decisionTags}><b>{statusLabel[item.severity] ?? item.severity}</b><span>{reviewTypeLabel[item.type]}</span><span>{evidenceStatusLabel[item.epistemicStatus] ?? item.epistemicStatus}</span></div><h2 id={`review-dialog-${item.id}`}>{item.statement}</h2></div><button aria-label="关闭问题窗口" title="关闭" onClick={close}>×</button></header>
      <div className={css.reviewDecisionBody}>
        <main className={css.reviewDecisionContext}>
          <section className={css.decisionQuestion}><span>待澄清问题</span><MarkdownBody text={item.question}/></section>
          <section className={css.decisionSection}><h3>为什么需要明确</h3><MarkdownBody text={item.impact}/></section>
          <section className={css.decisionSection}><div className={css.decisionSectionHead}><h3>依据与来源</h3><span>{item.evidence.length} 条</span></div>{item.evidence.length === 0 ? <p className={css.decisionEmpty}>当前没有可核对的资料，可以按业务判断回答，或选择保留待核对。</p> : <div className={css.decisionEvidenceList}>{item.evidence.map((evidence, index) => <div className={css.decisionEvidence} key={`${evidence.source}-${index}`}><code>{evidence.source}{evidence.version ? `@${evidence.version}` : ''}</code><MarkdownBody text={evidence.statement}/></div>)}</div>}</section>
          {(item.affectedSections.length > 0 || item.affectedAcceptanceIds.length > 0) && <section className={css.decisionSection}><h3>可能影响</h3><p>{[...item.affectedSections, ...item.affectedAcceptanceIds].join(' · ')}</p></section>}
        </main>
        <aside className={css.reviewDecisionAside} aria-label="处理这个问题">
          {item.response ? <div className={css.decisionResponse}><span>已回复</span><strong>{item.response.participant.nickname}</strong><small>{dispositionLabel[item.response.disposition]}</small><MarkdownBody text={item.response.body}/></div> : canRespond ? <>
            <div className={css.decisionAsideHead}><span>你的决定</span><strong>选择一个方向，或写下完整结论</strong></div>
            {recommendations.length > 0 && <fieldset className={css.decisionOptions}><legend>推荐方向</legend>{recommendations.map((option, index) => <button key={option} className={body === option ? css.selectedDecisionOption : ''} aria-pressed={body === option} onClick={() => choose(option)}><span>{option}</span><b>{body === option ? '已选择' : String(index + 1).padStart(2, '0')}</b></button>)}</fieldset>}
            <div className={css.decisionForm}><label>处理方式<select required value={disposition} onChange={event => setDisposition(event.target.value as keyof typeof dispositionLabel)}>{Object.entries(dispositionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>结论与补充说明<textarea required autoFocus value={body} onChange={event => setBody(event.target.value)} placeholder={disposition === 'evidence' ? '粘贴数据、案例或来源链接，并说明它支持什么结论' : '写清最终判断、适用范围、例外情况和取舍理由'}/></label></div>
            <div className={css.decisionActions}><button onClick={() => void sendToJointReview()}>交给产研共议</button><button className={css.execute} disabled={!body.trim()} onClick={() => void submit()}>保存回答</button></div>
          </> : <div className={css.decisionResponse}><span>{statusLabel[item.status] ?? item.status}</span><strong>这条记录当前不可回复</strong><p>你仍可以查看完整问题、影响和来源。</p></div>}
        </aside>
      </div>
    </section>
  </div>
}
function DiscussionPanel({ requirement, selection, text, setText, cancel, submit, act, api }: { requirement: RequirementView; selection: { quote: string } | undefined; text: string; setText: (value: string) => void; cancel: () => void; submit: () => Promise<void>; participant: ParticipantSnapshot; act: Act; api: SpecApi }) { return <>{selection && <section className={css.newThread}><blockquote>{selection.quote}</blockquote><label>评论内容（必填）<textarea required value={text} onChange={event => setText(event.target.value)} placeholder="输入实质评论；提交后智能助手自动分析"/></label><div><button onClick={cancel}>取消</button><button disabled={!text.trim()} onClick={() => void submit()}>提交并邀请智能助手</button></div></section>}{requirement.comments.slice().reverse().map(comment => <section id={`spec-object-${comment.id}`} key={comment.id}><blockquote>{comment.anchor.quote}</blockquote><strong>{comment.author.nickname}</strong><MarkdownBody text={comment.body}/><small>智能分析：{comment.aiStatus}{comment.aiSessionId ? ` · ${comment.aiSessionId.slice(0, 8)}` : ''}</small>{comment.aiSessionId && <AiConversation api={api} requirementId={requirement.id} sessionId={comment.aiSessionId}/>} {comment.replies.map(reply => <div className={css.reply} key={reply.id}><strong>{reply.author.nickname}{reply.author.kind === 'ai' ? ' · 智能助手' : ''}</strong><MarkdownBody text={reply.body}/></div>)}{comment.status === 'open' && <div>{(['written-back', 'decision', 'rejected', 'open-question'] as CommentResolution[]).map(resolution => <button key={resolution} onClick={() => void act(actor => ({ kind: 'comment.resolve', participant: actor, requirementId: requirement.id, commentId: comment.id, resolution }))}>{({ 'written-back': '已回写正文', decision: '形成决策', rejected: '不采纳', 'open-question': '转为开放问题' })[resolution]}</button>)}</div>}</section>)}</> }
function AiConversation({ api, requirementId, sessionId }: { api: SpecApi; requirementId: string; sessionId: string }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const load = async (): Promise<void> => { try { setMessages(await api.conversation(requirementId, sessionId)); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } }
  useEffect(() => { if (!open) return; void load(); const timer = window.setInterval(() => { void load() }, 3000); return () => window.clearInterval(timer) }, [open, requirementId, sessionId])
  const send = async (): Promise<void> => { if (!draft.trim()) return; setSending(true); try { await api.followUp(requirementId, sessionId, draft); setMessages(current => [...current, { role: 'user', text: draft }]); setDraft(''); window.setTimeout(() => { void load() }, 1000) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setSending(false) } }
  return <div className={css.aiConversation}><button className={`${css.chatToggle} ${open ? css.collapseChat : ''}`} aria-label={open ? '收起智能对话' : '展开智能对话'} title={open ? '收起智能对话' : '展开智能对话'} onClick={() => setOpen(value => !value)}>{open ? '⌃' : '展开智能对话'}</button>{open && <><div className={css.chatMessages}>{messages.map((message, index) => <div key={`${message.role}-${index}`} className={message.role === 'assistant' ? css.aiMessage : css.userMessage}><strong>{message.role === 'assistant' ? '智能助手' : '你'}</strong><div dangerouslySetInnerHTML={{ __html: md.render(message.text) }}/></div>)}{messages.length === 0 && !error && <small>正在读取审核会话…</small>}</div>{error && <p className={css.chatError}>{error}</p>}<div className={css.chatComposer}><textarea required aria-label="追问内容（必填）" value={draft} onChange={event => setDraft(event.target.value)} placeholder="追问内容（必填）"/><button disabled={sending || !draft.trim()} onClick={() => void send()}>发送</button></div></>}</div>
}
function PatchPanel({ requirement, act }: { requirement: RequirementView; act: Act }) {
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState<string>()
  const current = requirement.patches.filter(patch => patch.baseCommit === requirement.currentCommit && patch.status === 'pending').slice().reverse()
  const historical = requirement.patches.filter(patch => !current.some(item => item.id === patch.id)).slice().reverse()
  const renderPatch = (patch: RequirementView['patches'][number]) => {
    const chinese = /[\u3400-\u9fff]/.test(`${patch.summary}\n${patch.proposedMarkdown}`)
    const commitSummary = summaries[patch.id] ?? `合入 AI 建议：${patch.summary}`
    return <article id={`spec-object-${patch.id}`} className={css.reviewCard} key={patch.id}>
      <div className={css.badges}><b>{statusLabel[patch.status] ?? patch.status}</b><span>{reviewKindLabel[patch.reviewKind]}</span></div>
      <MarkdownBody text={patch.summary} className={css.reviewTitle}/>
      {!chinese && <div className={css.legacyWarning}><strong>旧建议无法使用</strong><p>这份建议生成于中文约束启用前，请重新运行 AI 检查。</p></div>}
      <details className={css.patchDetails}><summary>查看修改后的完整正文</summary><MarkdownBody text={patch.proposedMarkdown}/></details>
      {patch.status === 'pending' && (chinese ? <div className={css.patchAccept}><label>版本说明<input required value={commitSummary} onChange={event => setSummaries(currentValues => ({ ...currentValues, [patch.id]: event.target.value }))}/></label><div className={css.cardActions}><button className={css.execute} disabled={submitting === patch.id || !commitSummary.trim()} onClick={async () => { setSubmitting(patch.id); try { await act(actor => ({ kind: 'patch.accept', participant: actor, requirementId: requirement.id, patchId: patch.id, summary: commitSummary })) } finally { setSubmitting(undefined) } }}>{submitting === patch.id ? '正在写入…' : '接受并写入正文'}</button><button disabled={submitting === patch.id} onClick={() => void act(actor => ({ kind: 'patch.reject', participant: actor, requirementId: requirement.id, patchId: patch.id }))}>不采用</button></div></div> : <div className={css.cardActions}><button onClick={() => void act(actor => ({ kind: 'review.request', participant: actor, requirementId: requirement.id, reviewKind: patch.reviewKind }))}>重新生成建议</button><button onClick={() => void act(actor => ({ kind: 'patch.reject', participant: actor, requirementId: requirement.id, patchId: patch.id }))}>废弃旧建议</button></div>)}
    </article>
  }
  return <>{current.length === 0 && <div className={css.emptyPanel}><strong>当前没有需要审核的 AI 建议</strong><p>AI 根据你的回答整理正文后，建议会出现在这里。</p></div>}{current.map(renderPatch)}{historical.length > 0 && <details className={css.historyGroup}><summary>历史建议 · {historical.length}</summary><div>{historical.map(renderPatch)}</div></details>}</>
}
function DecisionPanel({ requirement, act }: { requirement: RequirementView; act: Act }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ question: '', decision: '', rationale: '' })
  const submit = async (): Promise<void> => { if (await act(actor => ({ kind: 'decision.create', participant: actor, requirementId: requirement.id, question: form.question, options: [], decision: form.decision, rationale: form.rationale, affectedSections: [], affectedAcceptanceIds: [] }))) { setOpen(false); setForm({ question: '', decision: '', rationale: '' }) } }
  return <>{requirement.decisions.map(item => <section id={`spec-object-${item.id}`} key={item.id}><MarkdownBody text={item.question} className={css.reviewTitle}/><MarkdownBody text={item.decision}/><small>{item.rationale} · {item.confirmer.nickname}</small></section>)}{open ? <div className={css.decisionForm}><label>待决策问题（必填）<textarea required autoFocus value={form.question} onChange={event => setForm({ ...form, question: event.target.value })}/></label><label>确认结论（必填）<textarea required value={form.decision} onChange={event => setForm({ ...form, decision: event.target.value })}/></label><label>决策理由（选填）<textarea value={form.rationale} onChange={event => setForm({ ...form, rationale: event.target.value })}/></label><div className={css.cardActions}><button onClick={() => setOpen(false)}>取消</button><button className={css.execute} disabled={!form.question.trim() || !form.decision.trim()} onClick={() => void submit()}>保存决策</button></div></div> : <button className={css.panelAction} onClick={() => setOpen(true)}>记录新决策</button>}</>
}
function VersionPanel({ requirement, api }: { requirement: RequirementView; api: SpecApi }) {
  const [historical, setHistorical] = useState<RequirementVersion>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const open = async (commit: string): Promise<void> => { setLoading(true); setError(''); try { setHistorical(await api.version(requirement.id, commit)) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) } }
  return <>{historical && <div className={css.versionCompare}><div className={css.compareHead}><strong>版本内容比对</strong><button aria-label="关闭版本比对" title="关闭版本比对" onClick={() => setHistorical(undefined)}>×</button></div><div className={css.compareColumns}><section><b>历史版本 · {historical.commit.slice(0, 8)}</b><MarkdownBody text={historical.markdown}/></section><section><b>当前版本 · {requirement.currentCommit.slice(0, 8)}</b><MarkdownBody text={requirement.version.markdown}/></section></div></div>}{error && <p className={css.chatError}>{error}</p>}{requirement.history.map(version => <button className={css.versionRow} key={version.commit} disabled={loading} onClick={() => void open(version.commit)}><code>{version.commit.slice(0, 10)}</code><span>{version.summary}</span><small>{version.author.nickname} · {new Date(version.createdAt).toLocaleString()}</small></button>)}</>
}
const readinessLabel: Record<string, string> = { goal: '目标与用户结果', acceptance: '验收标准', scope: '范围与非范围', semantics: '业务语义', evidence: '证据来源', 'test-constraints': '测试约束' }
function ReadyPanel({ requirement, act }: { requirement: RequirementView; act: Act }) {
  const [returnOpen, setReturnOpen] = useState(false)
  const [form, setForm] = useState({ summary: '', sections: '', acceptanceIds: '', source: '', version: '', evidence: '' })
  const submitReturn = async (): Promise<void> => {
    const ok = await act(actor => ({ kind: 'downstream.return', participant: actor, requirementId: requirement.id, summary: form.summary, affectedSections: form.sections.split(',').map(value => value.trim()).filter(Boolean), affectedAcceptanceIds: form.acceptanceIds.split(',').map(value => value.trim()).filter(Boolean), evidence: form.source.trim() ? [{ statement: form.evidence || form.summary, source: form.source, ...(form.version.trim() ? { version: form.version.trim() } : {}), accessible: true }] : [] }))
    if (ok) { setReturnOpen(false); setForm({ summary: '', sections: '', acceptanceIds: '', source: '', version: '', evidence: '' }) }
  }
  const passed = requirement.readiness.filter(check => check.passed).length
  return <><div className={css.readyHead}><h3>交付条件</h3><span>{passed} / {requirement.readiness.length} 已满足</span></div><div className={css.checklist}>{requirement.readiness.map(check => <section className={`${css.checkItem} ${check.passed ? css.checkPassed : css.checkBlocked}`} key={check.key}><span className={css.checkIcon} aria-hidden="true">{check.passed ? '✓' : '!'}</span><div><strong>{readinessLabel[check.key] ?? check.key}</strong><small>{check.passed ? '已满足' : '需要补充'}</small>{check.reasons.map(reason => <MarkdownBody key={reason} text={reason}/>)}</div></section>)}</div>{requirement.readyPackage && <section><strong>交付需求 · {requirement.readyPackage.packageHash.slice(0, 12)}</strong><MarkdownBody text={requirement.readyPackage.markdown}/></section>}{requirement.stage === 'ready' && <section className={css.downstreamReturn}><button onClick={() => setReturnOpen(value => !value)}>{returnOpen ? '取消返回问题' : '反馈研发阶段发现的问题'}</button>{returnOpen && <div><label>问题摘要（必填）<textarea required value={form.summary} onChange={event => setForm({ ...form, summary: event.target.value })} placeholder="描述研发阶段发现的产品语义或验收问题"/></label><label>受影响章节（与 AC 至少填写一项）<input value={form.sections} onChange={event => setForm({ ...form, sections: event.target.value })} placeholder="业务术语与规则"/></label><label>受影响 AC IDs（与章节至少填写一项）<input value={form.acceptanceIds} onChange={event => setForm({ ...form, acceptanceIds: event.target.value })} placeholder="AC-RETRY-001"/></label><label>依据来源（选填）<input value={form.source} onChange={event => setForm({ ...form, source: event.target.value })} placeholder="测试报告、Issue 或代码位置"/></label><label>依据版本（选填）<input value={form.version} onChange={event => setForm({ ...form, version: event.target.value })} placeholder="commit SHA 或版本号"/></label><label>依据说明（选填）<textarea value={form.evidence} onChange={event => setForm({ ...form, evidence: event.target.value })}/></label><button className={css.execute} disabled={!form.summary.trim() || (!form.sections.trim() && !form.acceptanceIds.trim())} onClick={() => void submitReturn()}>重新打开受影响内容</button></div>}</section>}</>
}
function ConflictDialog({ conflict, value, setValue, close, submit, busy }: { conflict: SaveConflict; value: string; setValue: (value: string) => void; close: () => void; submit: () => void; busy: boolean }) {
  return <div className={`${css.modal} ${css.conflictModal}`}><div className={css.conflictDialog}><div className={css.conflictHeader}><div><h2>解决保存冲突</h2><p>基线 {conflict.baseCommit.slice(0, 8)} 已被更新为 {conflict.currentCommit.slice(0, 8)}。Git 尚未写入你的草稿。</p></div><button aria-label="关闭冲突窗口" onClick={close}>×</button></div><div className={css.conflictColumns}><label>打开时的基线（只读）<textarea readOnly value={conflict.baseMarkdown}/></label><label>远端最新版本（只读）<textarea readOnly value={conflict.currentMarkdown}/></label><label>合并稿（必填）<textarea required value={value} onChange={event => setValue(event.target.value)}/></label></div><div className={css.conflictDiffs}><details><summary>基线 → 远端 Diff</summary><pre>{conflict.baseToCurrentDiff}</pre></details><details><summary>基线 → 本地草稿 Diff</summary><pre>{conflict.baseToDraftDiff}</pre></details></div><div className={css.conflictActions}><button onClick={close}>稍后处理</button><button className={css.execute} disabled={busy || !value.trim()} onClick={submit}>{busy ? '正在提交…' : '基于最新版本提交合并稿'}</button></div></div></div>
}
function IdentityDialog({ value, boundRole, onChange, close }: { value: ParticipantSnapshot; boundRole?: ParticipantRole; onChange: (value: ParticipantSnapshot) => void; close: () => void }) { return <div className={css.modal}><form onSubmit={event => { event.preventDefault(); if (value.nickname.trim().length >= 2) close() }}><h2>设置协作身份</h2><p>用于标记回答、决策和版本确认。同一浏览器首次参与后，角色会保持不变。</p><label>花名（必填）<input required autoFocus value={value.nickname} onChange={event => onChange({ ...value, nickname: event.target.value })}/></label><label>参与角色（必填）<select required disabled={boundRole !== undefined} value={boundRole ?? value.role} onChange={event => onChange({ ...value, role: event.target.value as ParticipantRole })}><option value="product">产品</option><option value="engineering">研发</option></select></label>{boundRole && <small>当前身份已固定为{boundRole === 'product' ? '产品' : '研发'}角色。</small>}<button type="submit" disabled={value.nickname.trim().length < 2}>保存身份</button></form></div> }
function RenameDialog({ title, setTitle, close, submit, busy }: { title: string; setTitle: (title: string) => void; close: () => void; submit: () => void; busy: boolean }) { return <div className={css.modal}><form onSubmit={event => { event.preventDefault(); submit() }}><h2>重命名需求</h2><label>需求名称（必填）<input required autoFocus value={title} onChange={event => setTitle(event.target.value)}/></label><div><button type="button" onClick={close}>取消</button><button type="submit" disabled={busy || !title.trim()}>保存名称</button></div></form></div> }
function DeleteDialog({ title, close, submit, busy }: { title: string; close: () => void; submit: () => void; busy: boolean }) { return <div className={css.modal}><form onSubmit={event => { event.preventDefault(); submit() }}><h2>删除需求</h2><p>将删除“{title}”及其协作记录，并创建 Git 删除提交。历史版本仍可从 Git 恢复。</p><div><button type="button" onClick={close}>取消</button><button type="submit" className={css.dangerButton} disabled={busy}>{busy ? '正在删除…' : '确认删除'}</button></div></form></div> }
function WorkspaceDialog({ value, setValue, workspaces, close, submit, busy }: { value: string; setValue: (value: string) => void; workspaces: ReviewWorkspaceSummary[]; close: () => void; submit: () => void; busy: boolean }) { return <div className={css.modal}><form onSubmit={event => { event.preventDefault(); submit() }}><h2>关联项目</h2><p>AI 会从所选项目读取代码、规范和团队知识。关联后不能中途切换。</p><label>需求所在项目（必填）<select required autoFocus value={value} onChange={event => setValue(event.target.value)}><option value="" disabled>{workspaces.length > 0 ? '选择一个项目' : '当前没有可用项目'}</option>{workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title} · {workspace.path}</option>)}</select></label><div><button type="button" onClick={close}>取消</button><button type="submit" disabled={busy || !value}>确认关联</button></div></form></div> }
function CreateDialog({ value, setValue, workspaces, close, submit, busy }: { value: { title: string; rawRequirement: string; sources: string; workspaceId: string }; setValue: (value: { title: string; rawRequirement: string; sources: string; workspaceId: string }) => void; workspaces: ReviewWorkspaceSummary[]; close: () => void; submit: () => void; busy: boolean }) { return <div className={css.modal}><form onSubmit={event => { event.preventDefault(); submit() }}><h2>新建需求</h2><p>先写清用户问题和期望结果，其余缺口交给 AI 检查。</p><label>需求标题（必填）<input required value={value.title} onChange={event => setValue({ ...value, title: event.target.value })}/></label><label>需求所在项目（必填）<select required value={value.workspaceId} onChange={event => setValue({ ...value, workspaceId: event.target.value })}><option value="" disabled>{workspaces.length > 0 ? '选择一个项目' : '当前没有可用项目'}</option>{workspaces.map(workspace => <option key={workspace.workspaceId} value={workspace.workspaceId}>{workspace.title} · {workspace.path}</option>)}</select></label><label>原始需求（必填）<textarea required value={value.rawRequirement} onChange={event => setValue({ ...value, rawRequirement: event.target.value })} placeholder="描述用户遇到的问题、期望结果、已有方案和已知限制"/></label><label>补充资料（选填，每行一项）<textarea value={value.sources} onChange={event => setValue({ ...value, sources: event.target.value })} placeholder="相关文档链接&#10;历史决策&#10;代码目录或组件"/></label><div><button type="button" onClick={close}>取消</button><button type="submit" disabled={busy || !value.title.trim() || !value.rawRequirement.trim() || !value.workspaceId}>创建并开始 AI 检查</button></div></form></div> }
