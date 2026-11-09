// ── DeepSeek Web 协议层（移植自 ds-free-api ds_core，GPL 注意：行为对齐、代码重写） ──

export const API_BASE = "https://chat.deepseek.com/api/v0"
export const WASM_URL = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm"
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

const BIZ_CODE_MESSAGES: Record<number, string> = {
  5: "账号被禁言（user is muted）",
  10: "账号被封禁（USER_IS_BANNED）",
  11: "设备风控（RISK_DEVICE_DETECTED），需要真实 device_id",
}

export class DeepseekError extends Error {
  code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

export type Credentials = { userToken: string; deviceId: string }

export interface Challenge {
  algorithm: string
  challenge: string
  salt: string
  signature: string
  difficulty: number
  expire_at: number
  target_path: string
}

export interface PowResult {
  algorithm: string
  challenge: string
  salt: string
  answer: number
  signature: string
  target_path: string
}

export function clientHeaders(deviceId: string, referer = "https://chat.deepseek.com/") {
  return {
    "user-agent": USER_AGENT,
    "x-client-version": "2.5.0",
    "x-client-platform": "web",
    "x-client-locale": "zh_CN",
    "x-client-bundle-id": "com.deepseek.chat",
    "x-device-id": deviceId,
    "x-device-model": "",
    "x-client-timezone-offset": "28800",
    "accept-language": "zh-CN",
    referer,
    accept: "*/*",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "sec-ch-ua": '"Chromium";v="140", "Not_A Brand";v="24", "Google Chrome";v="140"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
  }
}

function authHeaders(creds: Credentials, powResponse?: string) {
  const headers: Record<string, string> = {
    ...clientHeaders(creds.deviceId),
    authorization: `Bearer ${creds.userToken}`,
  }
  if (powResponse) headers["x-ds-pow-response"] = powResponse
  return headers
}

async function envelope<T>(resp: Response): Promise<T> {
  const body: any = await resp.json().catch(() => null)
  if (!resp.ok || !body) {
    throw new DeepseekError(resp.status, `HTTP ${resp.status}: ${JSON.stringify(body).slice(0, 300)}`)
  }
  if (body.code !== 0) throw new DeepseekError(body.code, body.msg ?? "business error")
  const data = body.data
  if (!data || data.biz_code === undefined) return body as T
  if (data.biz_code !== 0) {
    const hint = BIZ_CODE_MESSAGES[data.biz_code] ?? ""
    throw new DeepseekError(data.biz_code, `${data.biz_msg || "business error"}${hint ? `（${hint}）` : ""}`)
  }
  return data.biz_data as T
}

// ── 账号会话 ──

export async function createChatSession(creds: Credentials) {
  const resp = await fetch(`${API_BASE}/chat_session/create`, {
    method: "POST",
    headers: { ...authHeaders(creds), "content-type": "application/json" },
    body: JSON.stringify({ agent: "chat" }),
  })
  const biz = await envelope<{ chat_session?: { id: number }; id?: number }>(resp)
  return biz.chat_session ?? biz
}

export async function deleteChatSession(creds: Credentials, chatSessionId: string) {
  const resp = await fetch(`${API_BASE}/chat_session/delete`, {
    method: "POST",
    headers: { ...authHeaders(creds), "content-type": "application/json" },
    body: JSON.stringify({ chat_session_id: chatSessionId }),
  })
  return envelope<unknown>(resp)
}

export async function renameChatSession(creds: Credentials, chatSessionId: string, title: string) {
  const resp = await fetch(`${API_BASE}/chat_session/update_title`, {
    method: "POST",
    headers: { ...authHeaders(creds), "content-type": "application/json" },
    body: JSON.stringify({ chat_session_id: chatSessionId, title }),
  })
  return envelope<unknown>(resp)
}

export interface UploadedFile {
  id: string
  status: string
  file_name?: string
  file_size?: number
  is_image?: boolean
}

export async function uploadFile(creds: Credentials, file: { name: string; mime: string; bytes: Uint8Array }) {
  const pow = await createPowChallenge(creds, "/api/v0/file/upload_file")
  const wasm = await loadWasm()
  const result = await solvePoW(pow, wasm)
  const form = new FormData()
  form.append("file", new Blob([file.bytes], { type: file.mime }), file.name)
  const resp = await fetch(`${API_BASE}/file/upload_file`, {
    method: "POST",
    headers: authHeaders(creds, powHeader(result)),
    body: form,
  })
  return envelope<UploadedFile>(resp)
}

export async function fetchFiles(creds: Credentials, fileIds: string[]) {
  const query = fileIds.join(",")
  const resp = await fetch(`${API_BASE}/file/fetch_files?file_ids=${encodeURIComponent(query)}`, {
    headers: authHeaders(creds),
  })
  return envelope<{ files: UploadedFile[] }>(resp)
}

export async function uploadFileAndWait(creds: Credentials, file: { name: string; mime: string; bytes: Uint8Array }, timeoutMs = 15000) {
  const uploaded = await uploadFile(creds, file)
  const deadline = Date.now() + timeoutMs
  let status = uploaded.status
  while (status === "PENDING" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    const batch = await fetchFiles(creds, [uploaded.id])
    status = batch.files?.[0]?.status ?? "PENDING"
  }
  if (status !== "SUCCESS") throw new DeepseekError(-5, `文件解析未完成: ${status}`)
  return uploaded
}

export interface UpstreamSession {
  id: string
  title: string
  updated_at: number
  pinned?: boolean
}

export async function fetchSessions(creds: Credentials, cursor?: { direction: "gte" | "lte"; updatedAt: number; count?: number }) {
  const query = cursor
    ? `?${cursor.direction}_cursor.pinned=false&${cursor.direction}_cursor.updated_at=${cursor.updatedAt}&count=${cursor.count ?? 100}`
    : ""
  const resp = await fetch(`${API_BASE}/chat_session/fetch_page${query}`, {
    headers: authHeaders(creds),
  })
  return envelope<{ chat_sessions: UpstreamSession[]; has_more?: boolean }>(resp)
}

export interface UpstreamMessage {
  message_id: number
  parent_id: number | null
  role: "USER" | "ASSISTANT"
  status: string
  inserted_at: number
  fragments: { type: string; content?: string }[]
}

export async function fetchHistory(creds: Credentials, chatSessionId: string) {
  const query = `?chat_session_id=${encodeURIComponent(chatSessionId)}`
  const resp = await fetch(`${API_BASE}/chat/history_messages${query}`, {
    headers: authHeaders(creds),
  })
  return envelope<{ chat_session: UpstreamSession; chat_messages: UpstreamMessage[] }>(resp)
}

// ── PoW ──

let wasmBytesCache: Uint8Array | undefined

export async function loadWasm() {
  if (!wasmBytesCache) {
    const resp = await fetch(WASM_URL)
    wasmBytesCache = new Uint8Array(await resp.bytes())
  }
  return wasmBytesCache
}

export async function solvePoW(challenge: Challenge, wasmBytes: Uint8Array): Promise<PowResult> {
  const { instance } = await WebAssembly.instantiate(new Uint8Array(wasmBytes), {})
  const ex = instance.exports as any
  const memory: WebAssembly.Memory = ex.memory
  const addStack = ex.__wbindgen_add_to_stack_pointer as (n: number) => number
  const alloc = (ex.__wbindgen_malloc ?? ex.__wbindgen_export_0) as (len: number, align: number) => number
  const solve = ex.wasm_solve as (...args: number[]) => void

  const retptr = addStack(-16)
  const writeString = (s: string) => {
    const bytes = new TextEncoder().encode(s)
    const ptr = alloc(bytes.length, 1)
    new Uint8Array(memory.buffer).set(bytes, ptr)
    return [ptr, bytes.length] as const
  }
  const [cPtr, cLen] = writeString(challenge.challenge)
  const prefix = `${challenge.salt}_${challenge.expire_at}_`
  const [pPtr, pLen] = writeString(prefix)

  solve(retptr, cPtr, cLen, pPtr, pLen, challenge.difficulty)

  const view = new DataView(memory.buffer)
  const status = view.getInt32(retptr, true)
  const answer = view.getFloat64(retptr + 8, true)
  addStack(16)
  if (status === 0) throw new DeepseekError(-2, "PoW 无解")
  return {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  }
}

export function powHeader(result: PowResult) {
  return btoa(JSON.stringify(result))
}

export async function createPowChallenge(creds: Credentials, targetPath: string) {
  const resp = await fetch(`${API_BASE}/chat/create_pow_challenge`, {
    method: "POST",
    headers: { ...authHeaders(creds), "content-type": "application/json" },
    body: JSON.stringify({ target_path: targetPath }),
  })
  const biz = await envelope<{ challenge?: Challenge } & Partial<Challenge>>(resp)
  return biz.challenge ?? (biz as Challenge)
}

// ── HIF 风控令牌 ──

type HifPair = { leim?: string; dliq?: string; leimAt?: number; dliqAt?: number }

export class HifCache {
  private cache: HifPair = {}
  constructor(private creds: Credentials) {}

  private async fetchOne(url: string): Promise<{ value: string; ttl: number }> {
    const resp = await fetch(url, { headers: clientHeaders(this.creds.deviceId) })
    const ttlHeader = resp.headers.get("x-hif-ttl")
    const ttl = ttlHeader ? Number(ttlHeader) || 600 : 600
    const body: any = await resp.json()
    if (body.code !== 0 || body.data?.biz_code !== 0) throw new DeepseekError(-3, "HIF 令牌获取失败")
    return { value: body.data.biz_data.value, ttl }
  }

  async tokens(): Promise<{ leim?: string; dliq?: string }> {
    const margin = 30_000
    const jobs: Promise<void>[] = []
    if (!this.cache.leim || Date.now() - (this.cache.leimAt ?? 0) > 600_000 - margin) {
      jobs.push(
        this.fetchOne("https://hif-leim.deepseek.com/query")
          .then(({ value, ttl }) => {
            this.cache.leim = value
            this.cache.leimAt = Date.now() + ttl - 600_000 + 600_000
          })
          .catch(() => undefined),
      )
    }
    if (!this.cache.dliq || Date.now() - (this.cache.dliqAt ?? 0) > 600_000 - margin) {
      jobs.push(
        this.fetchOne("https://hif-dliq.deepseek.com/query")
          .then(({ value, ttl }) => {
            this.cache.dliq = value
            this.cache.dliqAt = Date.now()
          })
          .catch(() => undefined),
      )
    }
    await Promise.all(jobs)
    return { leim: this.cache.leim, dliq: this.cache.dliq }
  }
}

// ── completion（SSE）──

export interface CompletionPayload {
  chat_session_id: string
  parent_message_id?: number
  model_type: string
  prompt: string
  ref_file_ids: string[]
  thinking_enabled: boolean
  search_enabled: boolean
  action?: unknown
  source: string
  preempt: boolean
}

export async function createCompletionStream(creds: Credentials, payload: CompletionPayload, hif: HifCache) {
  const pow = await createPowChallenge(creds, "/api/v0/chat/completion")
  const wasm = await loadWasm()
  const result = await solvePoW(pow, wasm)
  const tokens = await hif.tokens().catch(() => ({}) as { leim?: string; dliq?: string })
  const headers: Record<string, string> = {
    ...authHeaders(creds, powHeader(result)),
    "content-type": "application/json",
  }
  if (tokens.leim) headers["x-hif-leim"] = tokens.leim
  if (tokens.dliq) headers["x-hif-dliq"] = tokens.dliq
  const resp = await fetch(`${API_BASE}/chat/completion`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  })
  if (!resp.ok || !resp.body) {
    const text = await resp.text().catch(() => "")
    throw new DeepseekError(resp.status, `completion HTTP ${resp.status}: ${text.slice(0, 300)}`)
  }
  return resp.body
}

// ── SSE 帧提取 + JSON Patch 状态机 ──

export interface SearchResult {
  url: string
  title: string
  snippet?: string
  cite_index?: number
  site_name?: string
  site_icon?: string
}

export type StreamEvent =
  | { type: "think-delta"; content: string }
  | { type: "content-delta"; content: string }
  | { type: "search-start"; queries: string[] }
  | { type: "search-results"; results: SearchResult[] }
  | { type: "done"; finishReason?: string; tokens?: number }
  | { type: "ready"; responseMessageId?: number }
  | { type: "title"; title: string }
  | { type: "update-session" }

const FRAG_THINK = "THINK"
export const RESPONSE_TYPES = new Set(["RESPONSE", "TEMPLATE_RESPONSE"])
const FRAG_SEARCH = "TOOL_SEARCH"
const SEARCH_TYPES = new Set([FRAG_SEARCH, "SEARCH"])

const unhandledPaths = new Set<string>()

function logUnhandled(path: string, op: string) {
  const key = `${path}|${op}`
  if (unhandledPaths.has(key)) return
  unhandledPaths.add(key)
  console.log(`[dsterm] 未处理的 SSE 字段: path=${path} op=${op}`)
}

const searchQueries = (frag: any): string[] =>
  Array.isArray(frag?.queries)
    ? frag.queries.map((q: any) => String(q?.query ?? "")).filter(Boolean)
    : []

const searchResults = (v: any): SearchResult[] =>
  Array.isArray(v)
    ? v
        .filter((r: any) => typeof r?.url === "string")
        .map((r: any) => ({
          url: r.url,
          title: typeof r.title === "string" ? r.title : r.url,
          snippet: typeof r.snippet === "string" ? r.snippet : undefined,
          cite_index: typeof r.cite_index === "number" ? r.cite_index : undefined,
          site_name: typeof r.site_name === "string" ? r.site_name : undefined,
          site_icon: typeof r.site_icon === "string" ? r.site_icon : undefined,
        }))
    : []

class PatchState {
  path?: string
  op?: string
  status?: string
  tokens?: number
  fragments: string[] = []

  apply(data: any): StreamEvent[] {
    const events: StreamEvent[] = []
    if (data.p !== undefined) this.path = data.p
    if (data.o !== undefined) this.op = data.o
    const op = this.op ?? "SET"
    const path = this.path ?? ""
    const v = data.v
    if (v === undefined) return events

    if (path === "" && v && typeof v === "object" && v.response) {
      this.applySnapshot(v.response, events)
      return events
    }
    if (op === "BATCH" && Array.isArray(v)) {
      for (const item of v) events.push(...this.apply(item))
      return events
    }
    this.applyPath(path, op, v, events)
    return events
  }

  private appendFragments(items: any[], events: StreamEvent[]) {
    for (const item of items) {
      const ty = item?.type
      if (!ty) continue
      this.fragments.push(ty)
      if (SEARCH_TYPES.has(ty)) {
        events.push({ type: "search-start", queries: searchQueries(item) })
        const builtin = searchResults(item?.results)
        if (builtin.length) events.push({ type: "search-results", results: builtin })
      }
      const content = typeof item?.content === "string" ? item.content : ""
      if (content && ty === FRAG_THINK) events.push({ type: "think-delta", content })
      if (content && RESPONSE_TYPES.has(ty)) events.push({ type: "content-delta", content })
    }
  }

  private applySnapshot(response: any, events: StreamEvent[]) {
    if (typeof response.status === "string") this.status = response.status
    if (typeof response.accumulated_token_usage === "number") this.tokens = response.accumulated_token_usage
    if (Array.isArray(response.fragments)) {
      this.fragments = []
      this.appendFragments(response.fragments, events)
    }
  }

  private applyPath(path: string, op: string, v: any, events: StreamEvent[]) {
    const p = path.replace(/^\//, "")
    if (p === "response/status" || p === "status") {
      if (typeof v === "string") this.status = v
      return
    }
    if (p === "response/accumulated_token_usage" || p === "accumulated_token_usage") {
      if (typeof v === "number") this.tokens = v
      return
    }
    if (p === "response/fragments/-1/content") {
      const ty = this.fragments[this.fragments.length - 1]
      if (typeof v === "string" && ty) {
        if (ty === FRAG_THINK) events.push({ type: "think-delta", content: v })
        if (RESPONSE_TYPES.has(ty)) events.push({ type: "content-delta", content: v })
      }
      return
    }
    if (p === "response/fragments/-1/results" || p === "fragments/-1/results") {
      if (this.fragments.length && SEARCH_TYPES.has(this.fragments[this.fragments.length - 1])) {
        const results = searchResults(v)
        if (results.length) events.push({ type: "search-results", results })
      }
      return
    }
    if (p === "response/fragments" || p === "fragments") {
      const items = Array.isArray(v) ? v : [v]
      if (op === "APPEND") {
        this.appendFragments(items, events)
        return
      }
      if (op === "SET") {
        const known = Math.min(items.length, this.fragments.length)
        for (let i = 0; i < known; i++) {
          const ty = items[i]?.type
          if (ty) this.fragments[i] = ty
        }
        this.appendFragments(items.slice(known), events)
        if (items.length < this.fragments.length) this.fragments.length = items.length
        return
      }
    }
    logUnhandled(path, op)
  }
}

export async function* parseCompletionStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const patch = new PatchState()
  let phase: "init" | "thinking" | "content" | "done" = "init"
  let readyId: number | undefined

  const finalize = (events: StreamEvent[], out: StreamEvent[]) => {
    for (const evt of events) {
      if (evt.type === "think-delta" && (phase === "init" || phase === "content")) {
        phase = "thinking"
        out.push({ type: "think-delta", content: "" })
      }
      if (evt.type === "content-delta" && (phase === "init" || phase === "thinking")) {
        phase = "content"
      }
      if (evt.type === "content-delta") {
        out.push(evt)
        continue
      }
      if (evt.type === "think-delta" && evt.content) {
        out.push(evt)
        continue
      }
      if (evt.type === "think-delta") continue
      out.push(evt)
    }
    if (
      (patch.status === "FINISHED" || patch.status === "INCOMPLETE") &&
      phase !== "done"
    ) {
      phase = "done"
      out.push({
        type: "done",
        finishReason: patch.status === "FINISHED" ? "stop" : undefined,
        tokens: patch.tokens,
      })
    }
  }

  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        if (!frame.trim()) continue
        let eventType: string | undefined
        let data: string | undefined
        for (const line of frame.split("\n")) {
          const t = line.trim()
          if (t.startsWith("event:")) eventType = t.slice(6).trim()
          else if (t.startsWith("data:")) data = t.slice(5).trim()
        }
        if (eventType === "ready" && data) {
          try {
            const val = JSON.parse(data)
            const rid = val.response_message_id ?? val.data?.response_message_id
            if (typeof rid === "number") readyId = rid
          } catch {}
          yield { type: "ready", responseMessageId: readyId }
          continue
        }
        if (eventType === "update_session") {
          yield { type: "update-session" }
          continue
        }
        if (eventType === "title" && data) {
          try {
            const val = JSON.parse(data)
            if (typeof val?.content === "string" && val.content) {
              yield { type: "title", title: val.content }
            }
          } catch {}
          continue
        }
        if (eventType === "hint" && data) {
          try {
            const val = JSON.parse(data)
            throw new DeepseekError(val.code ?? -4, val.msg ?? "hint error")
          } catch (e) {
            if (e instanceof DeepseekError) throw e
          }
        }
        if (!data) continue
        let val: any
        try {
          val = JSON.parse(data)
        } catch {
          continue
        }
        const out: StreamEvent[] = []
        finalize(patch.apply(val), out)
        for (const evt of out) {
          if (evt.type === "ready") {
            ;(evt as any).responseMessageId = readyId
          }
          yield evt
        }
      }
    }
    if ((phase as string) !== "done") yield { type: "done", finishReason: undefined, tokens: patch.tokens }
  } finally {
    reader.releaseLock()
  }
}

export async function stopStream(creds: Credentials, chatSessionId: string, messageId: number) {
  const resp = await fetch(`${API_BASE}/chat/stop_stream`, {
    method: "POST",
    headers: { ...authHeaders(creds), "content-type": "application/json" },
    body: JSON.stringify({ chat_session_id: chatSessionId, message_id: messageId }),
  })
  return envelope<unknown>(resp).catch(() => undefined)
}
