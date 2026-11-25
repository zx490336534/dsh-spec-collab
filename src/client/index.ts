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

export function apply(ctx: Context): void {
  const api = new SpecApi()
  const { slots, layout } = ctx as Context & { slots: ClientSlots; layout: ClientLayout }

  const Panel = () => createElement('div', { className: css.nativeView, 'data-dsh-spec-collab-view': '' },
    createElement(SpecWorkbench, { api, onClose: () => layout.selectPanel(null) }))
  const Icon = ({ size }: { size: number }) => createElement('span', { 'aria-hidden': true, style: { fontSize: size } }, '▤')
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({ name: 'sidebar.panellist', id: panelId, order: 6, label: '需求讨论' }, Icon)), 'spec-collab: sidebar')
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
