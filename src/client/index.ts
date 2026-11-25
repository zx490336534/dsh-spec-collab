import type { Context } from '@deepseek-ai/cordis'
import { createElement, type ComponentType } from 'react'
import { SpecApi } from './api.ts'
import { SpecWorkbench } from './SpecWorkbench.tsx'
import css from './workbench.module.css'

const panelId = 'spec-collab'
export const inject = ['slots', 'layout']

interface ClientLayout { selectPanel: (id: string | null) => void }
interface ClientSlots {
  inject: (owner: 'main' | 'sidebar.panellist', setup: () => () => void) => () => void
  register(options: { name: 'main'; key: string }, component: ComponentType): () => void
  register(options: { name: 'sidebar.panellist'; id: string; order: number; label: string }, component: ComponentType<{ size: number }>): () => void
}

function SpecPanelIcon({ size }: { size: number }) {
  return createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    focusable: false,
  },
  createElement('path', { d: 'M10 20.5H6.5a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2H13l5 5v1.25M13 3.5V7a1.5 1.5 0 0 0 1.5 1.5H18M8 11h3M8 14.75h1.5' }),
  createElement('path', { d: 'M15 12.5h4a2.5 2.5 0 0 1 2.5 2.5v2a2.5 2.5 0 0 1-2.5 2.5h-2.5l-3 2v-2.5a2.5 2.5 0 0 1-1-2v-2a2.5 2.5 0 0 1 2.5-2.5ZM15.5 16h3' }))
}

export function apply(ctx: Context): void {
  const api = new SpecApi()
  const { slots, layout } = ctx as Context & { slots: ClientSlots; layout: ClientLayout }

  const Panel = () => createElement('div', { className: css.nativeView, 'data-dsh-spec-collab-view': '' },
    createElement(SpecWorkbench, { api, onClose: () => layout.selectPanel(null) }))
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: panelId, order: 6, label: '需求讨论' }, SpecPanelIcon)), 'spec-collab: sidebar')
  ctx.effect(() => slots.inject('main', () => {
    const dispose = slots.register({ name: 'main', key: panelId }, Panel)
    const openDeepLink = (): void => {
      if (location.hash.startsWith('#spec-collab/')) layout.selectPanel(panelId)
    }
    const frame = requestAnimationFrame(openDeepLink)
    window.addEventListener('hashchange', openDeepLink)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('hashchange', openDeepLink)
      dispose()
    }
  }), 'spec-collab: main panel')
}
