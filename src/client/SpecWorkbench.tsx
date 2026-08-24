import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import MarkdownIt from 'markdown-it'
import ToastEditor from '@toast-ui/editor'
import '@toast-ui/editor/dist/i18n/zh-cn'
import { InputRule, inputRules } from 'prosemirror-inputrules'
import type { CollaborationAction, CommentResolution, CommentThread, MyActionItem, Notification, ParticipantRole, ParticipantSnapshot, RequirementStage, RequirementView, ReviewItemType, ReviewKind, ReviewWorkspaceSummary, SaveConflict, StructuredDiff } from '../protocol.ts'
import type { SpecApi } from './api.ts'
import { browserUuid } from './browser-uuid.ts'
import { commentTargetElements, reviewBlockSelector, reviewSourceSnippets, reviewTargetElements } from './review-anchors.ts'
import { friendlyActionError, workflowState, type TaskView, type WorkflowCommand, type WorkflowState } from './workflow.ts'
import { AccessibleDialog } from './AccessibleDialog.tsx'
import { deleteDraft, loadDraft, safeHttpUrl, saveDraft, truncateGraphemes } from './drafts.ts'
import css from './workbench.module.css'

const md = new MarkdownIt({ html: false, linkify: false })
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
type PrimaryMode = 'tasks' | 'discussion' | 'insights' | 'records'
type RecordView = 'decisions' | 'versions'
type DeepLinkTarget = { primaryMode: PrimaryMode; taskView?: TaskView; recordView?: RecordView; focusObjectId?: string; reviewObjectId?: string; commentObjectId?: string; error?: string }
export function resolveDeepLinkTarget(requirement: RequirementView, view: string, objectId?: string): DeepLinkTarget {
  if (view === 'discussion') return { primaryMode: 'discussion', ...(objectId ? { focusObjectId: objectId, commentObjectId: objectId } : {}) }
  if (view === 'insights') return { primaryMode: 'insights', ...(objectId ? { focusObjectId: objectId } : {}) }
  if (view === 'records') {
    if (!objectId) return { primaryMode: 'records' }
    if (requirement.decisions.some(item => item.id === objectId)) return { primaryMode: 'records', recordView: 'decisions', focusObjectId: objectId }
    if (requirement.history.some(item => item.commit === objectId)) return { primaryMode: 'records', recordView: 'versions', focusObjectId: objectId }
    return { primaryMode: 'records', error: '链接指向的决策或版本不存在' }
  }
  if (view !== 'tasks') return { primaryMode: 'tasks', error: '链接指向的协作视图不存在' }
  if (!objectId) return { primaryMode: 'tasks' }
  if (objectId === requirement.id && requirement.stage === 'ready') return { primaryMode: 'tasks', taskView: 'ready' }
  const action = requirement.actionItems.find(item => item.id === objectId)
  const sourceType = action?.sourceType
  const sourceId = action?.sourceId ?? objectId
  if (sourceType === 'comment' || requirement.comments.some(item => item.id === sourceId)) return { primaryMode: 'discussion', focusObjectId: sourceId, commentObjectId: sourceId }
  if (sourceType === 'patch' || requirement.patches.some(item => item.id === sourceId)) return { primaryMode: 'tasks', taskView: 'patches', focusObjectId: sourceId }
  if (sourceType === 'decision' || requirement.decisions.some(item => item.id === sourceId)) return { primaryMode: 'records', recordView: 'decisions', focusObjectId: sourceId }
  if (sourceType === 'review-item' || requirement.reviewItems.some(item => item.id === sourceId)) return { primaryMode: 'tasks', taskView: 'review', focusObjectId: sourceId, reviewObjectId: sourceId }
  return { primaryMode: 'tasks', error: '链接指向的待办对象不存在或已失效' }
}
export type CommentAnchor = { quote: string; prefix: string; suffix: string; heading?: string }
export type InlinePopoverPosition = { rect: { top: number; left: number }; placement: 'above' | 'below'; maxHeight?: number }
export type EditorSelection = CommentAnchor & InlinePopoverPosition
type ReviewOpenRequest = { objectId: string; requestId: number }
type InlineReviewTarget = { itemId: string; sourceKey?: string } & Partial<InlinePopoverPosition>
type DocumentAnchorFocus = { kind: 'review'; objectId: string; sourceKey?: string } | { kind: 'comment'; objectId: string }
type PendingNavigation = { kind: 'select'; requirementId: string } | { kind: 'close' } | { kind: 'toggle-archive' }
const inlineReviewPopoverSize = { width: 520, height: 620 } as const
function inlinePopoverPositionFromRect(rect: Pick<DOMRect, 'top' | 'bottom' | 'left'>, size: { width: number; height: number }): InlinePopoverPosition {
  const padding = 12
  const gap = 10
  const viewportMaxHeight = Math.max(160, window.innerHeight - padding * 2)
  const desiredHeight = Math.min(size.height, viewportMaxHeight)
  const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - gap - padding)
  const spaceAbove = Math.max(0, rect.top - gap - padding)
  const usefulBelowHeight = Math.min(desiredHeight, size.height > 360 ? 280 : 180)
  const placement: InlinePopoverPosition['placement'] = spaceBelow >= usefulBelowHeight || spaceBelow >= spaceAbove ? 'below' : 'above'
  const available = placement === 'below' ? spaceBelow : spaceAbove
  const maxHeight = Math.max(160, Math.min(desiredHeight, available || viewportMaxHeight))
  const rawTop = placement === 'below' ? rect.bottom + gap : rect.top - maxHeight - gap
  const top = Math.min(Math.max(padding, rawTop), Math.max(padding, window.innerHeight - maxHeight - padding))
  const left = Math.min(Math.max(padding, rect.left), Math.max(padding, window.innerWidth - size.width - padding))
  return { rect: { top, left }, placement, maxHeight }
}
function visibleEditorContents(root: HTMLElement | null | undefined): HTMLElement | undefined {
  const candidates = Array.from(root?.querySelectorAll<HTMLElement>('.toastui-editor-contents') ?? [])
  const visible = candidates.filter(element => {
    const rect = element.getBoundingClientRect()
    const style = window.getComputedStyle(element)
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
  })
  return visible.find(element => element.classList.contains('ProseMirror')) ?? visible[0] ?? candidates.find(element => element.classList.contains('ProseMirror')) ?? candidates.at(-1)
}
export function annotationScrollTargets(root: HTMLElement | null | undefined): HTMLElement[] {
  if (!root) return []
  const targets: HTMLElement[] = []
  const add = (element: HTMLElement | null | undefined): void => {
    if (element && !targets.includes(element)) targets.push(element)
  }
  add(visibleEditorContents(root))
  root.querySelectorAll<HTMLElement>('.ProseMirror.toastui-editor-contents, .toastui-editor-ww-container, .toastui-editor-main').forEach(add)
  return targets
}
function newParticipant(): ParticipantSnapshot { return { participantId: browserUuid(), nickname: '', role: 'product', kind: 'human' } }
function loadParticipant(): ParticipantSnapshot { try { const value = JSON.parse(localStorage.getItem('dsh-spec-collab.participant') ?? '') as ParticipantSnapshot; if (value.participantId) return { ...value, kind: 'human' } } catch {} return newParticipant() }
function stageLabel(stage: RequirementStage): string { return ({ 'product-review': '澄清', 'product-confirmation': '产品确认', 'joint-review': '产研确认', ready: '已就绪' })[stage] }
function relativeTime(timestamp: number): string { const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000)); if (seconds < 60) return '刚刚'; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes} 分钟前`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours} 小时前`; return `${Math.floor(hours / 24)} 天前` }
function durationText(milliseconds: number): string { const seconds = Math.max(0, Math.round(milliseconds / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` }
function cleanDisplayText(value: string, max = 84): string { return truncateGraphemes(value.replace(/\uFFFD+/g, ''), max) }
function downloadText(name: string, text: string): void { const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url) }
function handleTabs<T extends string>(event: ReactKeyboardEvent<HTMLElement>, values: readonly T[], current: T, setCurrent: (value: T) => void): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault(); const index = Math.max(0, values.indexOf(current)); const next = event.key === 'Home' ? 0 : event.key === 'End' ? values.length - 1 : event.key === 'ArrowRight' ? (index + 1) % values.length : (index - 1 + values.length) % values.length
  setCurrent(values[next]!); window.setTimeout(() => (event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next])?.focus(), 0)
}
function requirementParticipantIds(requirement: RequirementView): Set<string> { return new Set([
  ...requirement.history.map(item => item.author.participantId),
  ...requirement.reviewItems.flatMap(item => item.response ? [item.response.participant.participantId] : []),
  ...requirement.comments.flatMap(item => [item.author.participantId, ...item.replies.map(reply => reply.author.participantId)]),
  ...requirement.decisions.map(item => item.confirmer.participantId),
  ...requirement.confirmations.map(item => item.participant.participantId),
  ...requirement.actionItems.flatMap(item => item.assigneeParticipantId ? [item.assigneeParticipantId] : []),
]) }
export function SpecWorkbench({ api, onClose }: { api: SpecApi; onClose: () => void }) {
  const workbenchRef = useRef<HTMLDivElement>(null)
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
  const [focusMode, setFocusMode] = useState(false)
  const previousPaneState = useRef({ documents: true, review: true })
  const [documentDrawerOpen, setDocumentDrawerOpen] = useState(false)
  const [documentsWidth, setDocumentsWidth] = useState(() => Number(localStorage.getItem('dsh-spec-collab.documents-width')) || 220)
  const [reviewWidth, setReviewWidth] = useState(() => Number(localStorage.getItem('dsh-spec-collab.review-width')) || 430)
  const [createForm, setCreateForm] = useState({ title: '', rawRequirement: '', sources: '', workspaceId: '' })
  const [primaryMode, setPrimaryMode] = useState<PrimaryMode>('tasks')
  const [taskView, setTaskView] = useState<TaskView>('review')
  const [recordView, setRecordView] = useState<RecordView>('decisions')
  const [pendingWorkflow, setPendingWorkflow] = useState<Extract<WorkflowCommand, { kind: 'advance' | 'confirm' | 'generate-ready' }>>()
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation>()
  const [mobilePane, setMobilePane] = useState<'spec' | 'collab'>('spec')
  const [reviewOpenRequest, setReviewOpenRequest] = useState<ReviewOpenRequest>()
  const reviewOpenRequestId = useRef(0)
  const [deepLinkObjectId, setDeepLinkObjectId] = useState<string>()
  const [documentFocus, setDocumentFocus] = useState<DocumentAnchorFocus>()
  const [documentFocusRequest, setDocumentFocusRequest] = useState(0)
  const [draft, setDraft] = useState('')
  const [summary, setSummary] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [saveConflict, setSaveConflict] = useState<SaveConflict>()
  const [mergeDraft, setMergeDraft] = useState('')
  const [myItems, setMyItems] = useState<MyActionItem[]>([])
  const [commentText, setCommentText] = useState('')
  const [draftSelection, setDraftSelection] = useState<EditorSelection>()
  const [inlineReview, setInlineReview] = useState<InlineReviewTarget>()
  const [requirementQuery, setRequirementQuery] = useState('')
  const [requirementFilters, setRequirementFilters] = useState<{ stage: 'all' | RequirementStage; participantId: string; risk: boolean; unread: boolean; insights: boolean }>({ stage: 'all', participantId: '', risk: false, unread: false, insights: false })
  const [pageCommentOpen, setPageCommentOpen] = useState(false)
  const [pageCommentText, setPageCommentText] = useState('')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [myWorkOpen, setMyWorkOpen] = useState(false)
  const [draftSavedAt, setDraftSavedAt] = useState<number>()
  const [undoArchiveId, setUndoArchiveId] = useState<string>()
  const scrollPositions = useRef(new Map<string, number>())
  const normalizedQuery = requirementQuery.trim().toLocaleLowerCase()
  const unreadRequirementIds = new Set(notifications.filter(item => item.readAt === undefined).map(item => item.requirementId))
  const visibleRequirements = requirements.filter(item => Boolean(item.archivedAt) === showArchived
    && (!normalizedQuery || `${item.id}\n${item.title}\n${item.version.markdown}`.toLocaleLowerCase().includes(normalizedQuery))
    && (requirementFilters.stage === 'all' || item.stage === requirementFilters.stage)
    && (!requirementFilters.participantId || requirementParticipantIds(item).has(requirementFilters.participantId))
    && (!requirementFilters.risk || item.metrics.riskCount > 0)
    && (!requirementFilters.unread || unreadRequirementIds.has(item.id))
    && (!requirementFilters.insights || item.metrics.insightCount > 0))
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const activeRequirementFilterCount = Number(requirementFilters.stage !== 'all') + Number(Boolean(requirementFilters.participantId)) + Number(requirementFilters.risk) + Number(requirementFilters.unread) + Number(requirementFilters.insights)
  const selected = requirements.find(item => item.id === selectedId) ?? visibleRequirements[0]
  const manageTarget = requirements.find(item => item.id === manageTargetId)
  const boundRole = participantBindings.find(item => item.participantId === participant.participantId)?.role
  const currentMyItems = selected ? myItems.filter(item => item.requirementId === selected.id) : []
  const currentReviews = selected?.reviewItems.filter(item => item.commit === selected.currentCommit && !['resolved', 'invalidated', 'non-blocking-verify'].includes(item.status)) ?? []
  const documentReviews = useMemo(() => selected?.reviewItems.filter(item => item.commit === selected.currentCommit && !['resolved', 'invalidated'].includes(item.status)).slice().sort((left, right) => Number(right.status !== 'non-blocking-verify') - Number(left.status !== 'non-blocking-verify') || Number(right.severity === 'blocking') - Number(left.severity === 'blocking') || right.updatedAt - left.updatedAt) ?? [], [selected?.reviewItems, selected?.currentCommit])
  const documentComments = useMemo(() => selected?.comments.filter(item => item.commit === selected.currentCommit && !['invalidated', 'orphaned'].includes(item.status)).slice().sort((left, right) => Number(right.status === 'open') - Number(left.status === 'open') || right.updatedAt - left.updatedAt) ?? [], [selected?.comments, selected?.currentCommit])
  const focusedReviewId = documentFocus?.kind === 'review' ? documentFocus.objectId : undefined
  const focusedCommentId = documentFocus?.kind === 'comment' ? documentFocus.objectId : undefined
  const inlineReviewItem = selected?.reviewItems.find(item => item.id === inlineReview?.itemId)
  const nextInlineReview = selected && inlineReviewItem ? currentReviews.find(item => item.status === 'open' && item.id !== inlineReviewItem.id) : undefined
  const pendingPatches = selected?.patches.filter(item => item.baseCommit === selected.currentCommit && item.status === 'pending') ?? []
  const openDiscussions = selected?.metrics.openCommentCount ?? 0
  const failedChecks = selected?.readiness.filter(item => !item.passed).length ?? 0
  const openReviewCount = selected?.metrics.openReviewCount ?? 0
  const blockingReviewCount = selected?.metrics.riskCount ?? 0
  const activeDecisionCount = selected?.metrics.activeDecisionCount ?? 0
  const invalidatedDecisionCount = selected?.decisions.filter(item => item.status === 'invalidated').length ?? 0
  const runningAiCount = selected?.aiRuns.filter(item => item.commit === selected.currentCommit && ['queued', 'running'].includes(item.status)).length ?? 0
  const workflow = selected ? workflowState(selected, participant.role) : undefined
  const assertiveNotice = /失败|错误|不存在|冲突|损坏|无法|禁止|失效|未登记|阻止/.test(notice)

  const registered = participant.nickname.trim().length >= 2
  const refresh = async (): Promise<void> => { try { const state = await api.state(); setRequirements(state.requirements); setParticipantBindings(state.participants); const binding = state.participants.find(item => item.participantId === participant.participantId); if (binding && binding.role !== participant.role) setParticipant(current => ({ ...current, role: binding.role })); setSelectedId(current => current && state.requirements.some(item => item.id === current) ? current : state.requirements[0]?.id); if (registered) void api.notifications(participant.participantId).then(result => setNotifications(result.items), () => undefined) } catch (error) { setNotice(error instanceof Error ? error.message : String(error)) } }
  useEffect(() => { void refresh(); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))); return api.events(() => { void refresh() }) }, [])
  useEffect(() => {
    let cancelled = false
    if (!selected) { setDraft(''); setSummary(''); return }
    void loadDraft(selected.id, participant.participantId).then(saved => {
      if (cancelled) return
      if (saved && saved.markdown !== selected.version.markdown) { setDraft(saved.markdown); setSummary(saved.summary); setDraftSavedAt(saved.updatedAt); setNotice(saved.baseCommit === selected.currentCommit ? '已恢复本地草稿' : '已恢复旧基线草稿，保存时会进入冲突合并') }
      else { setDraft(selected.version.markdown); setSummary(''); setDraftSavedAt(undefined) }
    })
    return () => { cancelled = true }
  }, [selected?.id, selected?.currentCommit, participant.participantId])
  useEffect(() => { setDocumentFocus(undefined); setDraftSelection(undefined); setCommentText(''); setInlineReview(undefined) }, [selected?.id, selected?.currentCommit])
  useEffect(() => { localStorage.setItem('dsh-spec-collab.participant', JSON.stringify(participant)) }, [participant])
  useEffect(() => { localStorage.setItem('dsh-spec-collab.documents-width', String(documentsWidth)) }, [documentsWidth])
  useEffect(() => { localStorage.setItem('dsh-spec-collab.review-width', String(reviewWidth)) }, [reviewWidth])
  useEffect(() => { if (!registered) { setMyItems([]); return }; void api.myItems(participant).then(setMyItems, error => setNotice(error instanceof Error ? error.message : String(error))) }, [participant.participantId, participant.role, requirements])
  useEffect(() => {
    if (!selected || draft === selected.version.markdown) return
    const timer = window.setTimeout(() => { const updatedAt = Date.now(); void saveDraft({ requirementId: selected.id, participantId: participant.participantId, baseCommit: selected.currentCommit, markdown: draft, summary, updatedAt }).then(() => setDraftSavedAt(updatedAt)) }, 500)
    return () => window.clearTimeout(timer)
  }, [selected?.id, selected?.currentCommit, selected?.version.markdown, participant.participantId, draft, summary])
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent): void => { if (selected && draft !== selected.version.markdown) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [selected?.id, selected?.version.markdown, draft])
  useEffect(() => {
    if (!selected) return
    const timer = window.setTimeout(() => { const scroller = workbenchRef.current?.querySelector<HTMLElement>('.toastui-editor-ww-container'); if (scroller) scroller.scrollTop = scrollPositions.current.get(selected.id) ?? 0 }, 80)
    return () => { window.clearTimeout(timer); const scroller = workbenchRef.current?.querySelector<HTMLElement>('.toastui-editor-ww-container'); if (scroller) scrollPositions.current.set(selected.id, scroller.scrollTop) }
  }, [selected?.id])
  useEffect(() => {
    const shortcut = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLocaleLowerCase() === 'f') { event.preventDefault(); toggleFocusMode() }
      else if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') { event.preventDefault(); if (selected && draft !== selected.version.markdown && summary.trim()) void save() }
    }
    window.addEventListener('keydown', shortcut); return () => window.removeEventListener('keydown', shortcut)
  }, [focusMode, documentsOpen, reviewOpen, selected?.id, selected?.version.markdown, draft, summary])
  useEffect(() => {
    const resolve = (): void => {
      const match = /^#spec-collab\/([^/]+)\/([^/]+)(?:\/([^?]+))?/.exec(location.hash)
      if (!match) return
      const requirementId = decodeURIComponent(match[1]!); const view = match[2]!; const objectId = match[3] ? decodeURIComponent(match[3]) : undefined
      const requirement = requirements.find(item => item.id === requirementId)
      if (!requirement) { if (requirements.length > 0) setNotice('链接指向的需求不存在或已被删除'); return }
      const target = resolveDeepLinkTarget(requirement, view, objectId)
      setSelectedId(requirementId); setDocumentDrawerOpen(false); setReviewOpen(true)
      setPrimaryMode(target.primaryMode); setMobilePane('collab')
      if (target.taskView) setTaskView(target.taskView)
      if (target.recordView) setRecordView(target.recordView)
      if (target.commentObjectId) setDocumentFocus({ kind: 'comment', objectId: target.commentObjectId })
      if (target.reviewObjectId) setReviewOpenRequest({ objectId: target.reviewObjectId, requestId: ++reviewOpenRequestId.current })
      setDeepLinkObjectId(target.focusObjectId)
      if (target.error) setNotice(target.error)
    }
    resolve(); window.addEventListener('hashchange', resolve); return () => window.removeEventListener('hashchange', resolve)
  }, [requirements])
  useEffect(() => {
    if (!deepLinkObjectId) return
    let located = false
    let cleanupTimer = 0
    const timers = [80, 180, 360, 720].map(delay => window.setTimeout(() => {
      if (located) return
      const element = document.getElementById(`spec-object-${deepLinkObjectId}`)
      if (!element) return
      located = true
      element.scrollIntoView({ block: 'center' })
      element.setAttribute('data-dsh-deep-link-focus', '')
      cleanupTimer = window.setTimeout(() => { element.removeAttribute('data-dsh-deep-link-focus'); setDeepLinkObjectId(undefined) }, 2400)
    }, delay))
    return () => { timers.forEach(window.clearTimeout); window.clearTimeout(cleanupTimer) }
  }, [deepLinkObjectId, selected?.id, primaryMode, taskView, recordView])

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

  const performNavigation = (navigation: PendingNavigation): void => {
    if (navigation.kind === 'select') { setSelectedId(navigation.requirementId); setPrimaryMode('tasks'); setDocumentDrawerOpen(false); return }
    if (navigation.kind === 'toggle-archive') { setShowArchived(value => !value); setSelectedId(undefined); setManageMenuId(undefined); return }
    onClose()
  }
  const requestNavigation = (navigation: PendingNavigation): void => {
    if (selected && draft !== selected.version.markdown) { setPendingNavigation(navigation); return }
    performNavigation(navigation)
  }
  const leaveWithDraft = (discard: boolean): void => {
    if (!pendingNavigation) return
    const navigation = pendingNavigation; setPendingNavigation(undefined)
    if (discard && selected) { void deleteDraft(selected.id, participant.participantId); setDraft(selected.version.markdown); setSummary(''); setDraftSavedAt(undefined) }
    performNavigation(navigation)
  }
  const selectRequirement = (id: string): void => requestNavigation({ kind: 'select', requirementId: id })
  const closeWorkbench = (): void => requestNavigation({ kind: 'close' })
  const toggleFocusMode = (): void => {
    if (!focusMode) { previousPaneState.current = { documents: documentsOpen, review: reviewOpen }; setDocumentsOpen(false); setReviewOpen(false); setFocusMode(true) }
    else { setDocumentsOpen(previousPaneState.current.documents); setReviewOpen(previousPaneState.current.review); setFocusMode(false) }
  }

  const create = async (): Promise<void> => {
    const links = createForm.sources.split('\n').map(value => value.trim()).filter(Boolean)
    const ok = await act(actor => ({ kind: 'requirement.create', participant: actor, title: createForm.title, rawRequirement: createForm.rawRequirement, workspaceId: createForm.workspaceId, sources: links.map((label, index) => ({ id: `source-${index + 1}`, sourceType: /^https?:/.test(label) ? 'link' : 'text', label, ...(/^https?:/.test(label) ? { stableId: label } : {}), accessStatus: /^https?:/.test(label) ? 'unverified' : 'available' })) }))
    if (ok) { setCreateOpen(false); setCreateForm({ title: '', rawRequirement: '', sources: '', workspaceId: '' }); setPrimaryMode('tasks'); setTaskView('review') }
  }
  const bindWorkspace = async (): Promise<void> => { if (!selected || !bindWorkspaceId) return; if (await act(actor => ({ kind: 'requirement.bind-workspace', participant: actor, requirementId: selected.id, workspaceId: bindWorkspaceId }))) { setBindWorkspaceOpen(false); setBindWorkspaceId('') } }
  const save = async (): Promise<void> => { if (!selected) return; const ok = await act(actor => ({ kind: 'version.save', participant: actor, requirementId: selected.id, baseCommit: selected.currentCommit, markdown: draft, summary })); if (ok) { await deleteDraft(selected.id, participant.participantId); setDraftSavedAt(undefined); setSummary(''); setNotice('已保存到版本库，并创建新的 Git commit') } }
  const requestReview = async (reviewKind: ReviewKind): Promise<void> => { if (!selected) return; await act(actor => ({ kind: 'review.request', participant: actor, requirementId: selected.id, reviewKind })) }
  const confirm = async (role: ParticipantRole): Promise<void> => { if (!selected) return; await act(actor => ({ kind: 'confirmation.create', participant: actor, requirementId: selected.id, role, scope: 'version' })) }
  const advance = async (): Promise<void> => { if (!selected) return; await act(actor => ({ kind: 'stage.advance', participant: actor, requirementId: selected.id })) }
  const scrollToCollabObject = (objectId: string): void => {
    window.setTimeout(() => document.getElementById(`spec-object-${objectId}`)?.scrollIntoView({ block: 'center' }), 100)
  }
  const focusDocumentAnchor = (focus: DocumentAnchorFocus): void => {
    setDocumentFocus(focus)
    setDocumentFocusRequest(value => value + 1)
  }
  const focusReviewItem = (objectId: string, sourceKey?: string): void => {
    focusDocumentAnchor({ kind: 'review', objectId, ...(sourceKey ? { sourceKey } : {}) })
  }
  const focusCommentItem = (objectId: string): void => {
    focusDocumentAnchor({ kind: 'comment', objectId })
  }
  const openReviewItem = (objectId: string, position?: InlinePopoverPosition, sourceKey?: string, pane: 'spec' | 'collab' = 'spec'): void => {
    setPrimaryMode('tasks')
    setTaskView('review')
    if (pane === 'collab') setReviewOpen(true)
    setMobilePane('spec')
    setDraftSelection(undefined)
    setCommentText('')
    focusReviewItem(objectId, sourceKey)
    setInlineReview({ itemId: objectId, ...(sourceKey ? { sourceKey } : {}), ...(position ? { rect: position.rect, placement: position.placement, ...(position.maxHeight ? { maxHeight: position.maxHeight } : {}) } : {}) })
    if (!position) {
      window.setTimeout(() => {
        const fallbackPosition = inlinePopoverPositionFromRect({ top: 144, bottom: 154, left: Math.max(12, window.innerWidth / 2 - inlineReviewPopoverSize.width / 2) }, inlineReviewPopoverSize)
        setInlineReview(current => current?.itemId === objectId && !current.rect ? { ...current, rect: fallbackPosition.rect, placement: fallbackPosition.placement, ...(fallbackPosition.maxHeight ? { maxHeight: fallbackPosition.maxHeight } : {}) } : current)
      }, 420)
    }
  }
  const updateInlineReviewPosition = (objectId: string, position: InlinePopoverPosition, sourceKey?: string): void => {
    setInlineReview(current => current?.itemId === objectId ? { itemId: objectId, ...(sourceKey ? { sourceKey } : current.sourceKey ? { sourceKey: current.sourceKey } : {}), rect: position.rect, placement: position.placement, ...(position.maxHeight ? { maxHeight: position.maxHeight } : {}) } : current)
  }
  const openCommentItem = (objectId: string, pane: 'spec' | 'collab' = 'collab'): void => {
    setPrimaryMode('discussion')
    setReviewOpen(true)
    setMobilePane(pane)
    focusCommentItem(objectId)
    scrollToCollabObject(objectId)
  }
  const locateReviewItem = (objectId: string, sourceKey?: string): void => {
    openReviewItem(objectId, undefined, sourceKey)
  }
  const locateCommentItem = (objectId: string): void => {
    focusCommentItem(objectId)
    setMobilePane('spec')
  }
  const executeWorkflow = async (command: WorkflowCommand): Promise<void> => {
    if (!selected || command.kind === 'none') return
    if (command.kind === 'open') {
      setPrimaryMode('tasks')
      setTaskView(command.view)
      setMobilePane('collab')
      if (command.view === 'review' && command.objectId) openReviewItem(command.objectId)
      return
    }
    if (command.kind === 'bind-workspace') { setBindWorkspaceOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))); return }
    if (command.kind === 'request-review') { setTaskView('review'); await requestReview(command.reviewKind); return }
    if (command.kind === 'advance' || command.kind === 'confirm' || command.kind === 'generate-ready') { setPendingWorkflow(command); return }
  }
  const confirmWorkflow = async (): Promise<void> => {
    if (!pendingWorkflow || !selected) return
    const command = pendingWorkflow; setPendingWorkflow(undefined)
    if (command.kind === 'advance') { await advance(); return }
    if (command.kind === 'confirm') { await confirm(command.role); return }
    setTaskView('ready')
    await act(actor => ({ kind: 'ready.generate', participant: actor, requirementId: selected.id }))
  }
  const openMyItem = (item: MyActionItem): void => {
    if (item.target.tab === 'review') { openReviewItem(item.target.objectId); return }
    if (item.target.tab === 'discussion') { openCommentItem(item.target.objectId); return }
    else if (item.target.tab === 'decisions') { setPrimaryMode('records'); setRecordView('decisions') }
    else { setPrimaryMode('tasks'); setTaskView(item.target.tab === 'patches' ? 'patches' : item.target.tab === 'ready' ? 'ready' : 'review') }
    setMobilePane('collab')
    scrollToCollabObject(item.target.objectId)
  }
  const openTaskView = (view: TaskView): void => {
    setPrimaryMode('tasks')
    setTaskView(view)
    setReviewOpen(true)
    setMobilePane('collab')
  }
  const openDiscussionView = (): void => {
    setPrimaryMode('discussion')
    setReviewOpen(true)
    setMobilePane('collab')
  }
  const openRecordView = (view: RecordView): void => {
    setPrimaryMode('records')
    setRecordView(view)
    setReviewOpen(true)
    setMobilePane('collab')
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
  const resizePaneWithKeyboard = (side: 'documents' | 'review', event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const current = side === 'documents' ? documentsWidth : reviewWidth; const min = side === 'documents' ? 160 : 320; const max = side === 'documents' ? 360 : 600
    let next: number | undefined
    if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    else if (event.key === 'ArrowLeft') next = current + (side === 'documents' ? -1 : 1) * (event.shiftKey ? 64 : 16)
    else if (event.key === 'ArrowRight') next = current + (side === 'documents' ? 1 : -1) * (event.shiftKey ? 64 : 16)
    if (next === undefined) return
    event.preventDefault(); const value = Math.max(min, Math.min(max, next)); if (side === 'documents') setDocumentsWidth(value); else setReviewWidth(value)
  }
  const renameRequirement = async (): Promise<void> => { if (!manageTarget) return; if (await act(actor => ({ kind: 'requirement.rename', participant: actor, requirementId: manageTarget.id, title: renameTitle }))) { setRenameOpen(false); setManageTargetId(undefined) } }
  const archiveRequirement = async (target: RequirementView): Promise<void> => { const archived = !target.archivedAt; if (await act(actor => ({ kind: 'requirement.archive', participant: actor, requirementId: target.id, archived }))) { setManageMenuId(undefined); setSelectedId(visibleRequirements.find(item => item.id !== target.id)?.id); if (archived) { setUndoArchiveId(target.id); setNotice('需求已归档，Git 历史仍然保留'); window.setTimeout(() => setUndoArchiveId(current => current === target.id ? undefined : current), 8_000) } } }
  const undoArchive = async (): Promise<void> => { if (!undoArchiveId) return; const id = undoArchiveId; if (await act(actor => ({ kind: 'requirement.unarchive', participant: actor, requirementId: id }))) { setUndoArchiveId(undefined); setShowArchived(false); setSelectedId(id); setNotice('已撤销归档') } }
  const deleteRequirement = async (): Promise<void> => { if (!manageTarget) return; if (await act(actor => ({ kind: 'requirement.delete', participant: actor, requirementId: manageTarget.id }))) { setDeleteOpen(false); setManageMenuId(undefined); setManageTargetId(undefined) } }

  const updateDraftSelection = (value?: EditorSelection): void => {
    if (!value) {
      setDraftSelection(current => commentText.trim() ? current : undefined)
      return
    }
    const sameAnchor = draftSelection?.quote === value.quote && draftSelection.prefix === value.prefix && draftSelection.suffix === value.suffix && draftSelection.heading === value.heading
    if (!sameAnchor) setCommentText('')
    setDraftSelection(value)
    setInlineReview(undefined)
    setDocumentFocus(undefined)
  }
  const cancelCommentDraft = (): void => { setDraftSelection(undefined); setCommentText('') }
  const addComment = async (): Promise<void> => {
    if (!selected || !draftSelection || !commentText.trim()) return
    const anchor: CommentAnchor = { quote: draftSelection.quote, prefix: draftSelection.prefix, suffix: draftSelection.suffix, ...(draftSelection.heading ? { heading: draftSelection.heading } : {}) }
    const mentions = participantBindings.filter(item => commentText.includes(`@${item.nickname}`)).map(item => item.participantId)
    const ok = await act(actor => ({ kind: 'comment.create', participant: actor, requirementId: selected.id, commit: selected.currentCommit, anchor, body: commentText.trim(), mentions }))
    if (ok) { setDraftSelection(undefined); setCommentText(''); setNotice('讨论已提交，AI 正在结合正文和工作区上下文分析') }
  }
  const addPageComment = async (): Promise<void> => {
    if (!selected || !pageCommentText.trim()) return
    const mentions = participantBindings.filter(item => pageCommentText.includes(`@${item.nickname}`)).map(item => item.participantId)
    if (await act(actor => ({ kind: 'comment.create', participant: actor, requirementId: selected.id, commit: selected.currentCommit, scope: 'page', body: pageCommentText.trim(), mentions }))) { setPageCommentOpen(false); setPageCommentText(''); setPrimaryMode('discussion'); setReviewOpen(true); setMobilePane('collab'); setNotice('页面总评已提交') }
  }

  return <div ref={workbenchRef} className={`${css.workbench} ${focusMode ? css.focusMode : ''}`}>
    <header className={css.header}>
      <div className={css.titleBlock}>
        <span className={css.productName}>需求共创</span>
        <strong>{selected?.title ?? '把模糊需求变成可交付规范'}</strong>
        {selected && <span>{reviewWorkspaces.find(workspace => workspace.workspaceId === selected.workspaceId)?.title ?? (selected.workspaceId ? '项目已关联' : '未关联项目')} · 版本 {selected.currentCommit.slice(0, 8)}</span>}
      </div>
      {selected && <StageRail stage={selected.stage}/>}
      <div className={css.headerActions}>
        <button className={css.quietButton} aria-label="返回聊天" onClick={closeWorkbench}><span aria-hidden="true">←</span><span className={css.backLabel}>返回聊天</span></button>
        <button className={css.quietButton} aria-pressed={focusMode} title="聚焦正文（⌘⇧F）" onClick={toggleFocusMode}>{focusMode ? '退出聚焦' : '聚焦正文'}</button>
        {registered && <button className={css.myWorkButton} onClick={() => setMyWorkOpen(true)}>我的工作{myItems.length + notifications.filter(item => item.readAt === undefined).length > 0 && <b>{myItems.length + notifications.filter(item => item.readAt === undefined).length}</b>}</button>}
        {registered && <button className={css.notificationButton} aria-label={`通知，${notifications.filter(item => item.readAt === undefined).length} 条未读`} onClick={() => setNotificationsOpen(true)}>通知{notifications.some(item => item.readAt === undefined) && <b>{notifications.filter(item => item.readAt === undefined).length}</b>}</button>}
        <button className={css.identity} onClick={() => setIdentityOpen(true)}>{registered ? `${participant.nickname} · ${participant.role === 'product' ? '产品' : '研发'}` : '登记身份'}</button>
      </div>
    </header>
    <div className={notice ? css.notice : css.noticeHidden} role={assertiveNotice ? 'alert' : 'status'} aria-live={assertiveNotice ? 'assertive' : 'polite'} aria-atomic="true"><span>{notice}</span>{undoArchiveId && <button onClick={() => void undoArchive()}>撤销归档</button>}<button aria-label="关闭" onClick={() => setNotice('')}>×</button></div>
    <div className={css.mobileViewSwitch}><button className={css.mobileDocumentsTrigger} onClick={() => setDocumentDrawerOpen(true)}>需求列表</button><button className={mobilePane === 'spec' ? css.activeMode : ''} onClick={() => setMobilePane('spec')}>需求正文</button><button className={mobilePane === 'collab' ? css.activeMode : ''} onClick={() => setMobilePane('collab')}>协作{currentMyItems.length > 0 ? ` · ${currentMyItems.length}` : ''}</button></div>
    <div className={`${css.grid} ${mobilePane === 'spec' ? css.mobileSpec : css.mobileCollab}`} style={{ '--documents-width': documentsOpen ? `${documentsWidth}px` : '0px', '--documents-handle': documentsOpen ? '6px' : '0px', '--review-width': reviewOpen ? `${reviewWidth}px` : '0px', '--review-handle': reviewOpen ? '6px' : '0px' } as CSSProperties}>
      <aside className={`${css.documents} ${documentsOpen ? '' : css.paneClosed} ${documentDrawerOpen ? css.mobileDocumentsOpen : ''}`} aria-label="需求列表">
        <div className={css.paneHead}><strong>{showArchived ? '已归档' : '需求'}</strong><div className={css.paneActions}><button onClick={() => requestNavigation({ kind: 'toggle-archive' })}>{showArchived ? '返回进行中' : '查看归档'}</button>{!showArchived && <button className={css.createButton} aria-label="新建需求" title="新建需求" onClick={() => { setCreateOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))) }}>＋</button>}<button className={css.mobileDrawerClose} aria-label="关闭需求列表" onClick={() => setDocumentDrawerOpen(false)}>×</button><button className={css.iconButton} aria-label="收起需求栏" title="收起需求栏" onClick={() => setDocumentsOpen(false)}>‹</button></div></div>
        <div className={css.requirementFilters}>
          <label className={css.requirementSearch}>搜索需求<input type="search" value={requirementQuery} onChange={event => setRequirementQuery(event.target.value)} placeholder="标题、编号或正文"/></label>
          <div><label>阶段<select value={requirementFilters.stage} onChange={event => setRequirementFilters(current => ({ ...current, stage: event.target.value as typeof current.stage }))}><option value="all">全部阶段</option>{stageSteps.map(item => <option key={item.stage} value={item.stage}>{item.label}</option>)}</select></label><label>参与者<select value={requirementFilters.participantId} onChange={event => setRequirementFilters(current => ({ ...current, participantId: event.target.value }))}><option value="">全部参与者</option>{participantBindings.map(person => <option key={person.participantId} value={person.participantId}>{person.nickname}</option>)}</select></label></div>
          <div className={css.filterChecks}><label><input type="checkbox" checked={requirementFilters.risk} onChange={event => setRequirementFilters(current => ({ ...current, risk: event.target.checked }))}/>有风险</label><label><input type="checkbox" checked={requirementFilters.unread} onChange={event => setRequirementFilters(current => ({ ...current, unread: event.target.checked }))}/>有未读</label><label><input type="checkbox" checked={requirementFilters.insights} onChange={event => setRequirementFilters(current => ({ ...current, insights: event.target.checked }))}/>有洞察</label></div>
          {(activeRequirementFilterCount > 0 || normalizedQuery) && <div className={css.activeFilters}><span>{activeRequirementFilterCount + Number(Boolean(normalizedQuery))} 个筛选条件生效</span><button onClick={() => { setRequirementQuery(''); setRequirementFilters({ stage: 'all', participantId: '', risk: false, unread: false, insights: false }) }}>清除全部</button></div>}
        </div>
        <nav>{visibleRequirements.map(item => <div className={css.requirementRow} key={item.id}><button className={`${css.documentButton} ${item.id === selected?.id ? css.selectedDoc : ''}`} onClick={() => selectRequirement(item.id)}><span>{item.title}</span><small><i className={`${css.statusDot} ${css[`stage_${item.stage}`]}`}/>{item.archivedAt ? `归档于 ${new Date(item.archivedAt).toLocaleDateString()}` : `${stageLabel(item.stage)}${item.metrics.pendingActionCount > 0 ? ` · ${item.metrics.pendingActionCount} 项待处理` : ''}`}</small></button><button className={css.rowMenuButton} aria-label={`${item.title} 更多操作`} title="更多操作" onClick={() => { selectRequirement(item.id); setManageMenuId(current => current === item.id ? undefined : item.id) }}>…</button>{manageMenuId === item.id && <div className={css.requirementMenu}><button onClick={() => { setManageTargetId(item.id); setRenameTitle(item.title); setRenameOpen(true); setManageMenuId(undefined) }}>重命名</button><button onClick={() => void archiveRequirement(item)}>{item.archivedAt ? '取消归档' : '归档需求'}</button><button className={css.dangerText} onClick={() => { setManageTargetId(item.id); setDeleteOpen(true); setManageMenuId(undefined) }}>删除需求</button></div>}</div>)}</nav>
        {visibleRequirements.length === 0 && <div className={css.emptyList}><strong>{showArchived ? '还没有归档需求' : '从一个真实问题开始'}</strong><p>{showArchived ? '归档后的需求会出现在这里。' : '输入原始需求，AI 会先帮你找出缺口。'}</p>{!showArchived && <button onClick={() => { setCreateOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))) }}>新建需求</button>}</div>}
      </aside>
      <div className={`${css.resizer} ${documentsOpen ? '' : css.resizerHidden}`} role="separator" aria-label="调整需求栏宽度" aria-orientation="vertical" aria-valuemin={160} aria-valuemax={360} aria-valuenow={documentsWidth} tabIndex={documentsOpen ? 0 : -1} onKeyDown={event => resizePaneWithKeyboard('documents', event)} onPointerDown={event => resizePane('documents', event)}/>
      <main className={css.editorPane}>
        <div className={css.toolbar}><div className={css.editorTitle}><button className={css.mobileDocumentsTrigger} aria-label="打开需求列表" onClick={() => setDocumentDrawerOpen(true)}>☰</button>{!documentsOpen && <button className={css.iconButton} aria-label="展开需求栏" title="展开需求栏" onClick={() => setDocumentsOpen(true)}>›</button>}<div><span>正式需求</span><strong>需求正文 · 可编辑</strong></div></div><div><span className={draft !== selected?.version.markdown ? css.unsaved : css.editorMeta}>{draft !== selected?.version.markdown ? `本地草稿${draftSavedAt ? ` · ${relativeTime(draftSavedAt)}` : ''}` : '已保存到版本库'}</span><label className={css.summaryField}>本次改动<input className={css.summaryInput} required value={summary} onChange={event => setSummary(event.target.value)} placeholder="例如：补充退款边界"/></label><button title={!selected ? '请先选择需求' : draft === selected.version.markdown ? '正文没有变化' : !summary.trim() ? '请填写本次改动说明' : '保存到版本库（⌘S）'} className={css.saveButton} disabled={busy || !selected || draft === selected.version.markdown || !summary.trim()} onClick={() => void save()}>保存到版本库</button><button onClick={() => setPageCommentOpen(true)} disabled={!selected}>评论整篇</button>{!reviewOpen && <button className={css.iconButton} aria-label="展开协作面板" title="展开协作面板" onClick={() => setReviewOpen(true)}>‹</button>}</div></div>
        {draftSelection && <InlineCommentComposer selection={draftSelection} text={commentText} setText={setCommentText} busy={busy} cancel={cancelCommentDraft} submit={addComment}/>}
        {inlineReviewItem && inlineReview?.rect && inlineReview.placement && <InlineReviewComposer item={inlineReviewItem} sourceMarkdown={selected?.version.markdown ?? ''} requirementId={selected?.id ?? ''} position={{ rect: inlineReview.rect, placement: inlineReview.placement, ...(inlineReview.maxHeight ? { maxHeight: inlineReview.maxHeight } : {}) }} nextItemId={nextInlineReview?.id} busy={busy} act={act} close={() => setInlineReview(undefined)} locateSource={sourceKey => locateReviewItem(inlineReviewItem.id, sourceKey)} complete={continueToNext => { if (continueToNext && nextInlineReview) openReviewItem(nextInlineReview.id); else setInlineReview(undefined) }}/>}
        {!selected ? <div className={css.emptyMain}><div><span>从问题到共识</span><h2>创建第一份需求</h2><p>写下用户问题和期望结果，AI 会协助补齐范围、规则与验收标准。</p><button className={css.execute} onClick={() => { setCreateOpen(true); void api.reviewWorkspaces().then(setReviewWorkspaces, error => setNotice(error instanceof Error ? error.message : String(error))) }}>新建需求</button></div></div> : <><DocumentCollabBar activeMode={primaryMode} activeTaskView={taskView} activeRecordView={recordView} stats={{ openReviews: openReviewCount, blockingReviews: blockingReviewCount, openDiscussions, pendingPatches: pendingPatches.length, activeDecisions: activeDecisionCount, invalidatedDecisions: invalidatedDecisionCount, runningAi: runningAiCount, dirty: draft !== selected.version.markdown }} onOpenReviews={() => openTaskView('review')} onOpenDiscussion={openDiscussionView} onOpenPatches={() => openTaskView('patches')} onOpenDecisions={() => openRecordView('decisions')}/><div className={css.editorBody}><RichMarkdownEditor key={`${selected.id}:${selected.currentCommit}`} markdown={draft} reviewItems={documentReviews} comments={documentComments} documentFocus={documentFocus} focusRequest={documentFocusRequest} onChange={setDraft} onSelection={updateDraftSelection} onOpenReview={openReviewItem} onReviewLocated={updateInlineReviewPosition} onOpenComment={openCommentItem}/></div></>}
      </main>
      <div className={`${css.resizer} ${reviewOpen ? '' : css.resizerHidden}`} role="separator" aria-label="调整协作栏宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={600} aria-valuenow={reviewWidth} tabIndex={reviewOpen ? 0 : -1} onKeyDown={event => resizePaneWithKeyboard('review', event)} onPointerDown={event => resizePane('review', event)}/>
      <aside className={`${css.review} ${reviewOpen ? '' : css.paneClosed}`} aria-label="需求协作">
        <div className={css.primaryNav}><div role="tablist" aria-label="协作视图" onKeyDown={event => handleTabs(event, ['tasks', 'discussion', 'insights', 'records'], primaryMode, setPrimaryMode)}><button role="tab" tabIndex={primaryMode === 'tasks' ? 0 : -1} aria-selected={primaryMode === 'tasks'} className={primaryMode === 'tasks' ? css.activeMode : ''} onClick={() => setPrimaryMode('tasks')}>下一步{currentMyItems.length > 0 && <span className={css.tabBadge}>{currentMyItems.length}</span>}</button><button role="tab" tabIndex={primaryMode === 'discussion' ? 0 : -1} aria-selected={primaryMode === 'discussion'} className={primaryMode === 'discussion' ? css.activeMode : ''} onClick={() => setPrimaryMode('discussion')}>讨论{openDiscussions > 0 && <span className={css.tabBadge}>{openDiscussions}</span>}</button><button role="tab" tabIndex={primaryMode === 'insights' ? 0 : -1} aria-selected={primaryMode === 'insights'} className={primaryMode === 'insights' ? css.activeMode : ''} onClick={() => setPrimaryMode('insights')}>洞察{selected && selected.metrics.insightCount > 0 && <span className={css.tabBadge}>{selected.metrics.insightCount}</span>}</button><button role="tab" tabIndex={primaryMode === 'records' ? 0 : -1} aria-selected={primaryMode === 'records'} className={primaryMode === 'records' ? css.activeMode : ''} onClick={() => setPrimaryMode('records')}>记录</button></div><button className={`${css.iconButton} ${css.collapseRight}`} aria-label="收起协作面板" title="收起协作面板" onClick={() => setReviewOpen(false)}>›</button></div>
        {selected && primaryMode === 'tasks' && <>
          {workflow && <WorkflowFocus state={workflow} pendingForMe={currentMyItems.length} onExecute={() => void executeWorkflow(workflow.command)}/>}
          {currentMyItems.length > 0 && <TaskQueue items={currentMyItems} open={openMyItem} participants={participantBindings} act={act}/>}
          <div className={css.contextNav} role="tablist" aria-label="待处理内容" onKeyDown={event => handleTabs(event, ['review', 'patches', 'ready'], taskView, setTaskView)}><button role="tab" tabIndex={taskView === 'review' ? 0 : -1} aria-selected={taskView === 'review'} className={taskView === 'review' ? css.activeContext : ''} onClick={() => setTaskView('review')}>问题{currentReviews.length > 0 && <span>{currentReviews.length}</span>}</button><button role="tab" tabIndex={taskView === 'patches' ? 0 : -1} aria-selected={taskView === 'patches'} className={taskView === 'patches' ? css.activeContext : ''} onClick={() => setTaskView('patches')}>AI 建议{pendingPatches.length > 0 && <span>{pendingPatches.length}</span>}</button><button role="tab" tabIndex={taskView === 'ready' ? 0 : -1} aria-selected={taskView === 'ready'} className={taskView === 'ready' ? css.activeContext : ''} onClick={() => setTaskView('ready')}>完成条件{failedChecks > 0 && <span>{failedChecks}</span>}</button></div>
          <div className={css.threadList}>{taskView === 'review' && <ReviewPanel requirement={selected} act={act} api={api} focusedItemId={focusedReviewId} openRequest={reviewOpenRequest} onSelectReview={focusReviewItem} onLocateSource={locateReviewItem} onOpenRequestHandled={requestId => setReviewOpenRequest(current => current?.requestId === requestId ? undefined : current)}/>} {taskView === 'patches' && <PatchPanel requirement={selected} act={act} api={api}/>} {taskView === 'ready' && <ReadyPanel requirement={selected} act={act}/>}</div>
        </>}
        {selected && primaryMode === 'discussion' && <div className={css.threadList}><DiscussionPanel requirement={selected} notifications={notifications} focusedCommentId={focusedCommentId} onSelectComment={focusCommentItem} onLocateComment={locateCommentItem} act={act} api={api}/></div>}
        {selected && primaryMode === 'insights' && <div className={css.threadList}><InsightPanel requirement={selected} api={api} act={act}/></div>}
        {selected && primaryMode === 'records' && <><div className={css.contextNav} role="tablist" aria-label="需求记录" onKeyDown={event => handleTabs(event, ['decisions', 'versions'], recordView, setRecordView)}><button role="tab" tabIndex={recordView === 'decisions' ? 0 : -1} aria-selected={recordView === 'decisions'} className={recordView === 'decisions' ? css.activeContext : ''} onClick={() => setRecordView('decisions')}>关键决策</button><button role="tab" tabIndex={recordView === 'versions' ? 0 : -1} aria-selected={recordView === 'versions'} className={recordView === 'versions' ? css.activeContext : ''} onClick={() => setRecordView('versions')}>版本历史</button></div><div className={css.threadList}>{recordView === 'decisions' && <DecisionPanel requirement={selected} act={act}/>} {recordView === 'versions' && <VersionPanel requirement={selected} api={api} act={act}/>}</div></>}
        {!selected && <div className={css.emptyAside}><strong>等待创建需求</strong><p>创建后，下一步操作会显示在这里。</p></div>}
      </aside>
    </div>
    <footer className={css.footer}><span>AI 可以检查和建议，最终版本始终由人确认</span><span>{selected ? `${stageLabel(selected.stage)} · ${selected.currentCommit.slice(0, 8)} · ${selected.aiRuns.at(-1)?.status === 'running' ? 'AI 分析中' : '版本已记录'}` : '从原始需求开始'}</span></footer>
    {identityOpen && <IdentityDialog value={participant} {...(boundRole === undefined ? {} : { boundRole })} onChange={setParticipant} close={() => setIdentityOpen(false)} save={() => { localStorage.setItem('dsh-spec-collab.participant', JSON.stringify(participant)); setIdentityOpen(false); if (selected) void api.action({ kind: 'participant.register', participant, requirementId: selected.id }).then(() => refresh()) }}/>} {createOpen && <CreateDialog value={createForm} setValue={setCreateForm} workspaces={reviewWorkspaces} close={() => setCreateOpen(false)} submit={() => void create()} busy={busy}/>} {bindWorkspaceOpen && selected && <WorkspaceDialog value={bindWorkspaceId} setValue={setBindWorkspaceId} workspaces={reviewWorkspaces} close={() => { setBindWorkspaceOpen(false); setBindWorkspaceId('') }} submit={() => void bindWorkspace()} busy={busy}/>} {renameOpen && <RenameDialog title={renameTitle} setTitle={setRenameTitle} close={() => { setRenameOpen(false); setManageTargetId(undefined) }} submit={() => void renameRequirement()} busy={busy}/>} {deleteOpen && manageTarget && <DeleteDialog title={manageTarget.title} close={() => { setDeleteOpen(false); setManageTargetId(undefined) }} submit={() => void deleteRequirement()} busy={busy}/>} {saveConflict && <ConflictDialog conflict={saveConflict} value={mergeDraft} setValue={setMergeDraft} close={() => setSaveConflict(undefined)} busy={busy} submit={() => void act(actor => ({ kind: 'version.save', participant: actor, requirementId: saveConflict.requirementId, baseCommit: saveConflict.currentCommit, markdown: mergeDraft, summary })).then(ok => { if (ok) { setDraft(mergeDraft); setSummary(''); setSaveConflict(undefined); setNotice('冲突已合并并创建新的 Git commit') } })}/>} {pageCommentOpen && selected && <PageCommentDialog value={pageCommentText} setValue={setPageCommentText} close={() => setPageCommentOpen(false)} submit={() => void addPageComment()} busy={busy}/>} {notificationsOpen && <NotificationDialog notifications={notifications} close={() => setNotificationsOpen(false)} open={item => { setNotificationsOpen(false); location.hash = item.deepLink }} markRead={item => void act(actor => ({ kind: 'notification.mark-read', participant: actor, requirementId: item.requirementId, notificationIds: [item.id] }))}/>} {myWorkOpen && <MyWorkDialog items={myItems} notifications={notifications} close={() => setMyWorkOpen(false)} openItem={item => { setMyWorkOpen(false); setSelectedId(item.requirementId); window.setTimeout(() => openMyItem(item), 80) }} openNotification={item => { setMyWorkOpen(false); location.hash = item.deepLink }}/>} {pendingNavigation && selected && <AccessibleDialog title="处理未保存草稿" close={() => setPendingNavigation(undefined)} className={css.dialogSurface} dismissOnBackdrop={false}><div className={css.dialogForm}><div className={css.dialogHead}><div><span>本地草稿保护</span><h2>离开前如何处理当前草稿？</h2></div><button aria-label="继续编辑" onClick={() => setPendingNavigation(undefined)}>×</button></div><p>草稿已自动保存在此浏览器，尚未写入 Git。保留后可在下次打开此需求时继续；丢弃后无法恢复。</p><div className={css.stickyActions}><button onClick={() => setPendingNavigation(undefined)}>继续编辑</button><button onClick={() => leaveWithDraft(true)} className={css.dangerText}>丢弃并离开</button><button className={css.execute} onClick={() => leaveWithDraft(false)}>保留草稿并离开</button></div></div></AccessibleDialog>} {pendingWorkflow && selected && <AccessibleDialog title="确认流程操作" close={() => setPendingWorkflow(undefined)} className={css.dialogSurface}><div className={css.dialogForm}><div className={css.dialogHead}><div><span>流程确认</span><h2>{pendingWorkflow.kind === 'advance' ? `进入${selected.stage === 'product-review' ? '产品确认' : '产研确认'}？` : pendingWorkflow.kind === 'confirm' ? `确认当前版本 ${selected.currentCommit.slice(0, 8)}？` : '生成就绪需求？'}</h2></div><button aria-label="关闭" onClick={() => setPendingWorkflow(undefined)}>×</button></div><p>{pendingWorkflow.kind === 'advance' ? '阶段变化会通知协作者，当前版本和所有历史记录保持可追溯。' : pendingWorkflow.kind === 'confirm' ? '确认只绑定当前 commit；正文再次变化后需要重新确认。' : '将以产品和研发共同确认的当前 commit 生成可下载交付包。'}</p><div className={css.stickyActions}><button onClick={() => setPendingWorkflow(undefined)}>取消</button><button className={css.execute} onClick={() => void confirmWorkflow()}>确认执行</button></div></div></AccessibleDialog>}
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
function TaskQueue({ items, open, participants, act }: { items: MyActionItem[]; open: (item: MyActionItem) => void; participants: ParticipantSnapshot[]; act: Act }) {
  const sorted = items.slice().sort((left, right) => Number(right.blocking) - Number(left.blocking) || right.updatedAt - left.updatedAt)
  return <details className={css.taskQueue}><summary><span>与你相关的事项</span><b>{items.length}</b></summary><div>{sorted.map(item => <div className={css.taskRow} key={item.id}><button onClick={() => open(item)}><span>{item.blocking ? '优先' : '普通'}</span><div><strong>{taskTypeLabel[item.type]}</strong><small title={new Date(item.updatedAt).toLocaleString()}>{stageLabel(item.dueStage)}前 · {relativeTime(item.updatedAt)}</small></div><i aria-hidden="true">›</i></button><div className={css.taskAssignment}><label>指派<select aria-label="指派待办" value={item.assigneeParticipantId ?? `role:${item.assigneeRole}`} onChange={event => { const assignee = participants.find(person => person.participantId === event.target.value); const role = event.target.value === 'role:engineering' ? 'engineering' : assignee?.role ?? 'product'; void act(actor => ({ kind: 'action.assign', participant: actor, requirementId: item.requirementId, actionItemId: item.id, assigneeRole: role, ...(assignee ? { assigneeParticipantId: assignee.participantId } : {}), dueStage: item.dueStage })) }}><option value="role:product">产品角色</option><option value="role:engineering">研发角色</option>{participants.map(person => <option key={person.participantId} value={person.participantId}>{person.nickname}</option>)}</select></label><label>截止阶段<select aria-label="待办截止阶段" value={item.dueStage} onChange={event => void act(actor => ({ kind: 'action.assign', participant: actor, requirementId: item.requirementId, actionItemId: item.id, assigneeRole: item.assigneeRole, ...(item.assigneeParticipantId ? { assigneeParticipantId: item.assigneeParticipantId } : {}), dueStage: event.target.value as RequirementStage }))}>{stageSteps.map(stage => <option key={stage.stage} value={stage.stage}>{stage.label}</option>)}</select></label></div></div>)}</div></details>
}

type DocumentCollabStats = { openReviews: number; blockingReviews: number; openDiscussions: number; pendingPatches: number; activeDecisions: number; invalidatedDecisions: number; runningAi: number; dirty: boolean }
function DocumentCollabBar({ activeMode, activeTaskView, activeRecordView, stats, onOpenReviews, onOpenDiscussion, onOpenPatches, onOpenDecisions }: { activeMode: PrimaryMode; activeTaskView: TaskView; activeRecordView: RecordView; stats: DocumentCollabStats; onOpenReviews: () => void; onOpenDiscussion: () => void; onOpenPatches: () => void; onOpenDecisions: () => void }) {
  const reviewActive = activeMode === 'tasks' && activeTaskView === 'review'
  const patchActive = activeMode === 'tasks' && activeTaskView === 'patches'
  const discussionActive = activeMode === 'discussion'
  const decisionsActive = activeMode === 'records' && activeRecordView === 'decisions'
  return <section className={css.editorCollabBar} aria-label="正文协作状态">
    <div className={css.collabBarState}>
      <span className={stats.dirty ? css.collabStateDirty : css.collabStateSaved}>{stats.dirty ? '草稿未保存' : '当前正文'}</span>
      {stats.runningAi > 0 && <span className={css.collabStateRunning}><i className={css.runningDot}/>AI 分析中 · {stats.runningAi}</span>}
    </div>
    <div className={css.collabBarActions}>
      <button type="button" className={`${css.collabMetric} ${reviewActive ? css.collabMetricActive : ''} ${stats.blockingReviews > 0 ? css.collabMetricWarn : ''}`} aria-pressed={reviewActive} onClick={onOpenReviews}><b>{stats.openReviews}</b><span>待回答问题</span>{stats.blockingReviews > 0 && <small>{stats.blockingReviews} 阻塞</small>}</button>
      <button type="button" className={`${css.collabMetric} ${discussionActive ? css.collabMetricActive : ''}`} aria-pressed={discussionActive} onClick={onOpenDiscussion}><b>{stats.openDiscussions}</b><span>打开讨论</span></button>
      <button type="button" className={`${css.collabMetric} ${patchActive ? css.collabMetricActive : ''}`} aria-pressed={patchActive} onClick={onOpenPatches}><b>{stats.pendingPatches}</b><span>AI 建议</span></button>
      <button type="button" className={`${css.collabMetric} ${decisionsActive ? css.collabMetricActive : ''} ${stats.invalidatedDecisions > 0 ? css.collabMetricWarn : ''}`} aria-pressed={decisionsActive} onClick={onOpenDecisions}><b>{stats.activeDecisions}</b><span>生效决策</span>{stats.invalidatedDecisions > 0 && <small>{stats.invalidatedDecisions} 作废</small>}</button>
    </div>
  </section>
}

export function InlineCommentComposer({ selection, text, setText, busy, cancel, submit }: { selection: EditorSelection; text: string; setText: (value: string) => void; busy: boolean; cancel: () => void; submit: () => Promise<void> }) {
  const quote = selection.quote.replace(/\s+/g, ' ').trim()
  const excerpt = quote.length > 72 ? `${quote.slice(0, 72)}…` : quote
  const canSubmit = !busy && Boolean(text.trim())
  return <form className={`${css.selectionPrompt} ${selection.placement === 'above' ? css.selectionPromptAbove : css.selectionPromptBelow}`} role="dialog" aria-label="围绕选中正文发起讨论" style={{ top: selection.rect.top, left: selection.rect.left }} onSubmit={event => { event.preventDefault(); if (canSubmit) void submit() }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); cancel() }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) { event.preventDefault(); void submit() }
  }}>
    <div className={css.selectionPromptHead}>
      <div><b>{selection.heading?.trim() || '正文片段'}</b><small>{excerpt}</small></div>
      <button type="button" className={css.selectionPromptClose} aria-label="取消文字选择" title="取消" onClick={cancel}>×</button>
    </div>
    <textarea required autoFocus aria-label="讨论内容" value={text} onChange={event => setText(event.target.value)} placeholder="直接写下问题或补充意见"/>
    <div className={css.selectionPromptActions}>
      <small>提交后 AI 会结合正文和工作区上下文分析。</small>
      <div className={css.selectionPromptButtons}>
        <button type="button" className={css.selectionPromptCancel} onClick={cancel}>取消</button>
        <button type="submit" className={css.selectionPromptSubmit} disabled={!canSubmit}>{busy ? '提交中' : '提交'}</button>
      </div>
    </div>
  </form>
}

type DocumentMarker = { kind: 'review' | 'comment'; objectId: string; label: string; title: string; top: number; left: number; highlightTop: number; highlightLeft: number; highlightWidth: number; highlightHeight: number; blocking: boolean; selected: boolean }
function RichMarkdownEditor({ markdown, reviewItems, comments, documentFocus, focusRequest, onChange, onSelection, onOpenReview, onReviewLocated, onOpenComment }: { markdown: string; reviewItems: ReviewItemView[]; comments: CommentThread[]; documentFocus?: DocumentAnchorFocus | undefined; focusRequest: number; onChange: (markdown: string) => void; onSelection: (selection?: EditorSelection) => void; onOpenReview: (itemId: string, position?: InlinePopoverPosition, sourceKey?: string) => void; onReviewLocated: (itemId: string, position: InlinePopoverPosition, sourceKey?: string) => void; onOpenComment: (commentId: string) => void }) {
  const shell = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const instance = useRef<ToastEditor>()
  const interacted = useRef(false)
  const syncing = useRef(false)
  const onChangeRef = useRef(onChange)
  const onSelectionRef = useRef(onSelection)
  const onOpenReviewRef = useRef(onOpenReview)
  const onReviewLocatedRef = useRef(onReviewLocated)
  const onOpenCommentRef = useRef(onOpenComment)
  const reviewItemsRef = useRef(reviewItems)
  const commentsRef = useRef(comments)
  const documentFocusRef = useRef(documentFocus)
  const syncAnnotationsRef = useRef<() => void>(() => {})
  const [markers, setMarkers] = useState<DocumentMarker[]>([])
  onChangeRef.current = onChange
  onSelectionRef.current = onSelection
  onOpenReviewRef.current = onOpenReview
  onReviewLocatedRef.current = onReviewLocated
  onOpenCommentRef.current = onOpenComment
  reviewItemsRef.current = reviewItems
  commentsRef.current = comments
  documentFocusRef.current = documentFocus
  useEffect(() => {
    if (!host.current || !shell.current) return
    const editor = new ToastEditor({ el: host.current, initialValue: markdown, initialEditType: 'wysiwyg', hideModeSwitch: true, toolbarItems: [], plugins: [markdownShortcutsPlugin], height: '100%', language: 'zh-CN', usageStatistics: false, autofocus: false })
    const markInteraction = (): void => { interacted.current = true }
    let frame = 0
    const syncAnnotations = (): void => {
      const editorRoot = visibleEditorContents(host.current)
      const shellElement = shell.current
      if (!editorRoot || !shellElement) return
      const reviewSourceClass = css.reviewSourceSelected!
      const commentSourceClass = css.commentSourceSelected!
      editorRoot.querySelectorAll<HTMLElement>('[data-annotation-kind]').forEach(element => { element.removeAttribute('data-annotation-kind'); element.removeAttribute('data-annotation-selected') })
      editorRoot.querySelectorAll<HTMLElement>(`.${reviewSourceClass}, .${commentSourceClass}`).forEach(element => element.classList.remove(reviewSourceClass, commentSourceClass))
      const shellRect = shellElement.getBoundingClientRect()
      const slots = new Map<HTMLElement, number>()
      const nextMarkers: DocumentMarker[] = []
      const focus = documentFocusRef.current
      const addMarker = (target: HTMLElement, marker: Omit<DocumentMarker, 'top' | 'left' | 'highlightTop' | 'highlightLeft' | 'highlightWidth' | 'highlightHeight'>): void => {
        const rect = target.getBoundingClientRect()
        if (rect.bottom < shellRect.top || rect.top > shellRect.bottom) return
        const slot = slots.get(target) ?? 0
        slots.set(target, slot + 1)
        const highlightLeft = Math.max(0, rect.left - shellRect.left - 5)
        const highlightTop = rect.top - shellRect.top - 3
        nextMarkers.push({
          ...marker,
          top: rect.top - shellRect.top + Math.min(8, rect.height / 2) + slot * 25,
          left: Math.max(4, rect.left - shellRect.left - 30),
          highlightTop,
          highlightLeft,
          highlightWidth: Math.max(28, Math.min(shellRect.width - highlightLeft - 8, rect.width + 10)),
          highlightHeight: Math.max(26, Math.min(shellRect.height - Math.max(0, highlightTop) - 4, rect.height + 6)),
        })
      }
      reviewItemsRef.current.forEach(item => {
        const selected = focus?.kind === 'review' && focus.objectId === item.id
        const targets = reviewTargetElements(editorRoot, item, selected ? focus.sourceKey : undefined)
        const target = targets[0]
        if (!target) return
        target.dataset.annotationKind = target.dataset.annotationKind === 'comment' ? 'mixed' : 'review'
        if (selected) target.classList.add(reviewSourceClass)
        if (selected) target.dataset.annotationSelected = 'review'
        addMarker(target, { kind: 'review', objectId: item.id, label: item.severity === 'blocking' ? '!' : '?', title: item.question.trim() || item.statement.trim(), blocking: item.severity === 'blocking', selected })
      })
      commentsRef.current.forEach(comment => {
        const selected = focus?.kind === 'comment' && focus.objectId === comment.id
        const targets = commentTargetElements(editorRoot, comment.anchor)
        const target = targets[0]
        if (!target) return
        target.dataset.annotationKind = target.dataset.annotationKind === 'review' ? 'mixed' : 'comment'
        if (selected) target.classList.add(commentSourceClass)
        if (selected) target.dataset.annotationSelected = 'comment'
        addMarker(target, { kind: 'comment', objectId: comment.id, label: '评', title: comment.body.trim() || comment.anchor?.quote.trim() || '整篇需求评论', blocking: false, selected })
      })
      setMarkers(nextMarkers)
    }
    const scheduleAnnotations = (): void => { cancelAnimationFrame(frame); frame = requestAnimationFrame(syncAnnotations) }
    syncAnnotationsRef.current = scheduleAnnotations
    const change = (): void => { if (interacted.current && !syncing.current) onChangeRef.current(editor.getMarkdown()); scheduleAnnotations() }
    const selection = (): void => {
      const quote = editor.getSelectedText().trim()
      const domSelection = window.getSelection()
      if (!quote || !domSelection || domSelection.rangeCount === 0 || domSelection.isCollapsed) { onSelectionRef.current(undefined); return }
      const range = domSelection.getRangeAt(0)
      const start = range.startContainer instanceof HTMLElement ? range.startContainer : range.startContainer.parentElement
      const block = start?.closest<HTMLElement>(reviewBlockSelector)
      const blockText = block?.textContent ?? quote
      const quoteIndex = blockText.indexOf(quote)
      const headings = Array.from(visibleEditorContents(host.current)?.querySelectorAll<HTMLElement>('h1, h2, h3, h4') ?? [])
      const anchorNode = block ?? start
      const heading = anchorNode ? headings.filter(candidate => Boolean(candidate.compareDocumentPosition(anchorNode) & Node.DOCUMENT_POSITION_FOLLOWING)).at(-1)?.textContent?.trim() : undefined
      const rect = range.getBoundingClientRect()
      const position = inlinePopoverPositionFromRect(rect, { width: 360, height: 230 })
      onSelectionRef.current({ quote, prefix: quoteIndex < 0 ? '' : blockText.slice(Math.max(0, quoteIndex - 80), quoteIndex), suffix: quoteIndex < 0 ? '' : blockText.slice(quoteIndex + quote.length, quoteIndex + quote.length + 80), ...(heading ? { heading } : {}), ...position })
    }
    editor.on('change', change)
    host.current.addEventListener('beforeinput', markInteraction)
    host.current.addEventListener('paste', markInteraction)
    host.current.addEventListener('drop', markInteraction)
    host.current.addEventListener('pointerdown', markInteraction)
    host.current.addEventListener('mouseup', selection)
    host.current.addEventListener('keyup', selection)
    const scroll = (): void => { onSelectionRef.current(undefined); scheduleAnnotations() }
    const scrollTargets = new Set<HTMLElement>()
    const bindScrollTarget = (element: HTMLElement): void => {
      if (scrollTargets.has(element)) return
      scrollTargets.add(element)
      element.addEventListener('scroll', scroll, { passive: true })
    }
    const bindAnnotationScrollTargets = (): void => annotationScrollTargets(host.current).forEach(bindScrollTarget)
    bindAnnotationScrollTargets()
    window.addEventListener('resize', scheduleAnnotations)
    const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scheduleAnnotations)
    resizeObserver?.observe(shell.current)
    const mutationObserver = new MutationObserver(() => { bindAnnotationScrollTargets(); scheduleAnnotations() })
    mutationObserver.observe(host.current, { childList: true, subtree: true })
    instance.current = editor
    scheduleAnnotations()
    return () => { cancelAnimationFrame(frame); mutationObserver.disconnect(); resizeObserver?.disconnect(); window.removeEventListener('resize', scheduleAnnotations); scrollTargets.forEach(element => element.removeEventListener('scroll', scroll)); host.current?.removeEventListener('beforeinput', markInteraction); host.current?.removeEventListener('paste', markInteraction); host.current?.removeEventListener('drop', markInteraction); host.current?.removeEventListener('pointerdown', markInteraction); host.current?.removeEventListener('mouseup', selection); host.current?.removeEventListener('keyup', selection); editor.destroy() }
  }, [])
  useEffect(() => {
    const editor = instance.current
    if (!editor || editor.getMarkdown() === markdown) return
    syncing.current = true
    editor.setMarkdown(markdown)
    syncing.current = false
    syncAnnotationsRef.current()
  }, [markdown])
  useEffect(() => {
    syncAnnotationsRef.current()
    if (!documentFocus || focusRequest === 0) return
    const findTarget = (): HTMLElement | undefined => {
      const editorRoot = visibleEditorContents(host.current)
      if (!editorRoot) return undefined
      if (documentFocus.kind === 'review') {
        const item = reviewItems.find(candidate => candidate.id === documentFocus.objectId)
        return item ? reviewTargetElements(editorRoot, item, documentFocus.sourceKey)[0] : undefined
      }
      const comment = comments.find(candidate => candidate.id === documentFocus.objectId)
      return comment ? commentTargetElements(editorRoot, comment.anchor)[0] : undefined
    }
    const findReviewMarker = (): HTMLElement | undefined => Array.from(shell.current?.querySelectorAll<HTMLElement>('[data-review-object-id]') ?? []).find(element => element.dataset.reviewObjectId === documentFocus.objectId)
    const target = findTarget()
    target?.scrollIntoView(documentFocus.kind === 'review' ? { block: 'center' } : { behavior: 'smooth', block: 'center' })
    const updateLocatedReview = (): void => {
      syncAnnotationsRef.current()
      if (documentFocus.kind !== 'review') return
      const anchor = findReviewMarker() ?? findTarget()
      if (anchor) onReviewLocatedRef.current(documentFocus.objectId, inlinePopoverPositionFromRect(anchor.getBoundingClientRect(), inlineReviewPopoverSize), documentFocus.sourceKey)
    }
    if (documentFocus.kind === 'review') window.requestAnimationFrame(() => window.requestAnimationFrame(updateLocatedReview))
    else window.setTimeout(updateLocatedReview, 220)
  }, [reviewItems, comments, documentFocus, focusRequest])
  return <div className={css.richEditorShell} ref={shell}><div className={css.richEditor} ref={host}/><div className={css.reviewAnchorLayer} aria-label="正文协作锚点">{markers.map(marker => <span key={`highlight-${marker.kind}-${marker.objectId}`} className={`${css.documentAnchorHighlight} ${marker.kind === 'comment' ? css.documentCommentHighlight : css.documentReviewHighlight} ${marker.blocking ? css.documentReviewHighlightBlocking : ''} ${marker.selected ? css.documentAnchorHighlightSelected : ''}`} style={{ top: marker.highlightTop, left: marker.highlightLeft, width: marker.highlightWidth, height: marker.highlightHeight }} aria-hidden="true"/>)}
    {markers.map(marker => <button key={`${marker.kind}-${marker.objectId}`} type="button" className={`${marker.kind === 'comment' ? css.documentCommentAnchor : css.documentReviewAnchor} ${marker.blocking ? css.documentReviewAnchorBlocking : ''} ${marker.selected ? css.documentAnchorSelected : ''}`} style={{ top: marker.top, left: marker.left }} title={marker.title} aria-label={marker.kind === 'comment' ? `打开评论：${marker.title}` : `打开问题：${marker.title}`} data-review-object-id={marker.kind === 'review' ? marker.objectId : undefined} data-comment-object-id={marker.kind === 'comment' ? marker.objectId : undefined} onMouseDown={event => event.preventDefault()} onClick={event => marker.kind === 'comment' ? onOpenCommentRef.current(marker.objectId) : onOpenReviewRef.current(marker.objectId, inlinePopoverPositionFromRect(event.currentTarget.getBoundingClientRect(), inlineReviewPopoverSize))}>{marker.label}</button>)}</div></div>
}

type Act = (factory: (actor: ParticipantSnapshot) => CollaborationAction) => Promise<boolean>
const reviewKindLabel: Record<ReviewKind, string> = { 'product-first': '需求缺口检查', 'product-second': '正文整理检查', 'engineering-precheck': '研发可行性检查', 'change-review': '改动影响检查' }
const reviewTypeLabel: Record<ReviewItemType, string> = { goal: '目标', evidence: '依据', 'history-conflict': '历史冲突', 'current-implementation': '当前实现', scope: '范围', semantics: '规则语义', completeness: '完整性', acceptance: '验收', risk: '风险' }
const statusLabel: Record<string, string> = { queued: '排队中', running: '分析中', completed: '已完成', failed: '失败', open: '待处理', answered: '已回答待整理', 'joint-review': '待产研共议', 'non-blocking-verify': '保留待核对', resolved: '已解决', invalidated: '已失效', pending: '待确认', accepted: '已接受', rejected: '未采用', stale: '已过期', blocking: '阻塞', major: '重要', minor: '一般' }
const evidenceStatusLabel: Record<string, string> = { FACT: '已有依据', INFERENCE: '根据现有信息推断', ASSUMPTION: '暂定规则', TO_VERIFY: '待核对' }
const commentResolutionLabel: Record<CommentResolution, string> = { 'written-back': '已回写正文', decision: '形成决策', rejected: '不采纳', 'open-question': '转开放问题' }
function MarkdownBody({ text, className = '' }: { text: string; className?: string | undefined }) { return <div className={`${css.markdownBody} ${className}`} dangerouslySetInnerHTML={{ __html: md.render(text) }}/> }
type ReviewItemView = RequirementView['reviewItems'][number]
export function ReviewPanel({ requirement, act, api, focusedItemId, openRequest, onSelectReview, onLocateSource, onOpenRequestHandled }: { requirement: RequirementView; act: Act; api: SpecApi; focusedItemId?: string | undefined; openRequest?: ReviewOpenRequest | undefined; onSelectReview?: (itemId: string) => void; onLocateSource?: (itemId: string, sourceKey?: string) => void; onOpenRequestHandled?: (requestId: number) => void }) {
  const [selectedItemId, setSelectedItemId] = useState<string>()
  const current = requirement.reviewItems.filter(item => item.commit === requirement.currentCommit).slice().sort((left, right) => Number(right.severity === 'blocking') - Number(left.severity === 'blocking') || right.updatedAt - left.updatedAt)
  const historical = requirement.reviewItems.filter(item => item.commit !== requirement.currentCommit)
  const active = current.filter(item => !['resolved', 'invalidated', 'non-blocking-verify'].includes(item.status))
  const deferred = current.filter(item => item.status === 'non-blocking-verify')
  const unansweredCount = active.filter(item => item.status === 'open').length
  const answeredCount = active.filter(item => item.status === 'answered').length
  const processedCount = current.filter(item => item.status !== 'open').length
  const currentRuns = requirement.aiRuns.filter(run => run.commit === requirement.currentCommit)
  const currentStageSessionId = requirement.aiConversations?.find(item => item.stage === requirement.stage && item.stageCycle === requirement.stageCycle)?.sessionId
  const openItem = (itemId: string): void => {
    setSelectedItemId(itemId)
    const sourceKey = [...current, ...historical].find(item => item.id === itemId)?.sourceAnchors?.[0] ? `quote-0` : undefined
    onSelectReview?.(itemId)
    onLocateSource?.(itemId, sourceKey)
  }
  useEffect(() => {
    if (!openRequest) return
    if ([...current, ...historical].some(item => item.id === openRequest.objectId)) openItem(openRequest.objectId)
    onOpenRequestHandled?.(openRequest.requestId)
  }, [openRequest?.requestId])
  return <>
    <div className={css.panelSummary}><div><strong>问题检查清单</strong><span>{unansweredCount > 0 ? `${unansweredCount} 项待回答 · ${active.filter(item => item.severity === 'blocking' && item.status === 'open').length} 项阻塞下一阶段` : answeredCount > 0 ? '回答已齐，下一步让 AI 回读' : active.length > 0 ? `${active.length} 项等待后续处理` : '当前版本已全部处理'}</span></div>{current.length > 0 && <div className={css.checklistMeter}><small>{processedCount}/{current.length}</small><progress aria-label={`已回答或处理 ${processedCount} 项，共 ${current.length} 项`} value={processedCount} max={current.length}/></div>}</div>
    {currentRuns.length > 0 && <details className={css.runHistory}><summary>AI 运行中心（{currentRuns.length}）{currentStageSessionId ? ' · 当前阶段复用 1 个会话' : ''}</summary>{currentRuns.slice().reverse().map(run => { const endedAt = ['completed', 'failed'].includes(run.status) ? run.updatedAt : Date.now(); const sharedSession = Boolean(run.sessionId && run.sessionId === currentStageSessionId); const step = run.status === 'queued' ? '等待可用执行槽' : run.status === 'running' ? sharedSession ? '复用当前阶段上下文并分析增量' : '读取工作区并核对当前正文' : run.status === 'completed' ? '检查结果已写入问题清单' : '运行中断，输入和历史结果已保留'; return <div className={css.run} key={run.id}><div><strong>{reviewKindLabel[run.kind]}</strong><span>{statusLabel[run.status] ?? run.status}</span></div><dl><div><dt>当前步骤</dt><dd>{step}</dd></div><div><dt>开始</dt><dd title={new Date(run.createdAt).toLocaleString()}>{relativeTime(run.createdAt)}</dd></div><div><dt>耗时</dt><dd>{durationText(endedAt - run.createdAt)}</dd></div></dl>{run.maturitySummary && <MarkdownBody text={run.maturitySummary}/>} {run.error && <><p className={css.chatError}>{friendlyActionError(run.error)}</p><button className={css.panelAction} onClick={() => void act(actor => ({ kind: 'review.request', participant: actor, requirementId: requirement.id, reviewKind: run.kind }))}>重试本次检查</button></>}{run.sessionId && <AiConversation api={api} requirementId={requirement.id} sessionId={run.sessionId}/>}</div>})}</details>}
    {current.length === 0 && <div className={css.emptyPanel}><strong>等待 AI 完成检查</strong><p>检查结果会按优先级出现在这里。</p></div>}
    {active.length > 0 && <ReviewChecklist items={active} selectedItemId={focusedItemId ?? selectedItemId} open={openItem}/>}
    {deferred.length > 0 && <details className={css.historyGroup}><summary>保留待核对 · {deferred.length}</summary><ReviewChecklist items={deferred} selectedItemId={focusedItemId ?? selectedItemId} open={openItem}/></details>}
    {historical.length > 0 && <details className={css.historyGroup}><summary>历史问题 · {historical.length}</summary><ReviewChecklist items={historical.slice().reverse()} selectedItemId={focusedItemId ?? selectedItemId} open={openItem}/></details>}
  </>
}
function ReviewChecklist({ items, selectedItemId, open }: { items: ReviewItemView[]; selectedItemId?: string | undefined; open: (itemId: string) => void }) {
  return <div className={css.reviewChecklist}>{items.map(item => <ReviewChecklistRow key={item.id} item={item} selected={selectedItemId === item.id} open={open}/>)}</div>
}
function ReviewChecklistRow({ item, selected, open }: { item: ReviewItemView; selected: boolean; open: (itemId: string) => void }) {
  const settled = ['resolved', 'invalidated', 'non-blocking-verify'].includes(item.status)
  const answered = item.status !== 'open'
  const question = item.question.trim() || item.statement.trim()
  return <button id={`spec-object-${item.id}`} className={`${css.reviewChecklistRow} ${item.severity === 'blocking' && !answered ? css.reviewChecklistBlocking : ''} ${answered && !settled ? css.reviewChecklistAnswered : ''} ${settled ? css.reviewChecklistSettled : ''} ${selected ? css.reviewChecklistSelected : ''}`} title={question} aria-haspopup="dialog" aria-current={selected ? 'true' : undefined} onClick={() => open(item.id)}>
    <span className={css.reviewCheckBox} aria-hidden="true">{answered ? '✓' : ''}</span>
    <span className={css.reviewCheckCopy}><span className={css.reviewCheckMeta}><b>{reviewTypeLabel[item.type]}</b><small>{item.evidence.length > 0 ? `${item.evidence.length} 条依据` : evidenceStatusLabel[item.epistemicStatus]}</small></span><strong>{question}</strong></span>
    <span className={css.reviewCheckStatus}>{statusLabel[item.status] ?? item.status}</span><span className={css.reviewCheckArrow} aria-hidden="true">›</span>
  </button>
}
const dispositionLabel = { context: '补充明确结论', evidence: '补充依据或案例', accept: '直接采用现有结论', 'accept-modified': '采用，并让 AI 修改正文', reject: '不采用，并记录原因', 'to-verify': '暂时无法确认，保留待核对', 'joint-review': '交给产品和研发共同确认' } as const
const dispositionGuidance: Record<keyof typeof dispositionLabel, string> = {
  context: '保存你的最终判断，AI 回读时会据此检查正文。',
  evidence: '补充数据、案例或来源，并写清它支持什么结论。',
  accept: '现有结论已经准确，不需要 AI 改写正文。',
  'accept-modified': '保存结论后，下一步由 AI 回读并生成正文修改建议。',
  reject: '说明不采用的原因，避免 AI 再次提出同一方向。',
  'to-verify': '这项不会继续阻塞当前阶段，但会保留在待核对清单。',
  'joint-review': '把问题留到产研共审，由产品和研发共同决定。',
}
export function InlineReviewComposer({ item, sourceMarkdown, requirementId, position, nextItemId, busy, act, close, locateSource, complete }: { item: ReviewItemView; sourceMarkdown: string; requirementId: string; position: InlinePopoverPosition; nextItemId?: string | undefined; busy: boolean; act: Act; close: () => void; locateSource: (sourceKey?: string) => void; complete: (continueToNext: boolean) => void }) {
  const [disposition, setDisposition] = useState<keyof typeof dispositionLabel>('context')
  const [body, setBody] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const recommendations = item.recommendedOptions?.map(option => option.trim()).filter(Boolean).slice(0, 5) ?? []
  const sourceSnippets = reviewSourceSnippets(sourceMarkdown, item)
  const primarySource = sourceSnippets[0]
  const canRespond = !item.response && item.status === 'open'
  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return }
    }
    window.addEventListener('keydown', keydown)
    window.setTimeout(() => formRef.current?.querySelector<HTMLElement>('textarea')?.focus(), 0)
    return () => window.removeEventListener('keydown', keydown)
  }, [close])
  const choose = (option: string): void => { setBody(option); setDisposition('accept-modified') }
  const submit = async (continueToNext: boolean): Promise<void> => { const answer = body.trim() || (disposition === 'joint-review' ? '转产研共同决策' : ''); if (answer && await act(actor => ({ kind: 'review.respond', participant: actor, requirementId, reviewItemId: item.id, disposition, body: answer }))) complete(continueToNext) }
  const canSubmit = !busy && (Boolean(body.trim()) || disposition === 'joint-review')
  return <form ref={formRef} className={`${css.inlineReviewPrompt} ${position.placement === 'above' ? css.selectionPromptAbove : css.selectionPromptBelow}`} role="dialog" aria-label="回答待处理问题" style={{ top: position.rect.top, left: position.rect.left, maxHeight: position.maxHeight }} onSubmit={event => { event.preventDefault(); if (canSubmit) void submit(Boolean(nextItemId)) }} onKeyDown={event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSubmit) { event.preventDefault(); void submit(Boolean(nextItemId)) }
  }}>
    <header className={css.inlineReviewHead}>
      <div><div className={css.decisionTags}><b>{statusLabel[item.severity] ?? item.severity}</b><span>{reviewTypeLabel[item.type]}</span><span>{evidenceStatusLabel[item.epistemicStatus] ?? item.epistemicStatus}</span></div><strong>{item.statement}</strong></div>
      <span className={css.inlineReviewHeadActions}><button type="button" onClick={() => void navigator.clipboard.writeText(`${location.origin}${location.pathname}#spec-collab/${requirementId}/tasks/${item.id}`)}>复制链接</button><button type="button" aria-label="关闭问题窗口" title="关闭" onClick={close}>×</button></span>
    </header>
    <section className={css.inlineReviewQuestion}><span>待回答</span><MarkdownBody text={item.question}/></section>
    {primarySource && <button type="button" className={css.inlineReviewSource} onClick={() => locateSource(primarySource.targetKey)}><span>{primarySource.label}{primarySource.line ? ` · 第 ${primarySource.line} 行` : ''}</span><q>{primarySource.markdown.replace(/\s+/g, ' ').slice(0, 96)}{primarySource.markdown.length > 96 ? '…' : ''}</q></button>}
    {item.response ? <div className={css.decisionResponse}><span>已回复</span><strong>{item.response.participant.nickname}</strong><small>{dispositionLabel[item.response.disposition]}</small><MarkdownBody text={item.response.body}/></div> : canRespond ? <>
      {recommendations.length > 0 && <fieldset className={`${css.decisionOptions} ${css.inlineDecisionOptions}`}><legend>可采用的回答</legend>{recommendations.map((option, index) => <button type="button" key={option} className={body === option ? css.selectedDecisionOption : ''} aria-pressed={body === option} onClick={() => choose(option)}><span>{option}</span><b>{body === option ? '已选择' : String(index + 1).padStart(2, '0')}</b></button>)}</fieldset>}
      <div className={`${css.decisionForm} ${css.inlineDecisionForm}`}><label>保存后如何处理<select required value={disposition} onChange={event => setDisposition(event.target.value as keyof typeof dispositionLabel)}>{Object.entries(dispositionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><p className={css.decisionModeHint}>{dispositionGuidance[disposition]}</p><label>最终结论<textarea required value={body} onChange={event => setBody(event.target.value)} placeholder={disposition === 'evidence' ? '粘贴数据、案例或来源链接，并说明它支持什么结论' : disposition === 'joint-review' ? '可选：补充希望产品和研发重点讨论的边界' : '写清最终判断、适用范围、例外情况和取舍理由'}/></label></div>
      <details className={css.inlineReviewDetails}><summary>影响与依据</summary><section><h3>为什么需要明确</h3><MarkdownBody text={item.impact}/></section><section><h3>依据与来源 · {item.evidence.length}</h3>{item.evidence.length === 0 ? <p className={css.decisionEmpty}>当前没有可核对的资料，可以按业务判断回答，或选择保留待核对。</p> : <div className={css.decisionEvidenceList}>{item.evidence.map((evidence, index) => <div className={css.decisionEvidence} key={`${evidence.source}-${index}`}><code>{evidence.source}{evidence.version ? `@${evidence.version}` : ''}</code><MarkdownBody text={evidence.statement}/></div>)}</div>}</section>{(item.affectedSections.length > 0 || item.affectedAcceptanceIds.length > 0) && <section><h3>可能影响</h3><p>{[...item.affectedSections, ...item.affectedAcceptanceIds].join(' · ')}</p></section>}</details>
      <div className={css.inlineReviewActions}><button type="button" onClick={close}>取消</button><div>{nextItemId && <button type="button" disabled={!canSubmit} onClick={() => void submit(false)}>保存并留在此处</button>}<button type="submit" className={css.execute} disabled={!canSubmit}>{busy ? '保存中' : nextItemId ? '保存并下一题' : '保存回答'}</button></div></div>
    </> : <div className={css.decisionResponse}><span>{statusLabel[item.status] ?? item.status}</span><strong>这条记录当前不可回复</strong><p>你仍可以查看完整问题、影响和来源。</p></div>}
  </form>
}
export function DiscussionPanel({ requirement, notifications, focusedCommentId, onSelectComment, onLocateComment, act, api }: { requirement: RequirementView; notifications?: Notification[] | undefined; selection?: { quote: string } | undefined; text?: string; setText?: (value: string) => void; cancel?: () => void; submit?: () => Promise<void>; focusedCommentId?: string | undefined; onSelectComment?: (commentId: string) => void; onLocateComment?: (commentId: string) => void; act: Act; api: SpecApi }) {
  const [filter, setFilter] = useState<'open' | 'resolved' | 'unread' | 'all'>('open'); const [sort, setSort] = useState<'document' | 'recent'>('document'); const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({}); const [directory, setDirectory] = useState<ParticipantSnapshot[]>([])
  useEffect(() => { const request = (api as Partial<SpecApi>).directory?.(); if (request) void request.then(setDirectory, () => undefined) }, [requirement.id])
  const locateComment = (commentId: string): void => {
    onSelectComment?.(commentId)
    onLocateComment?.(commentId)
  }
  const comments = requirement.comments.slice().sort((left, right) => sort === 'recent' ? right.updatedAt - left.updatedAt : Number(right.status === 'open') - Number(left.status === 'open') || left.createdAt - right.createdAt)
  const currentComments = comments.filter(comment => comment.commit === requirement.currentCommit)
  const unreadCommentNotifications = (notifications ?? []).filter(item => item.requirementId === requirement.id && item.objectType === 'comment' && item.readAt === undefined)
  const unreadCommentIds = new Set(unreadCommentNotifications.map(item => item.objectId))
  const unreadComments = currentComments.filter(comment => unreadCommentIds.has(comment.id))
  const openComments = currentComments.filter(comment => comment.status === 'open')
  const closedComments = currentComments.filter(comment => comment.status !== 'open')
  const historicalComments = comments.filter(comment => comment.commit !== requirement.currentCommit)
  const renderThread = (comment: CommentThread) => {
    const selected = focusedCommentId === comment.id
    const currentVersion = comment.commit === requirement.currentCommit
    const resolvedText = comment.resolution ? commentResolutionLabel[comment.resolution] : undefined
    return <section id={`spec-object-${comment.id}`} className={`${css.commentThread} ${selected ? css.commentThreadSelected : ''} ${comment.status !== 'open' ? css.commentThreadClosed : ''}`} key={comment.id} aria-current={selected ? 'true' : undefined}>
      <header className={css.commentThreadHead}>
        <div className={css.commentGlyph} aria-hidden="true">评</div>
        <div className={css.commentThreadMeta}>
          <strong>{comment.author.nickname}</strong>
          <div className={css.threadPills}><span>{currentVersion ? '当前正文' : '历史正文'}</span><span>{statusLabel[comment.status] ?? comment.status}</span><span>AI {statusLabel[comment.aiStatus] ?? comment.aiStatus}</span>{resolvedText && <span>{resolvedText}</span>}</div>
        </div>
        <div className={css.threadHeaderActions}>{unreadCommentIds.has(comment.id) && <button type="button" onClick={() => void act(actor => ({ kind: 'notification.mark-read', participant: actor, requirementId: requirement.id, notificationIds: unreadCommentNotifications.filter(item => item.objectId === comment.id).map(item => item.id) }))}>标为已读</button>}{comment.anchor && <button type="button" className={css.locateSourceButton} onClick={() => locateComment(comment.id)}>定位正文</button>}<button type="button" onClick={() => void navigator.clipboard.writeText(`${location.origin}${location.pathname}#spec-collab/${requirement.id}/discussion/${comment.id}`)}>复制链接</button></div>
      </header>
      {comment.anchor && <button type="button" className={css.commentSourceButton} onClick={() => locateComment(comment.id)}><span>{comment.anchor.heading?.trim() || '原文片段'}</span><q>{comment.anchor.quote}</q></button>}
      {!comment.anchor && <div className={css.commentSourceButton}><span>整篇需求</span><q>页面级总评</q></div>}
      <MarkdownBody text={comment.body} className={css.commentBody}/>
      {comment.aiSessionId && <AiConversation api={api} requirementId={requirement.id} sessionId={comment.aiSessionId}/>}
      {comment.replies.length > 0 && <div className={css.replyStack}>{comment.replies.map(reply => <div className={css.reply} key={reply.id}><strong>{reply.author.nickname}{reply.author.kind === 'ai' ? ' · 智能助手' : ''}</strong><MarkdownBody text={reply.body}/></div>)}</div>}
      {comment.status === 'open' && <div className={css.replyComposer}><label>回复评论<textarea value={replyDrafts[comment.id] ?? ''} onChange={event => setReplyDrafts(current => ({ ...current, [comment.id]: event.target.value }))} placeholder={directory.length > 0 ? `输入回复，可使用 ${directory.slice(0, 2).map(item => `@${item.nickname}`).join('、')}` : '输入回复'}/></label><button disabled={!(replyDrafts[comment.id] ?? '').trim()} onClick={() => { const body = (replyDrafts[comment.id] ?? '').trim(); const mentions = directory.filter(item => body.includes(`@${item.nickname}`)).map(item => item.participantId); void act(actor => ({ kind: 'comment.reply', participant: actor, requirementId: requirement.id, commentId: comment.id, body, mentions })).then(ok => { if (ok) setReplyDrafts(current => ({ ...current, [comment.id]: '' })) }) }}>回复</button></div>}
      {comment.status === 'open' && <div className={css.commentActions}>{(['written-back', 'decision', 'rejected', 'open-question'] as CommentResolution[]).map(resolution => <button key={resolution} onClick={() => void act(actor => ({ kind: 'comment.resolve', participant: actor, requirementId: requirement.id, commentId: comment.id, resolution }))}>{commentResolutionLabel[resolution]}</button>)}</div>}
      {comment.status === 'resolved' && <div className={css.commentActions}><button onClick={() => void act(actor => ({ kind: 'comment.reopen', participant: actor, requirementId: requirement.id, commentId: comment.id }))}>重新打开</button></div>}
    </section>
  }
  return <div className={css.discussionPanel}>
    <div className={css.discussionSummary}><div><strong>统一评论</strong><span>{openComments.length > 0 ? `${openComments.length} 个当前正文问题待收口` : '当前正文没有待处理讨论'}</span></div><b>{comments.length}</b></div>
    <div className={css.discussionFilters}><label>状态<select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="open">未解决</option><option value="unread">未读</option><option value="resolved">已解决</option><option value="all">全部</option></select></label><label>排序<select value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="document">正文顺序</option><option value="recent">最近更新</option></select></label></div>
    {filter === 'open' && openComments.length === 0 && <div className={css.emptyPanel}><strong>没有打开的评论</strong><p>选中正文可发起行内评论，也可以使用“评论整篇”给出页面总评。</p></div>}
    {filter === 'unread' && unreadComments.length === 0 && <div className={css.emptyPanel}><strong>没有未读评论</strong><p>新的提及、回复和重新打开会进入插件内通知。</p></div>}
    {(filter === 'open' || filter === 'all') && openComments.map(renderThread)}
    {filter === 'unread' && unreadComments.map(renderThread)}
    {(filter === 'resolved' || filter === 'all') && closedComments.map(renderThread)}
    {filter === 'all' && historicalComments.length > 0 && <details className={css.historyGroup}><summary>历史正文讨论 · {historicalComments.length}</summary><div className={css.threadStack}>{historicalComments.map(renderThread)}</div></details>}
  </div>
}
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

type InsightData = Awaited<ReturnType<SpecApi['insights']>>
function InsightPanel({ requirement, api, act }: { requirement: RequirementView; api: SpecApi; act: Act }) {
  const [data, setData] = useState<InsightData>({ items: [], total: 0, links: [], customers: [], companies: [], sources: [] })
  const [catalog, setCatalog] = useState<InsightData>({ items: [], total: 0, links: [], customers: [], companies: [], sources: [] })
  const [filters, setFilters] = useState<{ customerId: string; companyId: string; sourceId: string; importance: '' | keyof typeof importanceLabel }>({ customerId: '', companyId: '', sourceId: '', importance: '' })
  const [form, setForm] = useState({ title: '', body: '', customer: '', customerRef: '', company: '', companyRef: '', source: '', url: '', importance: 'unknown' as 'unknown' | 'want' | 'important' | 'critical', targets: '' })
  const [open, setOpen] = useState(false); const [error, setError] = useState(''); const [importPreview, setImportPreview] = useState<ReturnType<typeof parseInsightFile>>()
  const importSummary = useMemo(() => {
    if (!importPreview) return { added: 0, updated: 0, duplicates: 0 }
    const sourceId = stableLocalId('source', `${importPreview.kind}:${importPreview.name}`)
    const existing = new Set(catalog.items.filter(item => item.sourceId === sourceId).map(item => normalizeInsightBody(item.body)))
    const seen = new Set<string>(); let duplicates = 0
    for (const row of importPreview.rows) { const body = normalizeInsightBody(row.body); if (existing.has(body) || seen.has(body)) duplicates += 1; else seen.add(body) }
    return { added: importPreview.rows.length - duplicates, updated: 0, duplicates }
  }, [catalog.items, importPreview])
  const load = (): void => { void Promise.all([api.insights({ requirementId: requirement.id }), api.insights({ requirementId: requirement.id, ...(filters.customerId ? { customerId: filters.customerId } : {}), ...(filters.companyId ? { companyId: filters.companyId } : {}), ...(filters.sourceId ? { sourceId: filters.sourceId } : {}), ...(filters.importance ? { importance: filters.importance } : {}) })]).then(([all, filtered]) => { setCatalog(all); setData(filtered) }, reason => setError(reason instanceof Error ? reason.message : String(reason))) }
  useEffect(load, [requirement.id, requirement.metrics.insightCount, filters.customerId, filters.companyId, filters.sourceId, filters.importance])
  const submit = async (): Promise<void> => {
    if (!form.body.trim() || !form.source.trim()) return
    const companyId = form.company.trim() ? stableLocalId('company', form.companyRef || form.company) : undefined
    const customerId = form.customer.trim() ? stableLocalId('customer', form.customerRef || `${form.company}:${form.customer}`) : undefined
    const sourceId = stableLocalId('source', form.url || form.source); const insightId = `insight-${browserUuid()}`
    if (companyId && !await act(actor => ({ kind: 'company.upsert', participant: actor, requirementId: requirement.id, company: { id: companyId, name: form.company.trim(), ...(form.companyRef.trim() ? { externalRef: form.companyRef.trim() } : {}) } }))) return
    if (customerId && !await act(actor => ({ kind: 'customer.upsert', participant: actor, requirementId: requirement.id, customer: { id: customerId, displayName: form.customer.trim(), ...(companyId ? { companyId } : {}), ...(form.customerRef.trim() ? { externalRef: form.customerRef.trim() } : {}) } }))) return
    const sourceUrl = safeHttpUrl(form.url.trim())
    if (!await act(actor => ({ kind: 'source.upsert', participant: actor, requirementId: requirement.id, source: { id: sourceId, kind: form.url.trim() ? 'url' : 'text', label: form.source.trim(), ...(sourceUrl ? { url: sourceUrl } : {}), accessStatus: form.url.trim() && !sourceUrl ? 'unverified' : 'available' } }))) return
    const links = parseInsightTargets(form.targets, requirement.id)
    if (await act(actor => ({ kind: 'insight.create', participant: actor, requirementId: requirement.id, insight: { id: insightId, sourceId, ...(customerId ? { customerId } : {}), ...(companyId && !customerId ? { companyId } : {}), title: form.title.trim() || truncateGraphemes(form.body.trim(), 28), body: form.body.trim(), importance: form.importance, capturedAt: Date.now() }, links }))) { setOpen(false); setForm({ title: '', body: '', customer: '', customerRef: '', company: '', companyRef: '', source: '', url: '', importance: 'unknown', targets: '' }); load() }
  }
  const importRows = async (): Promise<void> => {
    if (!importPreview || importPreview.errors.length > 0) return
    const sourceId = stableLocalId('source', `${importPreview.kind}:${importPreview.name}`); const companies = new Map<string, { id: string; name: string }>(); const customers = new Map<string, { id: string; displayName: string; companyId?: string }>()
    const links: Array<{ insightId: string; requirementId: string; targetType: 'requirement' | 'section' | 'acceptance-criterion'; targetId?: string }> = []
    const rows = importPreview.rows.map((row, index) => {
      const companyId = row.company ? stableLocalId('company', row.company) : undefined; const customerId = row.customer ? stableLocalId('customer', `${row.company}:${row.customer}`) : undefined
      if (companyId) companies.set(companyId, { id: companyId, name: row.company! }); if (customerId) customers.set(customerId, { id: customerId, displayName: row.customer!, ...(companyId ? { companyId } : {}) })
      const id = `insight-${browserUuid()}-${index}`; links.push(...parseInsightTargets(row.targets?.join(',') ?? '', requirement.id).map(link => ({ insightId: id, ...link })))
      return { id, sourceId, ...(customerId ? { customerId } : {}), ...(companyId && !customerId ? { companyId } : {}), title: row.title || truncateGraphemes(row.body, 28), body: row.body, importance: row.importance, capturedAt: row.capturedAt ?? Date.now() }
    })
    if (await act(actor => ({ kind: 'insight.import', participant: actor, requirementId: requirement.id, source: { id: sourceId, kind: importPreview.kind, label: importPreview.name, accessStatus: 'available' }, companies: [...companies.values()], customers: [...customers.values()], rows, links }))) { setImportPreview(undefined); load() }
  }
  return <div className={css.insightPanel}><div className={css.insightScore}><div><span>客户重要度分</span><b>{requirement.metrics.customerImportanceScore}</b></div><dl><div><dt>洞察</dt><dd>{requirement.metrics.insightCount}</dd></div><div><dt>客户</dt><dd>{requirement.metrics.customerCount}</dd></div><div><dt>公司</dt><dd>{requirement.metrics.companyCount}</dd></div><div><dt>匿名</dt><dd>{requirement.metrics.anonymousInsightCount}</dd></div></dl></div><div className={css.insightFilters}><label>客户<select value={filters.customerId} onChange={event => setFilters(current => ({ ...current, customerId: event.target.value }))}><option value="">全部</option>{catalog.customers.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label><label>公司<select value={filters.companyId} onChange={event => setFilters(current => ({ ...current, companyId: event.target.value }))}><option value="">全部</option>{catalog.companies.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>来源<select value={filters.sourceId} onChange={event => setFilters(current => ({ ...current, sourceId: event.target.value }))}><option value="">全部</option>{catalog.sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label>重要度<select value={filters.importance} onChange={event => setFilters(current => ({ ...current, importance: event.target.value as typeof current.importance }))}><option value="">全部</option>{Object.entries(importanceLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><div className={css.insightActions}><button className={css.execute} onClick={() => setOpen(true)}>记录客户洞察</button><label className={css.fileButton}>导入 CSV / Markdown<input type="file" accept=".csv,.md,.markdown,text/csv,text/markdown" onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) { setError('文件超过 5 MB'); return } void file.text().then(text => setImportPreview(parseInsightFile(file.name, text))) }}/></label></div>{error && <p className={css.chatError}>{error}</p>}{importPreview && <section className={css.importPreview}><header><div><strong>{importPreview.name}</strong><span>新增 {importSummary.added} · 更新 {importSummary.updated} · 重复 {importSummary.duplicates} · 错误 {importPreview.errors.length}</span></div><button onClick={() => setImportPreview(undefined)}>取消</button></header>{importPreview.errors.map(errorText => <p key={errorText}>{errorText}</p>)}<div>{importPreview.rows.slice(0, 5).map((row, index) => <article key={index}><b>{row.title || truncateGraphemes(row.body, 24)}</b><span>{row.customer || '匿名'} · {importanceLabel[row.importance]}{row.targets?.length ? ` · ${row.targets.length} 个关联` : ''}</span></article>)}</div><button className={css.execute} disabled={importPreview.errors.length > 0 || importPreview.rows.length === 0} onClick={() => void importRows()}>确认原子导入</button></section>}{data.items.length === 0 && <div className={css.emptyPanel}><strong>没有符合条件的客户证据</strong><p>清除筛选，或记录客户原声并把它连接到需求、规则和验收标准。</p></div>}{data.items.map(insight => { const source = data.sources.find(item => item.id === insight.sourceId) ?? catalog.sources.find(item => item.id === insight.sourceId); const customer = data.customers.find(item => item.id === insight.customerId) ?? catalog.customers.find(item => item.id === insight.customerId); const company = data.companies.find(item => item.id === (insight.companyId ?? customer?.companyId)) ?? catalog.companies.find(item => item.id === (insight.companyId ?? customer?.companyId)); return <article id={`spec-object-${insight.id}`} className={css.insightCard} key={insight.id}><header><span>{importanceLabel[insight.importance]}</span><time title={new Date(insight.capturedAt).toLocaleString()}>{relativeTime(insight.capturedAt)}</time></header><h3>{insight.title}</h3><blockquote>{insight.body}</blockquote><footer><span>{customer?.displayName ?? '匿名客户'}{company ? ` · ${company.name}` : ''}</span>{source?.url && safeHttpUrl(source.url) ? <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a> : <code>{source?.label ?? insight.sourceId}</code>}</footer><div className={css.insightLinks}>{data.links.filter(link => link.insightId === insight.id).map(link => <span key={link.id}>{link.targetType === 'requirement' ? '需求' : link.targetId}<button aria-label={`取消关联 ${link.targetId ?? '需求'}`} onClick={() => void act(actor => ({ kind: 'insight.unlink', participant: actor, requirementId: requirement.id, linkId: link.id })).then(ok => { if (ok) load() })}>×</button></span>)}<button onClick={() => { void navigator.clipboard.writeText(`${location.origin}${location.pathname}#spec-collab/${requirement.id}/insights/${insight.id}`) }}>复制链接</button></div></article>})}{open && <AccessibleDialog title="记录客户洞察" close={() => setOpen(false)} className={css.insightDialog}><form onSubmit={event => { event.preventDefault(); void submit() }}><div className={css.dialogHead}><div><span>客户证据</span><h2>记录客户洞察</h2></div><button type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button></div><label>洞察正文（必填）<textarea autoFocus required value={form.body} onChange={event => setForm({ ...form, body: event.target.value })} placeholder="保留客户原话或可核对的观察"/></label><label>标题<input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })}/></label><div className={css.formGrid}><label>客户显示名<input value={form.customer} onChange={event => setForm({ ...form, customer: event.target.value })}/></label><label>客户外部编号<input value={form.customerRef} onChange={event => setForm({ ...form, customerRef: event.target.value })}/></label><label>公司<input value={form.company} onChange={event => setForm({ ...form, company: event.target.value })}/></label><label>公司外部编号<input value={form.companyRef} onChange={event => setForm({ ...form, companyRef: event.target.value })}/></label></div><label>来源名称（必填）<input required value={form.source} onChange={event => setForm({ ...form, source: event.target.value })}/></label><label>来源 URL（选填，仅 http/https）<input type="url" value={form.url} onChange={event => setForm({ ...form, url: event.target.value })}/></label><label>关联目标（逗号分隔）<input value={form.targets} onChange={event => setForm({ ...form, targets: event.target.value })} placeholder="section:业务规则, ac:AC-2, requirement:需求编号"/><small>当前需求会自动关联；可追加多个需求、章节或验收标准。</small></label><label>重要度<select value={form.importance} onChange={event => setForm({ ...form, importance: event.target.value as typeof form.importance })}>{Object.entries(importanceLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><div className={css.stickyActions}><button type="button" onClick={() => setOpen(false)}>取消</button><button className={css.execute} disabled={!form.body.trim() || !form.source.trim()}>保存洞察</button></div></form></AccessibleDialog>}</div>
}

const importanceLabel = { unknown: '未标注', want: '想要', important: '重要', critical: '关键' } as const
type ImportedInsight = { title?: string; body: string; customer?: string; company?: string; importance: keyof typeof importanceLabel; capturedAt?: number; targets?: string[] }
function normalizeInsightBody(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase() }
function stableLocalId(prefix: string, value: string): string { let hash = 2166136261; for (const character of value.normalize('NFKC').toLocaleLowerCase()) { hash ^= character.codePointAt(0) ?? 0; hash = Math.imul(hash, 16777619) } return `${prefix}-${(hash >>> 0).toString(16)}` }
function parseInsightTargets(value: string, currentRequirementId: string): Array<{ requirementId: string; targetType: 'requirement' | 'section' | 'acceptance-criterion'; targetId?: string }> { return value.split(/[,，;；\n]/).map(item => item.trim()).filter(Boolean).map(item => { const [rawType = '', ...rest] = item.split(':'); const targetId = rest.join(':').trim(); const type = rawType.trim().toLocaleLowerCase(); if ((type === 'requirement' || type === '需求') && targetId) return { requirementId: targetId, targetType: 'requirement' as const }; if ((type === 'ac' || type === '验收') && targetId) return { requirementId: currentRequirementId, targetType: 'acceptance-criterion' as const, targetId }; if ((type === 'section' || type === '章节') && targetId) return { requirementId: currentRequirementId, targetType: 'section' as const, targetId }; return { requirementId: currentRequirementId, targetType: 'section' as const, targetId: item } }) }
function parseInsightFile(name: string, text = ''): { name: string; kind: 'csv' | 'markdown'; rows: ImportedInsight[]; errors: string[] } {
  const kind = name.toLocaleLowerCase().endsWith('.csv') ? 'csv' : 'markdown'; const rows: ImportedInsight[] = []; const errors: string[] = []
  if (kind === 'markdown') {
    const sections = text.split(/^##\s+/m).slice(1)
    for (const [index, section] of sections.entries()) { const [heading = '', ...bodyLines] = section.split('\n'); const metadata = new Map(bodyLines.filter(line => /^[-*]\s*(客户|公司|重要度|来源|关联目标)\s*[:：]/.test(line)).map(line => { const match = /^[-*]\s*([^:：]+)\s*[:：]\s*(.*)$/.exec(line)!; return [match[1]!.trim(), match[2]!.trim()] })); const body = bodyLines.filter(line => !/^[-*]\s*(客户|公司|重要度|来源|关联目标)\s*[:：]/.test(line)).join('\n').trim(); if (!body) { errors.push(`第 ${index + 1} 个 Markdown 小节缺少正文`); continue } const customer = metadata.get('客户'); const company = metadata.get('公司'); const targets = metadata.get('关联目标')?.split(/[,，;；]/).map(value => value.trim()).filter(Boolean); rows.push({ title: heading.trim(), body, ...(customer ? { customer } : {}), ...(company ? { company } : {}), importance: parseImportance(metadata.get('重要度')), ...(targets?.length ? { targets } : {}) }) }
  } else {
    const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean); const headers = parseCsvLine(lines.shift() ?? '').map(value => value.trim().toLocaleLowerCase()); const bodyIndex = headers.indexOf('body')
    if (bodyIndex < 0) errors.push('CSV 缺少必填列 body')
    for (const [index, line] of lines.entries()) { const values = parseCsvLine(line); const value = (key: string): string => values[headers.indexOf(key)]?.trim() ?? ''; const body = values[bodyIndex]?.trim() ?? ''; if (!body) { errors.push(`CSV 第 ${index + 2} 行缺少 body`); continue } const targets = (value('targets') || value('target')).split(/[;；]/).map(item => item.trim()).filter(Boolean); rows.push({ ...(value('title') ? { title: value('title') } : {}), body, ...(value('customer') ? { customer: value('customer') } : {}), ...(value('company') ? { company: value('company') } : {}), importance: parseImportance(value('importance')), ...(Number.isFinite(Date.parse(value('captured_at'))) ? { capturedAt: Date.parse(value('captured_at')) } : {}), ...(targets.length ? { targets } : {}) }) }
  }
  if (rows.length > 2_000) errors.push('最多导入 2,000 条洞察')
  return { name, kind, rows: rows.slice(0, 2_000), errors }
}
function parseCsvLine(line: string): string[] { const values: string[] = []; let value = ''; let quoted = false; for (let index = 0; index < line.length; index += 1) { const char = line[index]!; if (char === '"' && quoted && line[index + 1] === '"') { value += '"'; index += 1 } else if (char === '"') quoted = !quoted; else if (char === ',' && !quoted) { values.push(value); value = '' } else value += char } values.push(value); return values }
function parseImportance(value: string | undefined): keyof typeof importanceLabel { const normalized = value?.trim().toLocaleLowerCase(); return normalized === 'critical' || normalized === '关键' ? 'critical' : normalized === 'important' || normalized === '重要' ? 'important' : normalized === 'want' || normalized === '想要' ? 'want' : 'unknown' }

function PatchPanel({ requirement, act, api }: { requirement: RequirementView; act: Act; api: SpecApi }) {
  const [summaries, setSummaries] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState<string>()
  const [reviewing, setReviewing] = useState<{ patchId: string; diff: StructuredDiff }>()
  const [diffError, setDiffError] = useState('')
  const current = requirement.patches.filter(patch => patch.baseCommit === requirement.currentCommit && patch.status === 'pending').slice().reverse()
  const historical = requirement.patches.filter(patch => !current.some(item => item.id === patch.id)).slice().reverse()
  const renderPatch = (patch: RequirementView['patches'][number]) => {
    const chinese = /[\u3400-\u9fff]/.test(`${patch.summary}\n${patch.proposedMarkdown}`)
    const commitSummary = summaries[patch.id] ?? `合入 AI 建议：${patch.summary}`
    return <article id={`spec-object-${patch.id}`} className={css.reviewCard} key={patch.id}>
      <div className={css.badges}><b>{statusLabel[patch.status] ?? patch.status}</b><span>{reviewKindLabel[patch.reviewKind]}</span></div>
      <MarkdownBody text={patch.summary} className={css.reviewTitle}/>
      {!chinese && <div className={css.legacyWarning}><strong>旧建议无法使用</strong><p>这份建议生成于中文约束启用前，请重新运行 AI 检查。</p></div>}
      <button className={css.panelAction} onClick={async () => { setDiffError(''); try { setReviewing({ patchId: patch.id, diff: await api.previewDiff(requirement.version.markdown, patch.proposedMarkdown, `基线 ${patch.baseCommit.slice(0, 8)}`, 'AI 建议') }) } catch (error) { setDiffError(error instanceof Error ? error.message : String(error)) } }}>审核全部改动</button>
      {patch.status === 'pending' && (chinese ? <div className={css.patchAccept}><label>版本说明<input required value={commitSummary} onChange={event => setSummaries(currentValues => ({ ...currentValues, [patch.id]: event.target.value }))}/></label><div className={css.cardActions}><button className={css.execute} disabled={submitting === patch.id || !commitSummary.trim()} onClick={async () => { setSubmitting(patch.id); try { await act(actor => ({ kind: 'patch.accept', participant: actor, requirementId: requirement.id, patchId: patch.id, summary: commitSummary })) } finally { setSubmitting(undefined) } }}>{submitting === patch.id ? '正在写入…' : '接受并写入正文'}</button><button disabled={submitting === patch.id} onClick={() => void act(actor => ({ kind: 'patch.reject', participant: actor, requirementId: requirement.id, patchId: patch.id }))}>不采用</button></div></div> : <div className={css.cardActions}><button onClick={() => void act(actor => ({ kind: 'review.request', participant: actor, requirementId: requirement.id, reviewKind: patch.reviewKind }))}>重新生成建议</button><button onClick={() => void act(actor => ({ kind: 'patch.reject', participant: actor, requirementId: requirement.id, patchId: patch.id }))}>废弃旧建议</button></div>)}
    </article>
  }
  return <>{diffError && <p className={css.chatError}>{diffError}</p>}{current.length === 0 && <div className={css.emptyPanel}><strong>当前没有需要审核的 AI 建议</strong><p>AI 根据你的回答整理正文后，建议会出现在这里。</p></div>}{current.map(renderPatch)}{historical.length > 0 && <details className={css.historyGroup}><summary>历史建议 · {historical.length}</summary><div>{historical.map(renderPatch)}</div></details>}{reviewing && <AccessibleDialog title="审核 AI 建议差异" close={() => setReviewing(undefined)} className={css.diffDialog}><div className={css.diffHeader}><div><span>整包原子接受</span><h2>审核 AI 建议的全部改动</h2></div><button aria-label="关闭差异" onClick={() => setReviewing(undefined)}>×</button></div><StructuredDiffView diff={reviewing.diff}/><div className={css.diffActions}><button onClick={() => setReviewing(undefined)}>继续检查</button><button className={css.execute} onClick={() => { const patch = current.find(item => item.id === reviewing.patchId); if (!patch) return; const summary = summaries[patch.id] ?? `合入 AI 建议：${patch.summary}`; void act(actor => ({ kind: 'patch.accept', participant: actor, requirementId: requirement.id, patchId: patch.id, summary })).then(ok => { if (ok) setReviewing(undefined) }) }}>整包接受并保存</button></div></AccessibleDialog>}</>
}
function DecisionPanel({ requirement, act }: { requirement: RequirementView; act: Act }) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ question: '', decision: '', rationale: '', sections: '', acceptanceIds: '' })
  const affectedSections = form.sections.split(',').map(value => value.trim()).filter(Boolean)
  const affectedAcceptanceIds = form.acceptanceIds.split(',').map(value => value.trim()).filter(Boolean)
  const submit = async (): Promise<void> => { if (await act(actor => ({ kind: 'decision.create', participant: actor, requirementId: requirement.id, question: form.question, options: [], decision: form.decision, rationale: form.rationale, affectedSections, affectedAcceptanceIds }))) { setOpen(false); setForm({ question: '', decision: '', rationale: '', sections: '', acceptanceIds: '' }) } }
  return <>{requirement.decisions.length === 0 && !open && <div className={css.emptyPanel}><strong>还没有需要长期保留的决策</strong><p>当评论形成明确取舍、例外或边界时，把它记录为决策，避免版本变化后丢失上下文。</p><button className={css.execute} onClick={() => setOpen(true)}>记录第一个决策</button></div>}{requirement.decisions.map(item => <section id={`spec-object-${item.id}`} key={item.id}><MarkdownBody text={item.question} className={css.reviewTitle}/><MarkdownBody text={item.decision}/><small title={new Date(item.createdAt).toLocaleString()}>{item.rationale} · {item.confirmer.nickname} · {relativeTime(item.createdAt)} · {item.status === 'active' ? '生效中' : '已作废'}</small><button className={css.recordLinkButton} onClick={() => void navigator.clipboard.writeText(`${location.origin}${location.pathname}#spec-collab/${requirement.id}/records/${item.id}?commit=${item.commit}`)}>复制链接</button></section>)}{open ? <div className={css.decisionForm}><label>待决策问题（必填）<textarea rows={2} required autoFocus value={form.question} onChange={event => setForm({ ...form, question: event.target.value })}/></label><label>确认结论（必填）<textarea rows={3} required value={form.decision} onChange={event => setForm({ ...form, decision: event.target.value })}/></label><label>决策理由（选填）<textarea rows={2} value={form.rationale} onChange={event => setForm({ ...form, rationale: event.target.value })}/></label><label>受影响章节（与 AC 至少填写一项）<input list="decision-sections" value={form.sections} onChange={event => setForm({ ...form, sections: event.target.value })} placeholder="业务术语与规则"/><datalist id="decision-sections">{[...requirement.version.markdown.matchAll(/^##\s+(.+)$/gm)].map(match => <option key={match[1]} value={match[1]}/>)}</datalist></label><label>受影响 AC IDs（与章节至少填写一项）<input value={form.acceptanceIds} onChange={event => setForm({ ...form, acceptanceIds: event.target.value })} placeholder="AC-RETRY-001"/></label><div className={css.stickyActions}><button onClick={() => setOpen(false)}>取消</button><button className={css.execute} disabled={!form.question.trim() || !form.decision.trim() || (affectedSections.length === 0 && affectedAcceptanceIds.length === 0)} onClick={() => void submit()}>保存决策</button></div></div> : requirement.decisions.length > 0 && <button className={css.panelAction} onClick={() => setOpen(true)}>记录新决策</button>}</>
}
function VersionPanel({ requirement, api, act }: { requirement: RequirementView; api: SpecApi; act: Act }) {
  const previous = requirement.history.find(version => version.commit !== requirement.currentCommit)?.commit ?? requirement.currentCommit
  const [baseCommit, setBaseCommit] = useState(previous)
  const [headCommit, setHeadCommit] = useState(requirement.currentCommit)
  const [comparison, setComparison] = useState<StructuredDiff>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [restoreCommit, setRestoreCommit] = useState<string>()
  const compare = async (): Promise<void> => { if (baseCommit === headCommit) return; setLoading(true); setError(''); try { setComparison(await api.diff(requirement.id, baseCommit, headCommit)) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) } }
  const restore = async (): Promise<void> => { if (!restoreCommit) return; if (await act(actor => ({ kind: 'version.restore', participant: actor, requirementId: requirement.id, commit: restoreCommit, summary: `恢复版本 ${restoreCommit.slice(0, 8)}` }))) setRestoreCommit(undefined) }
  return <><div className={css.versionPicker}><label>基准版本<select value={baseCommit} onChange={event => setBaseCommit(event.target.value)}>{requirement.history.map(version => <option key={version.commit} value={version.commit}>{version.commit === requirement.currentCommit ? '当前 · ' : ''}{version.commit.slice(0, 8)} · {cleanDisplayText(version.summary)}</option>)}</select></label><label>对比版本<select value={headCommit} onChange={event => setHeadCommit(event.target.value)}>{requirement.history.map(version => <option key={version.commit} value={version.commit}>{version.commit === requirement.currentCommit ? '当前 · ' : ''}{version.commit.slice(0, 8)} · {cleanDisplayText(version.summary)}</option>)}</select></label><button className={css.execute} disabled={loading || baseCommit === headCommit} onClick={() => void compare()}>{loading ? '生成中…' : '比较差异'}</button></div>{error && <p className={css.chatError}>{error}</p>}{requirement.history.map(version => <div id={`spec-object-${version.commit}`} className={css.versionRow} key={version.commit} aria-current={version.commit === requirement.currentCommit ? 'true' : undefined}><code>{version.commit.slice(0, 10)}</code><span>{cleanDisplayText(version.summary)}</span><small title={new Date(version.createdAt).toLocaleString()}>{version.author.nickname} · {relativeTime(version.createdAt)}</small><div className={css.versionActions}><button onClick={() => void navigator.clipboard.writeText(`${location.origin}${location.pathname}#spec-collab/${requirement.id}/records/${version.commit}?commit=${version.commit}`)}>复制链接</button><button disabled={version.commit === requirement.currentCommit} onClick={() => setRestoreCommit(version.commit)}>{version.commit === requirement.currentCommit ? '当前版本' : '恢复为新版本'}</button></div></div>)}{comparison && <AccessibleDialog title="版本差异" close={() => setComparison(undefined)} className={css.diffDialog}><div className={css.diffHeader}><div><span>版本历史</span><h2>比较两个版本</h2></div><button aria-label="关闭版本差异" onClick={() => setComparison(undefined)}>×</button></div><StructuredDiffView diff={comparison}/><div className={css.diffActions}><button onClick={() => setComparison(undefined)}>关闭</button></div></AccessibleDialog>}{restoreCommit && <AccessibleDialog title="恢复历史版本" close={() => setRestoreCommit(undefined)} className={css.dialogSurface}><div className={css.dialogForm}><div className={css.dialogHead}><div><span>可追溯恢复</span><h2>恢复 {restoreCommit.slice(0, 8)} 为新版本？</h2></div><button aria-label="关闭" onClick={() => setRestoreCommit(undefined)}>×</button></div><p>系统会创建新的 Git commit，不移动或重写历史。受正文变化影响的确认、决策与 AI 建议将按现有规则失效。</p><div className={css.stickyActions}><button onClick={() => setRestoreCommit(undefined)}>取消</button><button className={css.dangerButton} onClick={() => void restore()}>确认恢复并创建版本</button></div></div></AccessibleDialog>}</>
}

function StructuredDiffView({ diff }: { diff: StructuredDiff }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggle = (key: string): void => setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  const lines = (items: StructuredDiff['hunks'][number]['lines'], key: string) => items.map((line, index) => <div key={`${key}-${index}`} className={line.type === 'added' ? css.diffAdded : line.type === 'removed' ? css.diffRemoved : css.diffContext}><span>{line.oldLine ?? ''}</span><span>{line.newLine ?? ''}</span><b aria-hidden="true">{line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}</b><code>{line.text || ' '}</code></div>)
  return <div className={css.structuredDiff}><header><code>{diff.baseLabel}</code><span>→</span><code>{diff.headLabel}</code><b>+{diff.added} / −{diff.removed}</b></header>{diff.hunks.length === 0 ? <div className={css.emptyPanel}>两个版本没有正文差异。</div> : diff.hunks.map(hunk => { const beforeKey = `${hunk.id}:before`; const afterKey = `${hunk.id}:after`; return <section key={hunk.id}>{hunk.collapsedBefore > 0 && (expanded.has(beforeKey) ? <><button className={css.diffCollapsed} onClick={() => toggle(beforeKey)}>收起 {hunk.collapsedBefore} 行上下文</button>{lines(hunk.collapsedBeforeLines, beforeKey)}</> : <button className={css.diffCollapsed} onClick={() => toggle(beforeKey)}>展开前方 {hunk.collapsedBefore} 行未变内容</button>)}{lines(hunk.lines, hunk.id)}{hunk.collapsedAfter > 0 && (expanded.has(afterKey) ? <>{lines(hunk.collapsedAfterLines, afterKey)}<button className={css.diffCollapsed} onClick={() => toggle(afterKey)}>收起 {hunk.collapsedAfter} 行上下文</button></> : <button className={css.diffCollapsed} onClick={() => toggle(afterKey)}>展开后方 {hunk.collapsedAfter} 行未变内容</button>)}</section> })}</div>
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
  return <><div className={css.readyHead}><h3>交付条件</h3><span>{passed} / {requirement.readiness.length} 已满足</span></div><div className={css.checklist}>{requirement.readiness.map(check => <section className={`${css.checkItem} ${check.passed ? css.checkPassed : css.checkBlocked}`} key={check.key}><span className={css.checkIcon} aria-hidden="true">{check.passed ? '✓' : '!'}</span><div><strong>{readinessLabel[check.key] ?? check.key}</strong><small>{check.passed ? '已满足' : '需要补充'}</small>{check.reasons.map(reason => <MarkdownBody key={reason} text={reason}/>)}</div></section>)}</div>{requirement.readyPackage && <section className={css.readyPackage}><div className={css.readyPackageHead}><div><span>就绪需求</span><strong>{requirement.readyPackage.packageHash.slice(0, 12)}</strong></div><div><button onClick={() => void navigator.clipboard.writeText(requirement.readyPackage!.markdown)}>复制 Markdown</button><button onClick={() => downloadText(`${requirement.id}.md`, requirement.readyPackage!.markdown)}>下载 .md</button><button onClick={() => void navigator.clipboard.writeText(requirement.currentCommit)}>复制 commit</button>{requirement.commitUrl && <a href={requirement.commitUrl} target="_blank" rel="noreferrer">打开 commit</a>}<button onClick={() => void navigator.clipboard.writeText(`${location.origin}${location.pathname}#spec-collab/${requirement.id}/tasks/${requirement.id}?commit=${requirement.currentCommit}`)}>复制分享链接</button></div></div><MarkdownBody text={requirement.readyPackage.markdown}/></section>}{requirement.stage === 'ready' && <section className={css.downstreamReturn}><button onClick={() => setReturnOpen(value => !value)}>{returnOpen ? '取消返回问题' : '反馈研发阶段发现的问题'}</button>{returnOpen && <div><label>问题摘要（必填）<textarea required value={form.summary} onChange={event => setForm({ ...form, summary: event.target.value })} placeholder="描述研发阶段发现的产品语义或验收问题"/></label><label>受影响章节（与 AC 至少填写一项）<input value={form.sections} onChange={event => setForm({ ...form, sections: event.target.value })} placeholder="业务术语与规则"/></label><label>受影响 AC IDs（与章节至少填写一项）<input value={form.acceptanceIds} onChange={event => setForm({ ...form, acceptanceIds: event.target.value })} placeholder="AC-RETRY-001"/></label><label>依据来源（选填）<input value={form.source} onChange={event => setForm({ ...form, source: event.target.value })} placeholder="测试报告、Issue 或代码位置"/></label><label>依据版本（选填）<input value={form.version} onChange={event => setForm({ ...form, version: event.target.value })} placeholder="commit SHA 或版本号"/></label><label>依据说明（选填）<textarea value={form.evidence} onChange={event => setForm({ ...form, evidence: event.target.value })}/></label><button className={css.execute} disabled={!form.summary.trim() || (!form.sections.trim() && !form.acceptanceIds.trim())} onClick={() => void submitReturn()}>重新打开受影响内容</button></div>}</section>}</>
}
function ConflictDialog({ conflict, value, setValue, close, submit, busy }: { conflict: SaveConflict; value: string; setValue: (value: string) => void; close: () => void; submit: () => void; busy: boolean }) {
  return <AccessibleDialog title="解决保存冲突" close={close} className={css.conflictDialog} dismissOnBackdrop={false}><div className={css.conflictHeader}><div><h2>解决保存冲突</h2><p>基线 {conflict.baseCommit.slice(0, 8)} 已更新为 {conflict.currentCommit.slice(0, 8)}，Git 尚未写入你的本地草稿。</p></div><button aria-label="关闭冲突窗口" onClick={close}>×</button></div><div className={css.conflictColumns}><label>打开时的基线（只读）<textarea readOnly value={conflict.baseMarkdown}/></label><label>版本库最新版本（只读）<textarea readOnly value={conflict.currentMarkdown}/></label><label>合并稿（必填）<textarea required value={value} onChange={event => setValue(event.target.value)}/></label></div><div className={css.conflictDiffs}><details><summary>基线 → 版本库 Diff</summary><pre>{conflict.baseToCurrentDiff}</pre></details><details><summary>基线 → 本地草稿 Diff</summary><pre>{conflict.baseToDraftDiff}</pre></details></div><div className={css.conflictActions}><button onClick={close}>稍后处理</button><button className={css.execute} disabled={busy || !value.trim()} onClick={submit}>{busy ? '正在提交…' : '基于最新版本保存合并稿'}</button></div></AccessibleDialog>
}
function DialogForm({ title, close, children, submit }: { title: string; close: () => void; children: ReactNode; submit: (event: FormEvent) => void }) { return <AccessibleDialog title={title} close={close} className={css.dialogSurface}><form className={css.dialogForm} onSubmit={submit}>{children}</form></AccessibleDialog> }
function IdentityDialog({
  value,
  boundRole,
  onChange,
  close,
  save,
}: {
  value: ParticipantSnapshot;
  boundRole?: ParticipantRole;
  onChange: (value: ParticipantSnapshot) => void;
  close: () => void;
  save: () => void;
}) {
  return (
    <DialogForm
      title="设置协作身份"
      close={close}
      submit={(event) => {
        event.preventDefault();
        if (value.nickname.trim().length >= 2) save();
      }}
    >
      <div className={css.dialogHead}>
        <div>
          <span>协作身份</span>
          <h2>设置花名和角色</h2>
        </div>
        <button type="button" aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      <p>用于标记回答、决策和版本确认。同一浏览器首次参与后，角色保持不变。</p>
      <label>
        花名（必填）
        <input
          required
          autoFocus
          value={value.nickname}
          onChange={(event) =>
            onChange({ ...value, nickname: event.target.value })
          }
        />
      </label>
      <label>
        参与角色（必填）
        <select
          required
          disabled={boundRole !== undefined}
          value={boundRole ?? value.role}
          onChange={(event) =>
            onChange({ ...value, role: event.target.value as ParticipantRole })
          }
        >
          <option value="product">产品</option>
          <option value="engineering">研发</option>
        </select>
      </label>
      {boundRole && (
        <small>
          当前身份已固定为{boundRole === "product" ? "产品" : "研发"}角色。
        </small>
      )}
      <div className={css.stickyActions}>
        <button type="button" onClick={close}>
          取消
        </button>
        <button
          className={css.execute}
          disabled={value.nickname.trim().length < 2}
        >
          保存身份
        </button>
      </div>
    </DialogForm>
  );
}
function RenameDialog({
  title,
  setTitle,
  close,
  submit,
  busy,
}: {
  title: string;
  setTitle: (title: string) => void;
  close: () => void;
  submit: () => void;
  busy: boolean;
}) {
  return (
    <DialogForm
      title="重命名需求"
      close={close}
      submit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={css.dialogHead}>
        <h2>重命名需求</h2>
        <button type="button" aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      <label>
        需求名称（必填）
        <input
          required
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <div className={css.stickyActions}>
        <button type="button" onClick={close}>
          取消
        </button>
        <button className={css.execute} disabled={busy || !title.trim()}>
          保存名称
        </button>
      </div>
    </DialogForm>
  );
}
function DeleteDialog({
  title,
  close,
  submit,
  busy,
}: {
  title: string;
  close: () => void;
  submit: () => void;
  busy: boolean;
}) {
  return (
    <DialogForm
      title="删除需求"
      close={close}
      submit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={css.dialogHead}>
        <h2>删除需求</h2>
        <button type="button" aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      <p>
        将删除“{title}”及其协作记录，并创建 Git 删除提交。历史版本仍可从 Git
        恢复。
      </p>
      <div className={css.stickyActions}>
        <button type="button" onClick={close}>
          取消
        </button>
        <button className={css.dangerButton} disabled={busy}>
          {busy ? "正在删除…" : "确认删除"}
        </button>
      </div>
    </DialogForm>
  );
}
function WorkspaceDialog({
  value,
  setValue,
  workspaces,
  close,
  submit,
  busy,
}: {
  value: string;
  setValue: (value: string) => void;
  workspaces: ReviewWorkspaceSummary[];
  close: () => void;
  submit: () => void;
  busy: boolean;
}) {
  return (
    <DialogForm
      title="关联项目"
      close={close}
      submit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={css.dialogHead}>
        <h2>关联项目</h2>
        <button type="button" aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      <p>AI 会从所选项目读取代码、规范和团队知识。关联后不能中途切换。</p>
      <label>
        需求所在项目（必填）
        <select
          required
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
        >
          <option value="" disabled>
            {workspaces.length > 0 ? "选择一个项目" : "当前没有可用项目"}
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>
              {workspace.title} · {workspace.path}
            </option>
          ))}
        </select>
      </label>
      <div className={css.stickyActions}>
        <button type="button" onClick={close}>
          取消
        </button>
        <button className={css.execute} disabled={busy || !value}>
          确认关联
        </button>
      </div>
    </DialogForm>
  );
}
function CreateDialog({
  value,
  setValue,
  workspaces,
  close,
  submit,
  busy,
}: {
  value: {
    title: string;
    rawRequirement: string;
    sources: string;
    workspaceId: string;
  };
  setValue: (value: {
    title: string;
    rawRequirement: string;
    sources: string;
    workspaceId: string;
  }) => void;
  workspaces: ReviewWorkspaceSummary[];
  close: () => void;
  submit: () => void;
  busy: boolean;
}) {
  const errors = [
    ...(!value.title.trim() ? ["请填写需求标题"] : []),
    ...(!value.workspaceId ? ["请选择需求所在项目"] : []),
    ...(!value.rawRequirement.trim() ? ["请填写原始需求"] : []),
  ];
  return (
    <DialogForm
      title="新建需求"
      close={close}
      submit={(event) => {
        event.preventDefault();
        if (errors.length === 0) submit();
      }}
    >
      <div className={css.dialogHead}>
        <div>
          <span>新需求</span>
          <h2>从真实问题开始</h2>
        </div>
        <button type="button" aria-label="关闭" onClick={close}>
          ×
        </button>
      </div>
      <p>
        先写清用户问题和期望结果。创建后 AI
        会读取所选项目的已配置资料并在后台检查，你可以离开页面。
      </p>
      {errors.length > 0 && (
        <div className={css.formErrors} role="alert">
          <strong>还需要补充</strong>
          {errors.map((error) => (
            <span key={error}>{error}</span>
          ))}
        </div>
      )}
      <label>
        需求标题（必填）
        <input
          autoFocus
          required
          value={value.title}
          aria-invalid={!value.title.trim()}
          onChange={(event) =>
            setValue({ ...value, title: event.target.value })
          }
        />
      </label>
      <label>
        需求所在项目（必填）
        <select
          required
          value={value.workspaceId}
          aria-invalid={!value.workspaceId}
          onChange={(event) =>
            setValue({ ...value, workspaceId: event.target.value })
          }
        >
          <option value="" disabled>
            {workspaces.length > 0 ? "选择一个项目" : "当前没有可用项目"}
          </option>
          {workspaces.map((workspace) => (
            <option key={workspace.workspaceId} value={workspace.workspaceId}>
              {workspace.title} · {workspace.path}
            </option>
          ))}
        </select>
      </label>
      <label>
        原始需求（必填）
        <textarea
          required
          value={value.rawRequirement}
          aria-invalid={!value.rawRequirement.trim()}
          onChange={(event) =>
            setValue({ ...value, rawRequirement: event.target.value })
          }
          placeholder="描述用户遇到的问题、期望结果、已有方案和已知限制"
        />
      </label>
      <label>
        补充资料（选填，每行一项）
        <textarea
          value={value.sources}
          onChange={(event) =>
            setValue({ ...value, sources: event.target.value })
          }
          placeholder="相关文档链接&#10;历史决策&#10;代码目录或组件"
        />
      </label>
      <div className={css.createSummary}>
        <strong>提交后</strong>
        <span>创建 Git 初始版本</span>
        <span>开始产品 AI 初审</span>
        <span>输入和运行状态会保留</span>
      </div>
      <div className={css.stickyActions}>
        <button type="button" onClick={close}>
          取消
        </button>
        <button className={css.execute} disabled={busy || errors.length > 0}>
          {busy ? "正在创建…" : "创建并开始 AI 检查"}
        </button>
      </div>
    </DialogForm>
  );
}
function PageCommentDialog({ value, setValue, close, submit, busy }: { value: string; setValue: (value: string) => void; close: () => void; submit: () => void; busy: boolean }) { return <DialogForm title="评论整篇需求" close={close} submit={event => { event.preventDefault(); submit() }}><div className={css.dialogHead}><div><span>页面总评</span><h2>评论整篇需求</h2></div><button type="button" aria-label="关闭" onClick={close}>×</button></div><p>用于整体方向、完整性或跨章节问题。针对具体文字时，请在正文中选中片段评论。</p><label>评论内容（必填）<textarea autoFocus required value={value} onChange={event => setValue(event.target.value)}/></label><div className={css.stickyActions}><button type="button" onClick={close}>取消</button><button className={css.execute} disabled={busy || !value.trim()}>提交总评</button></div></DialogForm> }
function NotificationDialog({ notifications, close, open, markRead }: { notifications: Notification[]; close: () => void; open: (item: Notification) => void; markRead: (item: Notification) => void }) { return <AccessibleDialog title="通知中心" close={close} className={css.notificationDialog}><div className={css.dialogHead}><div><span>插件内协作</span><h2>通知中心</h2></div><button aria-label="关闭" onClick={close}>×</button></div>{notifications.length === 0 ? <div className={css.emptyPanel}><strong>没有新通知</strong><p>提及、回复、指派和状态变化会出现在这里。</p></div> : <div className={css.notificationList}>{notifications.map(item => <article className={item.readAt ? '' : css.unreadNotification} key={item.id}><button onClick={() => { markRead(item); open(item) }}><strong>{item.message}</strong><span title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</span></button>{!item.readAt && <button onClick={() => markRead(item)}>标为已读</button>}</article>)}</div>}</AccessibleDialog> }
function MyWorkDialog({ items, notifications, close, openItem, openNotification }: { items: MyActionItem[]; notifications: Notification[]; close: () => void; openItem: (item: MyActionItem) => void; openNotification: (item: Notification) => void }) {
  const unread = notifications.filter(item => item.readAt === undefined)
  return <AccessibleDialog title="我的工作" close={close} className={css.notificationDialog}><div className={css.dialogHead}><div><span>跨需求个人工作台</span><h2>我的工作</h2></div><button aria-label="关闭" onClick={close}>×</button></div><div className={css.myWorkSummary}><span><b>{items.length}</b> 个待办</span><span><b>{unread.length}</b> 条未读</span></div>{items.length === 0 && unread.length === 0 ? <div className={css.emptyPanel}><strong>当前没有需要你处理的事项</strong><p>指派、提及、回复和待确认项会跨需求汇总到这里。</p></div> : <div className={css.myWorkList}>{items.map(item => <button key={`${item.category}-${item.id}`} onClick={() => openItem(item)}><span>{item.blocking ? '优先处理' : '普通'}</span><strong>{item.requirementTitle} · {taskTypeLabel[item.type]}</strong><small title={new Date(item.updatedAt).toLocaleString()}>{stageLabel(item.dueStage)}前 · {relativeTime(item.updatedAt)}</small></button>)}{unread.map(item => <button key={item.id} onClick={() => openNotification(item)}><span>{item.kind === 'mention' ? '@ 提及' : item.kind === 'assignment' ? '指派' : '未读通知'}</span><strong>{item.message}</strong><small title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</small></button>)}</div>}</AccessibleDialog>
}
