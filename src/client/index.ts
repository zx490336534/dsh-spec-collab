import type { Context } from '@deepseek-ai/cordis'
import { SpecApi } from './api.ts'
import { mountSidebarEntry, mountWorkbench } from './mount.tsx'

export function apply(ctx: Context): void {
  const api = new SpecApi()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(), mountWorkbench(api))
  } catch (error) {
    console.error('[dsh-spec-collab] UI mount failed', error)
  }
  ctx.effect(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'spec-collab: ui mounts')
}
