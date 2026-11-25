// @vitest-environment jsdom

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserUuid } from '../src/client/browser-uuid.ts'
import * as client from '../src/client/index.ts'

async function mountClient(hash = '') {
  history.replaceState(null, '', `/${hash}`)
  const ctx = new Context()
  const entries = new Map<string, { key?: string; id?: string; label?: string }>()
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel })
  ctx.provide('slots', {
    inject: (_owner: string, register: () => () => void) => register(),
    register: ({ name, ...entry }: { name: string; key?: string; id?: string; label?: string }) => {
      entries.set(name, entry)
      return () => entries.delete(name)
    },
  })
  const fiber = await ctx.plugin(client)
  return { entries, selectPanel, dispose: async () => { await fiber.dispose(); await ctx.fiber.dispose() } }
}

describe('browser compatibility', () => {
  afterEach(() => {
    history.replaceState(null, '', '/')
    vi.useRealTimers()
  })

  it('generates a UUID v4 when randomUUID is unavailable', () => {
    const source = { getRandomValues<T extends ArrayBufferView | null>(array: T): T { if (array instanceof Uint8Array) array.fill(0x2a); return array } }
    expect(browserUuid(source)).toBe('2a2a2a2a-2a2a-4a2a-aa2a-2a2a2a2a2a2a')
  })

  it('adds one global panel and releases it without taking ownership of the sidebar', async () => {
    const { entries, dispose } = await mountClient()
    try {
      expect([...entries.keys()].sort()).toEqual(['main', 'sidebar.panellist'])
      expect(entries.get('main')).toMatchObject({ key: 'spec-collab' })
      expect(entries.get('sidebar.panellist')).toMatchObject({ id: 'spec-collab', label: '需求讨论' })
    } finally { await dispose() }
    expect(entries.size).toBe(0)
  })

  it('opens only Spec deep links in the registered native panel', async () => {
    vi.useFakeTimers()
    const { selectPanel, dispose } = await mountClient('#spec-collab/demo-123/tasks')
    try {
      await vi.runAllTimersAsync()
      expect(selectPanel).toHaveBeenCalledWith('spec-collab')
      selectPanel.mockClear()
      history.replaceState(null, '', '/#other')
      window.dispatchEvent(new HashChangeEvent('hashchange'))
      expect(selectPanel).not.toHaveBeenCalled()
    } finally { await dispose() }
    history.replaceState(null, '', '/#spec-collab/demo-123/tasks')
    window.dispatchEvent(new HashChangeEvent('hashchange'))
    expect(selectPanel).not.toHaveBeenCalled()
  })
})
