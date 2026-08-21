import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CollaborationEngine } from './engine.ts'
import { API_PREFIX, parseEnvelope } from './protocol.ts'
import type { DshReviewCoordinator } from './review-runtime.ts'

const BODY_LIMIT = 2 * 1024 * 1024
const HEARTBEAT_MS = 15_000
function json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(JSON.stringify(body)) }
function trusted(req: IncomingMessage): boolean { const remote = req.socket.remoteAddress; if (!(remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1')) return false; if (req.headers['sec-fetch-site'] === 'cross-site') return false; const origin = req.headers.origin; if (origin === undefined) return req.headers['sec-fetch-site'] === 'same-origin'; try { return new URL(origin).host === req.headers.host } catch { return false } }
async function readJson(req: IncomingMessage): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of req) { const buffer = chunk as Buffer; size += buffer.length; if (size > BODY_LIMIT) throw new Error('body-too-large'); chunks.push(buffer) } return JSON.parse(Buffer.concat(chunks).toString('utf8')) }

export function makeRoutes(engine: CollaborationEngine, coordinator: DshReviewCoordinator): WebRoute[] {
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => { if (trusted(req)) return true; json(res, 403, { ok: false, error: 'forbidden' }); return false }
  return [
    { kind: 'exact', path: `${API_PREFIX}/state`, handler: (req, res) => { if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' }); if (!guard(req, res)) return; const state = engine.snapshot(); json(res, 200, { revision: state.revision, participants: state.participants, requirements: engine.list() }) } },
    { kind: 'exact', path: `${API_PREFIX}/review-workspaces`, handler: async (req, res) => { if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' }); if (!guard(req, res)) return; try { json(res, 200, { ok: true, workspaces: await coordinator.reviewWorkspaces() }) } catch (error) { json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) } } },
    { kind: 'exact', path: `${API_PREFIX}/version`, handler: (req, res) => { if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' }); if (!guard(req, res)) return; try { const url = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`); const requirementId = url.searchParams.get('requirementId') ?? ''; const commit = url.searchParams.get('commit') ?? ''; json(res, 200, { ok: true, version: engine.version(requirementId, commit) }) } catch (error) { json(res, 404, { ok: false, error: error instanceof Error ? error.message : String(error) }) } } },
    { kind: 'exact', path: `${API_PREFIX}/my-items`, handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!guard(req, res)) return
      const url = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`)
      const participantId = url.searchParams.get('participantId') ?? ''
      const role = url.searchParams.get('role')
      if (participantId.length < 8 || (role !== 'product' && role !== 'engineering')) return json(res, 400, { ok: false, error: 'invalid-participant-query' })
      return json(res, 200, { ok: true, items: engine.myItems({ participantId, nickname: '当前参与者', role, kind: 'human' }) })
    } },
    { kind: 'exact', path: `${API_PREFIX}/action`, handler: async (req, res) => { if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' }); if (!guard(req, res)) return; if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(res, 415, { ok: false, error: 'json-required' }); try { const envelope = parseEnvelope(await readJson(req)); if (envelope === undefined) return json(res, 400, { ok: false, error: 'invalid-action' }); if ((envelope.action.kind === 'requirement.create' || envelope.action.kind === 'requirement.bind-workspace') && typeof envelope.action.workspaceId === 'string' && envelope.action.workspaceId.trim() !== '') await coordinator.assertWorkspaceAvailable(envelope.action.workspaceId); const result = engine.apply(envelope.requestId, envelope.action); json(res, result.ok ? 200 : result.error === 'base-commit-conflict' ? 409 : 400, result) } catch (error) { const message = error instanceof Error ? error.message : String(error); json(res, message === 'body-too-large' ? 413 : 400, { ok: false, error: message }) } } },
    { kind: 'exact', path: `${API_PREFIX}/ai-conversation`, handler: async (req, res) => {
      if (!guard(req, res)) return
      try {
        if (req.method === 'GET') {
          const url = new URL(req.url ?? '', `http://${req.headers.host ?? '127.0.0.1'}`)
          const requirementId = url.searchParams.get('requirementId') ?? ''
          const sessionId = url.searchParams.get('sessionId') ?? ''
          if (!engine.hasAiSession(requirementId, sessionId)) return json(res, 404, { ok: false, error: 'AI 会话不属于该需求' })
          return json(res, 200, { ok: true, messages: await coordinator.conversation(sessionId) })
        }
        if (req.method === 'POST') {
          if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return json(res, 415, { ok: false, error: 'json-required' })
          const body = await readJson(req) as { requirementId?: unknown; sessionId?: unknown; text?: unknown }
          if (typeof body.requirementId !== 'string' || typeof body.sessionId !== 'string' || typeof body.text !== 'string') return json(res, 400, { ok: false, error: 'invalid-follow-up' })
          if (!engine.hasAiSession(body.requirementId, body.sessionId)) return json(res, 404, { ok: false, error: 'AI 会话不属于该需求' })
          await coordinator.followUp(body.sessionId, body.text)
          return json(res, 202, { ok: true })
        }
        return json(res, 405, { ok: false, error: 'method-not-allowed' })
      } catch (error) { return json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
    } },
    { kind: 'exact', path: `${API_PREFIX}/events`, handler: (req, res) => { if (req.method !== 'GET') { res.writeHead(405); res.end(); return } if (!guard(req, res)) return; res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' }); const push = (): void => { res.write(`data: ${JSON.stringify({ revision: engine.snapshot().revision })}\n\n`) }; const unsubscribe = engine.subscribe(push); const heartbeat = setInterval(() => { res.write(': ping\n\n') }, HEARTBEAT_MS); const close = (): void => { clearInterval(heartbeat); unsubscribe() }; req.once('close', close); res.once('close', close); push() } },
  ]
}
