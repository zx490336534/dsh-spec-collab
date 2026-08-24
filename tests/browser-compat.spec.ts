// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserUuid } from '../src/client/browser-uuid.ts'
import { mountSidebarEntry } from '../src/client/mount.tsx'
import { findSidebarAnchor } from '../src/client/sidebar-anchor.ts'

describe('browser compatibility', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    document.documentElement.removeAttribute('data-dsh-spec-collab-active')
    document.documentElement.removeAttribute('data-sidebar-collapsed')
    document.body.removeAttribute('data-dsh-sidebar-collapsed')
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('generates a UUID v4 when randomUUID is unavailable', () => {
    const source = { getRandomValues<T extends ArrayBufferView | null>(array: T): T { if (array instanceof Uint8Array) array.fill(0x2a); return array } }
    expect(browserUuid(source)).toBe('2a2a2a2a-2a2a-4a2a-aa2a-2a2a2a2a2a2a')
  })

  it('places the entry after skill center when available', () => {
    document.body.innerHTML = '<button aria-label="技能中心">技能中心</button><button>设置</button>'
    expect(findSidebarAnchor(document)).toMatchObject({ placement: 'after', element: document.querySelector('[aria-label="技能中心"]') })
  })

  it('falls back to placing the entry before settings', () => {
    document.body.innerHTML = '<button>新会话</button><button class="settings">设置</button>'
    expect(findSidebarAnchor(document)).toMatchObject({ placement: 'before', element: document.querySelector('.settings') })
  })

  it('keeps the workbench open when collapsing the host sidebar', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<button aria-label="技能中心">技能中心</button><button class="sidebarToggle">≡</button>'
    const dispose = mountSidebarEntry()
    try {
      document.querySelector<HTMLButtonElement>('[data-dsh-spec-collab-entry]')?.click()
      expect(document.documentElement.hasAttribute('data-dsh-spec-collab-active')).toBe(true)

      const toggle = document.querySelector<HTMLButtonElement>('.sidebarToggle')!
      toggle.addEventListener('click', () => document.documentElement.setAttribute('data-sidebar-collapsed', 'true'))
      toggle.click()
      await vi.runAllTimersAsync()

      expect(document.documentElement.hasAttribute('data-dsh-spec-collab-active')).toBe(true)
    }
    finally {
      dispose()
    }
  })

  it('does not mark the entry collapsed from unrelated host class names', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return { x: 0, y: 0, top: 0, left: 0, right: 240, bottom: 32, width: this.hasAttribute('data-dsh-spec-collab-entry') ? 240 : 0, height: 32, toJSON: () => ({}) } as DOMRect
    })
    document.body.innerHTML = '<div class="details_collapsed"><button aria-label="技能中心">技能中心</button></div>'
    const dispose = mountSidebarEntry()
    try {
      await vi.runAllTimersAsync()
      const entry = document.querySelector<HTMLButtonElement>('[data-dsh-spec-collab-entry]')!
      expect(entry.hasAttribute('data-dsh-spec-collab-collapsed')).toBe(false)
      expect(entry.textContent).toContain('需求讨论')
    }
    finally {
      dispose()
    }
  })

  it('marks the entry collapsed only when the rail is narrow', async () => {
    vi.useFakeTimers()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function getRect(this: HTMLElement) {
      return { x: 0, y: 0, top: 0, left: 0, right: 35, bottom: 32, width: this.hasAttribute('data-dsh-spec-collab-entry') ? 35 : 0, height: 32, toJSON: () => ({}) } as DOMRect
    })
    document.body.innerHTML = '<button aria-label="技能中心">技能中心</button>'
    const dispose = mountSidebarEntry()
    try {
      await vi.runAllTimersAsync()
      expect(document.querySelector<HTMLButtonElement>('[data-dsh-spec-collab-entry]')?.hasAttribute('data-dsh-spec-collab-collapsed')).toBe(true)
    }
    finally {
      dispose()
    }
  })

  it('still closes the workbench on ordinary external navigation', async () => {
    vi.useFakeTimers()
    document.body.innerHTML = '<button aria-label="技能中心">技能中心</button><button class="conversation">普通会话</button>'
    const dispose = mountSidebarEntry()
    try {
      document.querySelector<HTMLButtonElement>('[data-dsh-spec-collab-entry]')?.click()
      expect(document.documentElement.hasAttribute('data-dsh-spec-collab-active')).toBe(true)

      document.querySelector<HTMLButtonElement>('.conversation')?.click()
      await vi.runAllTimersAsync()

      expect(document.documentElement.hasAttribute('data-dsh-spec-collab-active')).toBe(false)
    }
    finally {
      dispose()
    }
  })
})
