import type { Root } from 'react-dom/client'
import { createRoot } from 'react-dom/client'
import type { SpecApi } from './api.ts'
import { SpecWorkbench } from './SpecWorkbench.tsx'
import css from './workbench.module.css'
import { findSidebarAnchor } from './sidebar-anchor.ts'

const ACTIVE = 'data-dsh-spec-collab-active'
const VIEW = '[data-dsh-spec-collab-view]'
const ACTIVATE_EVENT = 'dsh-panel-activate'

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
    root.render(<SpecWorkbench api={api} />)
  }
  const observer = new MutationObserver(ensure)
  observer.observe(document.body, { childList: true, subtree: true })
  ensure()
  return () => { observer.disconnect(); document.documentElement.removeAttribute(ACTIVE); root?.unmount(); container?.remove() }
}

export function mountSidebarEntry(): () => void {
  let row: HTMLButtonElement | undefined
  const close = (): void => { document.documentElement.removeAttribute(ACTIVE); row?.classList.remove(css.entryActive!) }
  const closeOnExternalNavigation = (event: MouseEvent): void => {
    if (!document.documentElement.hasAttribute(ACTIVE)) return
    const target = event.target instanceof Element ? event.target : undefined
    if (target?.closest(VIEW) || target?.closest('[data-dsh-spec-collab-entry]')) return
    close()
  }
  document.addEventListener('click', closeOnExternalNavigation, true)
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
  }
  const ensure = (): void => {
    if (row?.isConnected) return
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
  }
  const observer = new MutationObserver(ensure)
  observer.observe(document.body, { childList: true, subtree: true })
  ensure()
  return () => { observer.disconnect(); document.removeEventListener('click', closeOnExternalNavigation, true); close(); row?.remove(); document.querySelector(VIEW)?.remove() }
}
