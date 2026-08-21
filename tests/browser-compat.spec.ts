// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { browserUuid } from '../src/client/browser-uuid.ts'
import { findSidebarAnchor } from '../src/client/sidebar-anchor.ts'

describe('browser compatibility', () => {
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
})
