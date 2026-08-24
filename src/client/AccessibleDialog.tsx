import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import css from './workbench.module.css'

export function AccessibleDialog({ title, close, children, className = '', dismissOnBackdrop = true }: { title: string; close?: (() => void) | undefined; children: ReactNode; className?: string | undefined; dismissOnBackdrop?: boolean | undefined }) {
  const titleId = useId(); const dialogRef = useRef<HTMLDivElement>(null); const restoreRef = useRef<{ element: HTMLElement; ariaLabel?: string; text?: string } | null>(null); const closeRef = useRef(close)
  closeRef.current = close
  if (restoreRef.current === null && typeof document !== 'undefined' && document.activeElement instanceof HTMLElement) {
    const active = document.activeElement
    restoreRef.current = { element: active, ...(active.getAttribute('aria-label') ? { ariaLabel: active.getAttribute('aria-label')! } : {}), ...(active.textContent?.trim() ? { text: active.textContent.trim() } : {}) }
  }
  useEffect(() => {
    const dialog = dialogRef.current
    const focusable = dialog?.querySelector<HTMLElement>('[autofocus], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)') ?? dialog?.querySelector<HTMLElement>('button:not(:disabled), [tabindex]:not([tabindex="-1"])')
    window.setTimeout(() => focusable?.focus(), 0)
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && closeRef.current) { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab' || !dialog) return
      const items = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
      if (items.length === 0) { event.preventDefault(); dialog.focus(); return }
      const first = items[0]!; const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('keydown', keydown)
      const restore = restoreRef.current
      const focusRestoreTarget = (): void => {
        const candidates = [...document.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        const fallback = candidates.find(item => restore?.ariaLabel && item.getAttribute('aria-label') === restore.ariaLabel)
          ?? candidates.find(item => restore?.text && item.textContent?.trim() === restore.text)
          ?? (restore?.element.isConnected ? restore.element : undefined)
        fallback?.focus()
      }
      focusRestoreTarget()
      window.setTimeout(() => { if (document.activeElement === document.body) focusRestoreTarget() }, 0)
      window.setTimeout(() => { if (document.activeElement === document.body) focusRestoreTarget() }, 50)
    }
  }, [])
  return createPortal(<div data-dsh-spec-collab-portal className={css.modal} onMouseDown={event => { if (dismissOnBackdrop && close && event.target === event.currentTarget) close() }}><div ref={dialogRef} className={className} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}><h2 id={titleId} className={css.srOnly}>{title}</h2>{children}</div></div>, document.body)
}
