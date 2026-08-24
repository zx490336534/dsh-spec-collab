import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import type { SpecApi } from './api.ts'
import { SpecWorkbench } from './SpecWorkbench.tsx'
import css from './workbench.module.css'
import { findSidebarAnchor } from './sidebar-anchor.ts'

const ACTIVE = 'data-dsh-spec-collab-active'
const VIEW = '[data-dsh-spec-collab-view]'
const ACTIVATE_EVENT = 'dsh-panel-activate'
const CLOSE_EVENT = 'dsh-spec-collab-close'
const SIDEBAR_COLLAPSED = 'data-sidebar-collapsed'

function isSidebarChromeControl(target: Element | undefined): boolean {
  const control = target?.closest<HTMLElement>('button, [role="button"]')
  if (control === undefined || control === null) return false
  const label = [control.getAttribute('aria-label'), control.getAttribute('title'), control.textContent].filter(Boolean).join(' ')
  return /侧边栏|边栏|侧栏|sidebar/i.test(label) && /收起|折叠|展开|隐藏|显示|collapse|expand|toggle/i.test(label)
}

export function mountWorkbench(api: SpecApi): () => void {
  let root: Root | undefined
  let container: HTMLDivElement | undefined
  const ensure = (): void => {
    if (container?.isConnected) return
    root?.unmount()
    container?.remove()
    const column = document.querySelector<HTMLElement>('[data-pane="conversation"], [class*="centerCol"]')
    if (column === null) return
    container = document.createElement('div')
    container.dataset.dshSpecCollabView = ''
    container.className = css.view!
    column.appendChild(container)
    root = createRoot(container)
    root.render(<SpecWorkbench api={api} onClose={() => document.dispatchEvent(new CustomEvent(CLOSE_EVENT))} />)
  }
  const observer = new MutationObserver(ensure)
  observer.observe(document.body, { childList: true, subtree: true })
  ensure()
  return () => { observer.disconnect(); document.documentElement.removeAttribute(ACTIVE); root?.unmount(); container?.remove() }
}

export function mountSidebarEntry(): () => void {
  let row: HTMLButtonElement | undefined
  let resizeObserver: ResizeObserver | undefined
  const syncSidebarState = (): void => {
    if (!row?.isConnected) return
    const rect = row.getBoundingClientRect()
    const hostCollapsed = document.body.hasAttribute('data-dsh-sidebar-collapsed') || Boolean(row.closest('[data-sidebar-collapsed="true"]'))
    row.toggleAttribute('data-dsh-spec-collab-collapsed', rect.width > 0 ? rect.width < 64 : hostCollapsed)
  }
  const close = (): void => { document.documentElement.removeAttribute(ACTIVE); row?.classList.remove(css.entryActive!) }
  const closeOnExternalNavigation = (event: MouseEvent): void => {
    if (!document.documentElement.hasAttribute(ACTIVE)) return
    const target = event.target instanceof Element ? event.target : undefined
    if (target?.closest(VIEW) || target?.closest('[data-dsh-spec-collab-entry]')) return
    if (isSidebarChromeControl(target)) return
    const sidebarCollapsedBefore = document.documentElement.getAttribute(SIDEBAR_COLLAPSED)
    window.setTimeout(() => {
      if (!document.documentElement.hasAttribute(ACTIVE)) return
      if (document.documentElement.getAttribute(SIDEBAR_COLLAPSED) !== sidebarCollapsedBefore) return
      close()
    }, 0)
  }
  document.addEventListener('click', closeOnExternalNavigation, true)
  document.addEventListener(CLOSE_EVENT, close)
  const toggle = (): void => {
    const opening = !document.documentElement.hasAttribute(ACTIVE)
    for (const name of document.documentElement.getAttributeNames()) {
      if (name.startsWith('data-dsh-') && name.endsWith('-active')) document.documentElement.removeAttribute(name)
    }
    if (opening) {
      document.documentElement.setAttribute(ACTIVE, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'spec-collab' }))
    }
    row?.classList.toggle(css.entryActive!, opening)
    syncSidebarState()
  }
  const ensure = (): void => {
    if (row?.isConnected) { syncSidebarState(); return }
    const anchor = findSidebarAnchor(document)
    if (anchor === undefined) return
    row = document.createElement('button')
    row.type = 'button'
    row.dataset.dshSpecCollabEntry = ''
    row.className = `${anchor.element.className} ${css.entry!}`
    row.title = '需求讨论'
    row.setAttribute('aria-label', '需求讨论')
    row.innerHTML = '<span aria-hidden="true">▤</span><span>需求讨论</span>'
    row.addEventListener('click', toggle)
    anchor.element[anchor.placement](row)
    resizeObserver?.disconnect()
    resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(syncSidebarState)
    resizeObserver?.observe(row)
    window.setTimeout(syncSidebarState, 0)
  }
  const observer = new MutationObserver(() => { ensure(); syncSidebarState() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-dsh-sidebar-collapsed', 'data-sidebar-collapsed'] })
  ensure()
  return () => { observer.disconnect(); resizeObserver?.disconnect(); document.removeEventListener('click', closeOnExternalNavigation, true); document.removeEventListener(CLOSE_EVENT, close); close(); row?.remove(); document.querySelector(VIEW)?.remove() }
}
