import { createInterface } from 'node:readline'

const sections = ['spec', 'review-items', 'patches', 'comments', 'decisions', 'confirmations', 'sources', 'readiness', 'ready']
export const tools = [
  {
    name: 'spec_workbench',
    description: 'Open the local Spec Collab workbench. Optionally register the current Codex project using its absolute directory path.',
    inputSchema: { type: 'object', properties: { workspacePath: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'spec_list',
    description: 'List Spec requirements with their current Git commit, workflow stage and risk count.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'spec_read',
    description: 'Read a requirement at its exact current commit, optionally selecting which sections to return. Includes a link to its workbench.',
    inputSchema: {
      type: 'object',
      properties: { requirementId: { type: 'string' }, include: { type: 'array', items: { type: 'string', enum: sections } } },
      required: ['requirementId'],
      additionalProperties: false,
    },
  },
] as const

export function validToolArgs(name: string, args: unknown): asserts args is { workspacePath?: string; requirementId?: string; include?: string[] } {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象')
  const fields = args as Record<string, unknown>
  const tool = tools.find(entry => entry.name === name)
  if (!tool || Object.keys(fields).some(key => !Object.hasOwn(tool.inputSchema.properties, key))) throw new Error('工具或参数无效')
  if (fields.workspacePath !== undefined && (typeof fields.workspacePath !== 'string' || !fields.workspacePath.trim())) {
    throw new Error('工作区路径需要是非空的绝对路径')
  }
  if (name === 'spec_read' && (typeof fields.requirementId !== 'string' || !fields.requirementId.trim())) throw new Error('请提供需求 ID')
  const include = fields.include
  if (include !== undefined && (!Array.isArray(include) || include.some(section => !sections.includes(section)))) throw new Error('读取栏目无效')
}

export function startMcp(call: (name: string, args: unknown) => Promise<unknown>): void {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const send = (payload: unknown): void => { process.stdout.write(JSON.stringify(payload) + '\n') }
  lines.on('line', line => { void handle(line) })
  async function handle(line: string): Promise<void> {
    let id: unknown = null
    try {
      const message = JSON.parse(line)
      if ('id' in message) id = message.id
      else return
      if (message.jsonrpc !== '2.0') {
        send({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid request' } })
        return
      }
      let result: unknown
      if (message.method === 'initialize') {
        const requested = message.params?.protocolVersion
        const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']
        result = { protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
          capabilities: { tools: {} }, serverInfo: { name: 'spec-collab', version: '0.1.0' } }
      } else if (message.method === 'ping') result = {}
      else if (message.method === 'tools/list') result = { tools }
      else if (message.method === 'tools/call') {
        try {
          const value = await call(message.params?.name, message.params?.arguments ?? {})
          result = { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
        } catch (error) {
          result = { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] }
        }
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown method' } })
        return
      }
      send({ jsonrpc: '2.0', id, result })
    } catch {
      send({ jsonrpc: '2.0', id, error: { code: -32700, message: 'Invalid JSON-RPC message' } })
    }
  }
}
