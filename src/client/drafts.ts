import type { DraftRecord } from '../protocol.ts'

const DATABASE = 'dsh-spec-collab'
const STORE = 'drafts'
const FALLBACK = 'dsh-spec-collab.draft.'

export function draftKey(requirementId: string, participantId: string): string { return `${requirementId}:${participantId}` }

export async function loadDraft(requirementId: string, participantId: string): Promise<DraftRecord | undefined> {
  const key = draftKey(requirementId, participantId)
  if (typeof indexedDB === 'undefined') return fallbackRead(key)
  try { return await request<DraftRecord | undefined>('readonly', store => store.get(key)) } catch { return fallbackRead(key) }
}

export async function saveDraft(record: DraftRecord): Promise<void> {
  const key = draftKey(record.requirementId, record.participantId)
  if (typeof indexedDB === 'undefined') return fallbackWrite(key, record)
  try { await request('readwrite', store => store.put(record, key)) } catch { fallbackWrite(key, record) }
}

export async function deleteDraft(requirementId: string, participantId: string): Promise<void> {
  const key = draftKey(requirementId, participantId)
  localStorage.removeItem(`${FALLBACK}${key}`)
  if (typeof indexedDB === 'undefined') return
  try { await request('readwrite', store => store.delete(key)) } catch {}
}

function request<T = undefined>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open(DATABASE, 1)
    opening.onupgradeneeded = () => { if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE) }
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const transaction = opening.result.transaction(STORE, mode); const result = operation(transaction.objectStore(STORE))
      result.onerror = () => reject(result.error)
      result.onsuccess = () => resolve(result.result as T)
      transaction.oncomplete = () => opening.result.close()
    }
  })
}

function fallbackRead(key: string): DraftRecord | undefined { try { return JSON.parse(localStorage.getItem(`${FALLBACK}${key}`) ?? '') as DraftRecord } catch { return undefined } }
function fallbackWrite(key: string, record: DraftRecord): void { localStorage.setItem(`${FALLBACK}${key}`, JSON.stringify(record)) }

export function truncateGraphemes(value: string, max: number): string {
  const Segmenter = (Intl as unknown as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter
  const parts = Segmenter ? [...new Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value)].map(item => item.segment) : Array.from(value)
  return parts.length <= max ? value : `${parts.slice(0, max).join('')}…`
}

export function safeHttpUrl(value: string): string | undefined { try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined } catch { return undefined } }
