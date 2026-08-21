import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { SpecApi } from './api.ts'
import { mountSidebarEntry, mountWorkbench } from './mount.tsx'

export const inject = ['sessions']

export function apply(ctx: ClientContext): void {
  const api = new SpecApi()
  const disposers: Array<() => void> = []
  try {
    disposers.push(mountSidebarEntry(), mountWorkbench(api))
  } catch (error) {
    console.error('[dsh-spec-collab] UI mount failed', error)
  }
  ctx.effect(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'spec-collab: ui mounts')
}
