export function fakeClient(opts: {
  messages?: any[]; failMessages?: boolean
  /** Messages per session id; overrides `messages` for listed sessions. */
  messagesBySession?: Record<string, any[]>
  /** parentID per session id (I9: subagent chains). */
  parents?: Record<string, string>
  failGet?: boolean
} = {}) {
  const calls = { prompt: [] as any[], toast: [] as any[], messages: [] as string[], get: [] as string[], log: [] as any[] }
  const client = {
    session: {
      get: async (o: any) => {
        const id = o?.path?.id
        calls.get.push(id)
        if (opts.failGet) return { error: { message: "get boom" } }
        return { data: { id, ...(opts.parents?.[id] ? { parentID: opts.parents[id] } : {}) } }
      },
      messages: async (o: any) => {
        calls.messages.push(o?.path?.id)
        if (opts.failMessages) return { error: { message: "boom" } }
        const bySession = opts.messagesBySession?.[o?.path?.id]
        return { data: bySession ?? opts.messages ?? [] }
      },
      prompt: async (o: any) => { calls.prompt.push(o); return { data: {} } },
    },
    tui: { showToast: async (o: any) => { calls.toast.push(o); return { data: true } } },
    app: { log: async (o: any) => { calls.log.push(o); return { data: true } } },
  }
  return { client, calls }
}

let seq = 0
export function userMsg(text: string, opts: { synthetic?: boolean; created?: number } = {}) {
  const id = `u${++seq}`
  return { info: { id, sessionID: "s1", role: "user", time: { created: opts.created ?? seq } }, parts: [{ id: `${id}p`, sessionID: "s1", messageID: id, type: "text", text, synthetic: opts.synthetic }] }
}
export function assistantMsg(text: string, opts: { id?: string; tool?: string; output?: string; created?: number } = {}) {
  const id = opts.id ?? `a${++seq}`
  const parts: any[] = [{ id: `${id}p`, sessionID: "s1", messageID: id, type: "text", text }]
  if (opts.tool) parts.push({ id: `${id}t`, sessionID: "s1", messageID: id, type: "tool", callID: "c1", tool: opts.tool, state: opts.output === undefined ? { status: "pending", input: {} } : { status: "completed", input: {}, output: opts.output, title: "t", metadata: {}, time: { start: 1, end: 2 } } })
  return { info: { id, sessionID: "s1", role: "assistant", time: { created: opts.created ?? seq } }, parts }
}
