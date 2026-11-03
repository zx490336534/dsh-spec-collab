export interface SidebarAnchor {
  element: HTMLButtonElement
  placement: 'before' | 'after'
}

function exactTextButton(document: Document, text: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.trim() === text)
}

export function findSidebarAnchor(document: Document): SidebarAnchor | undefined {
  const skillCenter = document.querySelector<HTMLButtonElement>('button[aria-label="技能中心"]') ?? exactTextButton(document, '技能中心')
  if (skillCenter !== undefined && skillCenter !== null) return { element: skillCenter, placement: 'after' }
  const plugins = document.querySelector<HTMLButtonElement>('button[aria-label="插件"], button[aria-label="Plugins"]') ?? exactTextButton(document, '插件') ?? exactTextButton(document, 'Plugins')
  if (plugins !== undefined && plugins !== null) return { element: plugins, placement: 'after' }
  const settings = document.querySelector<HTMLButtonElement>('button[aria-label="设置"]') ?? exactTextButton(document, '设置')
  if (settings !== undefined && settings !== null) return { element: settings, placement: 'before' }
  return undefined
}
