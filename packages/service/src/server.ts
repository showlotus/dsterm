const CWD = process.cwd()

declare const OPENCODE_VERSION: string | undefined

const serviceVersion = typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : "local"

let evtSeq = 0
let evtCounter = 0
const sessions = new Map()
const messages = new Map()
const streamControllers = new Map()
const stopFlags = new Map()
const subscribers = new Set<(payload: string) => void>()

import {
  createChatSession,
  createCompletionStream,
  deleteChatSession,
  fetchHistory,
  fetchSessions,
  HifCache,
  parseCompletionStream,
  renameChatSession,
  uploadFileAndWait,
  stopStream,
  RESPONSE_TYPES,
  type Credentials,
  type SearchResult,
} from "./deepseek"

const now = () => Date.now()
const nextId = (prefix) => `${prefix}_${(++evtCounter).toString(36)}${now().toString(36)}`
const locationRef = () => ({ directory: CWD })
const locationInfo = () => ({
  directory: CWD,
  project: { id: "dsterm", directory: CWD, canonical: CWD },
})
const zeroTokens = () => ({ input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })

async function loadCredentials(): Promise<Credentials | undefined> {
  const envToken = process.env.DSTERM_USER_TOKEN
  const envDevice = process.env.DSTERM_DEVICE_ID
  if (envToken) return { userToken: envToken, deviceId: envDevice ?? "" }
  try {
    const raw = await Bun.file(`${process.env.HOME}/.config/dsterm/credentials.json`).json()
    if (raw.userToken) return { userToken: raw.userToken, deviceId: raw.deviceId ?? "" }
  } catch {}
  return undefined
}

let creds = await loadCredentials()

function reloadCredentials() {
  return loadCredentials().then((next) => {
    creds = next
    hifInstance = next ? new HifCache(next) : undefined
    console.log(`[dsterm] 模式: ${creds ? "DeepSeek Web 直连" : "echo（未配置凭证）"}`)
    return next
  })
}

interface AgentConfig {
  model?: { providerID?: string; id?: string; variant?: string }
}

const agentConfig: AgentConfig = await Bun.file(`${process.env.HOME}/.config/dsterm/config.json`)
  .json()
  .catch(() => ({}))

function defaultAgentModel() {
  const m = agentConfig.model
  return {
    providerID: m?.providerID ?? "dsterm",
    id: m?.id ?? "default",
    variant: m?.variant ?? "search",
  }
}

let hifInstance = creds ? new HifCache(creds) : undefined
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const upstreamStorePath = `${process.env.HOME}/.config/dsterm/upstream.json`
const upstream = new Map<string, { upstreamId: string; parentMessageId?: number; responseMessageId?: number }>()
try {
  for (const [k, v] of Object.entries(await Bun.file(upstreamStorePath).json())) upstream.set(k, v as any)
} catch {}
function saveUpstream() {
  Bun.write(upstreamStorePath, JSON.stringify(Object.fromEntries(upstream), null, 2)).catch(() => {})
}

const cloudCache: { list: { id: string; title: string; updated_at: number }[]; hasMore: boolean; at: number } = {
  list: [],
  hasMore: false,
  at: 0,
}

async function cloudSessions() {
  if (!creds) return []
  if (cloudCache.list.length && now() - cloudCache.at < 10000) return cloudCache.list
  const page = await fetchSessions(creds)
  cloudCache.list = page.chat_sessions ?? []
  cloudCache.hasMore = Boolean(page.has_more)
  cloudCache.at = now()
  return cloudCache.list
}

function cloudSessionID(uuid: string) {
  return `ses_${uuid}`
}

function cloudSessionInfo(c: { id: string; title: string; updated_at: number }) {
  const updated = Math.round(c.updated_at * 1000)
  return {
    id: cloudSessionID(c.id),
    projectID: "dsterm",
    agent: "build",
    model: defaultAgentModel(),
    cost: 0,
    tokens: zeroTokens(),
    time: { created: updated, updated },
    title: c.title || "DeepSeek 会话",
    location: locationRef(),
  }
}

function convertHistory(items: { message_id: number; role: string; status: string; inserted_at: number; fragments: { type: string; content?: string; queries?: { query?: string }[]; results?: SearchResult[] }[] }[]) {
  const sorted = [...items].sort((a, b) => a.message_id - b.message_id)
  return sorted.map((m) => {
    const created = Math.round(m.inserted_at * 1000)
    const completed = m.status === "FINISHED" ? created : undefined
    if (m.role === "USER") {
      const text = m.fragments?.find((f) => f.type === "REQUEST")?.content ?? ""
      return { id: `msg_ds${m.message_id}`, time: { created }, type: "user", text }
    }
    const content: any[] = []
    let searchSeq = 0
    for (const f of m.fragments ?? []) {
      if (f.type === "THINK") {
        if (f.content) content.push({ type: "reasoning", text: f.content, time: { created, completed } })
      } else if (RESPONSE_TYPES.has(f.type)) {
        if (f.content) content.push({ type: "text", text: f.content, time: { created, completed } })
      } else if (f.type === "TOOL_SEARCH" || f.type === "SEARCH") {
        searchSeq++
        const query = (f.queries ?? []).map((q) => q?.query ?? "").filter(Boolean).join("; ")
        const payload = JSON.stringify({ query, sources: f.results ?? [] })
        content.push({
          type: "tool",
          id: `search_${m.message_id}_${searchSeq}`,
          name: "websearch",
          executed: true,
          time: { created },
          state: { status: "completed", input: { query }, content: [{ type: "text", text: payload }] },
        })
      }
    }
    if (!content.length) content.push({ type: "text", text: "", time: { created, completed } })
    return {
      id: `msg_ds${m.message_id}`,
      time: { created, completed },
      type: "assistant",
      agent: "build",
      model: { providerID: "dsterm", modelID: "default" },
      finish: m.status === "FINISHED" ? "stop" : undefined,
      content,
    }
  })
}

const seenCloud = new Set<string>()

async function syncCloudTitles() {
  let cloud: { id: string; title: string; updated_at: number }[]
  try {
    cloud = await cloudSessions()
  } catch {
    return []
  }
  seenCloud.clear()
  for (const info of sessions.values()) {
    const st = upstream.get(info.id)
    if (!st) continue
    const match = cloud.find((c) => c.id === st.upstreamId)
    if (!match) continue
    seenCloud.add(st.upstreamId)
    if (match.title && match.title !== info.title) {
      info.title = match.title
      info.time.updated = Math.round(match.updated_at * 1000)
      emit(durableEvent(info.id, "session.renamed", { sessionID: info.id, title: match.title }))
    }
  }
  return cloud
}

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const sub of subscribers) {
    try {
      sub(payload)
    } catch {
      subscribers.delete(sub)
    }
  }
}

function durableEvent(sessionID, type, data, version = 1) {
  const seq = (messages.get(`__seq:${sessionID}`) ?? 0) + 1
  messages.set(`__seq:${sessionID}`, seq)
  return { id: nextId("evt"), created: now(), type, durable: { aggregateID: sessionID, seq, version }, data }
}

function transientEvent(type, data) {
  return { id: nextId("evt"), created: now(), type, data }
}

function normalizeModel(model) {
  if (!model) return { providerID: "dsterm", id: "default" }
  return { providerID: model.providerID, id: model.modelID ?? model.id, variant: model.variant }
}

function createSession(title?, preferredId?, model?, agent?) {
  const id = preferredId || nextId("ses")
  if (sessions.has(id)) return sessions.get(id)
  const info = {
    id,
    projectID: "dsterm",
    agent: agent || "build",
    model: normalizeModel(model),
    cost: 0,
    tokens: zeroTokens(),
    time: { created: now(), updated: now() },
    title: title || "New Chat",
    location: locationRef(),
  }
  sessions.set(id, info)
  messages.set(id, [])
  emit(durableEvent(id, "session.created", {
    sessionID: id,
    projectID: "dsterm",
    location: locationRef(),
    slug: id,
    title: info.title,
    version: "local",
  }))
  return info
}

const REASONING_TEXT =
  "No DeepSeek credentials are configured, so dsterm is not signed in and the message was not sent to DeepSeek Web." +
  " I should guide the user through credential setup; it takes effect immediately once saved."

const REPLY_TEXT = [
  "## Not signed in to DeepSeek",
  "",
  "This reply was generated **locally by dsterm**; your message was not sent to DeepSeek Web. To start chatting:",
  "",
  "1. Press `ctrl+p` to open the command palette and run **Configure DeepSeek credentials**",
  "2. Follow the dialog to enter `userToken` and `device_id` (instructions included)",
  "3. Settings apply immediately — no restart needed",
  "",
  "> Where to get them: sign in at [chat.deepseek.com](https://chat.deepseek.com), then check Local Storage and the Network panel in DevTools.",
].join("\n")

const SOURCE_PART = { type: "source", title: "DeepSeek 官网", url: "https://chat.deepseek.com" }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function runEcho(sessionID, userText) {
  const assistantID = nextId("msg")
  const controller = new AbortController()
  streamControllers.set(sessionID, controller)
  const signal = controller.signal
  const stopped = () => signal.aborted
  emit(durableEvent(sessionID, "session.execution.started", { sessionID }))

  const model = { providerID: "dsterm", id: "default" }
  messages.get(sessionID).push({
    id: assistantID,
    time: { created: now() },
    type: "assistant",
    agent: "build",
    model,
    content: [],
  })

  emit(durableEvent(sessionID, "session.step.started", {
    sessionID,
    assistantMessageID: assistantID,
    agent: "build",
    model,
    started: now(),
  }))
  emit(transientEvent("session.reasoning.started", { sessionID, assistantMessageID: assistantID, ordinal: 0 }))

  const reasoningChunks = chunk(REASONING_TEXT)
  for (const c of reasoningChunks) {
    if (stopped()) break
    emit(transientEvent("session.reasoning.delta", { sessionID, assistantMessageID: assistantID, ordinal: 0, delta: c }))
    await sleep(25)
  }
  emit(transientEvent("session.reasoning.ended", { sessionID, assistantMessageID: assistantID, ordinal: 0, text: REASONING_TEXT }))
  if (stopped()) {
    finish(sessionID, assistantID, "unknown", zeroTokens(), true)
    if (streamControllers.get(sessionID) === controller) streamControllers.delete(sessionID)
    return
  }

  emit(transientEvent("session.text.started", { sessionID, assistantMessageID: assistantID, ordinal: 0 }))
  const textChunks = chunk(REPLY_TEXT)
  for (const c of textChunks) {
    if (stopped()) break
    emit(transientEvent("session.text.delta", { sessionID, assistantMessageID: assistantID, ordinal: 0, delta: c }))
    await sleep(30)
  }
  emit(transientEvent("session.text.ended", { sessionID, assistantMessageID: assistantID, ordinal: 0, text: REPLY_TEXT }))

  const tokens = { input: userText.length, output: REPLY_TEXT.length, reasoning: REASONING_TEXT.length, cache: { read: 0, write: 0 } }
  finish(sessionID, assistantID, "stop", tokens, true)
  if (streamControllers.get(sessionID) === controller) streamControllers.delete(sessionID)
}

function finish(sessionID, assistantID, finishReason, tokens = zeroTokens(), fallback = false) {
  const msg = messages.get(sessionID).find((m) => m.id === assistantID)
  if (msg) {
    msg.time.completed = now()
    msg.finish = finishReason
    if (fallback) {
      if (!msg.content.some((p) => p.type === "reasoning")) msg.content.push({ type: "reasoning", text: REASONING_TEXT })
      if (!msg.content.some((p) => p.type === "text")) msg.content.push({ type: "text", text: REPLY_TEXT })
      msg.content.push(SOURCE_PART)
    }
    msg.tokens = tokens
    msg.cost = 0
  }
  emit(durableEvent(sessionID, "session.step.ended", {
    sessionID,
    assistantMessageID: assistantID,
    finish: finishReason,
    cost: 0,
    tokens,
  }))
  emit(transientEvent("session.usage.updated", { sessionID, cost: 0, tokens }))
  const failed = finishReason === "error"
  const execution = durableEvent(sessionID, failed ? "session.execution.failed" : "session.execution.succeeded", {
    sessionID,
    ...(failed ? { error: { type: "unknown", message: "completion failed" } } : {}),
  })
  messages.get(sessionID)?.push({
    id: execution.id.replace(/^evt_/, "msg_"),
    type: "idle",
    outcome: failed ? "failed" : "succeeded",
    ...(failed ? { error: { type: "unknown", message: "completion failed" } } : {}),
    time: { created: execution.created },
  })
  emit(execution)
}

async function runDeepseek(sessionID: string, text: string, controller: AbortController, files: { uri?: string; name?: string; source?: { type?: string; uri?: string } }[] = []) {
  const assistantID = nextId("msg")
  const signal = controller.signal
  const stopped = () => signal.aborted
  emit(durableEvent(sessionID, "session.execution.started", { sessionID }))
  let state = upstream.get(sessionID)

  const reasoningChunks: string[] = []
  const textChunks: string[] = []
  let reasoningOpen = true
  let textOpen = false
  const finalizeParts = () => {
    if (reasoningOpen) {
      emit(transientEvent("session.reasoning.ended", { sessionID, assistantMessageID: assistantID, ordinal: 0, text: reasoningChunks.join("") }))
    }
    if (textOpen) {
      emit(transientEvent("session.text.ended", { sessionID, assistantMessageID: assistantID, ordinal: 0, text: textChunks.join("") }))
    }
    const msg = messages.get(sessionID)?.find((m) => m.id === assistantID)
    if (msg) {
      if (reasoningChunks.length && !msg.content.some((p) => p.type === "reasoning"))
        msg.content.push({ type: "reasoning", text: reasoningChunks.join("") })
      if (textChunks.length && !msg.content.some((p) => p.type === "text"))
        msg.content.push({ type: "text", text: textChunks.join("") })
    }
  }

  try {
    if (!state) {
      const created = await createChatSession(creds!)
      state = { upstreamId: String(created.id) }
      upstream.set(sessionID, state)
      saveUpstream()
    }
    const refFileIds: string[] = []
    for (const file of files) {
      const uri = file?.source?.type === "uri" ? file.source.uri : file?.uri
      if (typeof uri !== "string" || !uri.startsWith("file://")) continue
      try {
        const localPath = Bun.fileURLToPath(new URL(uri))
        const blob = Bun.file(localPath)
        const uploaded = await uploadFileAndWait(creds!, {
          name: file.name ?? localPath.split("/").pop() ?? "attachment",
          mime: blob.type || "application/octet-stream",
          bytes: new Uint8Array(await blob.arrayBuffer()),
        })
        refFileIds.push(uploaded.id)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.log(`[dsterm] 附件上传失败 ${uri}: ${message}`)
      }
    }
    const model = { providerID: "dsterm", id: "default" }
    messages.get(sessionID).push({
      id: assistantID,
      time: { created: now() },
      type: "assistant",
      agent: "build",
      model,
      content: [],
    })
    emit(durableEvent(sessionID, "session.step.started", {
      sessionID,
      assistantMessageID: assistantID,
      agent: "build",
      model,
      started: now(),
    }))
    emit(transientEvent("session.reasoning.started", { sessionID, assistantMessageID: assistantID, ordinal: 0 }))

    let finishReason: string | undefined
    let tokens: any
    let searchSeq = 0
    const searchQueriesByTool = new Map<string, string>()

    const emitSearchStart = (queries: string[]) => {
      searchSeq++
      const toolID = `search_${searchSeq}`
      const query = queries.join("; ")
      searchQueriesByTool.set(toolID, query)
      emit(transientEvent("session.tool.input.started", { sessionID, assistantMessageID: assistantID, id: toolID, name: "websearch" }))
      emit(transientEvent("session.tool.called", { sessionID, assistantMessageID: assistantID, id: toolID, input: { query }, executed: false }))
    }

    const emitSearchResults = (toolID: string, results: SearchResult[]) => {
      const payload = JSON.stringify({ query: searchQueriesByTool.get(toolID) ?? "", sources: results })
      emit(transientEvent("session.tool.success", {
        sessionID,
        assistantMessageID: assistantID,
        id: toolID,
        executed: true,
        content: [{ type: "text", text: payload }],
        metadata: {},
      }))
      const msg = messages.get(sessionID)?.find((m) => m.id === assistantID)
      if (msg) {
        const existing = msg.content.find((p: any) => p.type === "tool" && p.id === toolID)
        const state = { status: "completed", input: { query: searchQueriesByTool.get(toolID) ?? "" }, content: [{ type: "text", text: payload }] }
        if (existing) existing.state = state
        else msg.content.push({ type: "tool", id: toolID, name: "websearch", executed: true, time: { created: now() }, state })
      }
    }

    const payload = {
      chat_session_id: state.upstreamId,
      parent_message_id: state.parentMessageId,
      model_type: "default",
      prompt: text,
      ref_file_ids: refFileIds,
      thinking_enabled: true,
      search_enabled: sessions.get(sessionID)?.model?.variant === "search",
      source: "default",
      preempt: false,
    }
    const body = await createCompletionStream(creds!, payload, hifInstance!)
    for await (const evt of parseCompletionStream(body, signal)) {
      if (evt.type === "ready" && evt.responseMessageId !== undefined) {
        state.responseMessageId = evt.responseMessageId
        state.parentMessageId = evt.responseMessageId
      }
      if (evt.type === "title") {
        const info = sessions.get(sessionID)
        if (info && info.title !== evt.title) {
          info.title = evt.title
          info.time.updated = now()
          emit(durableEvent(sessionID, "session.renamed", { sessionID, title: evt.title }))
        }
      }
      if (evt.type === "search-start") emitSearchStart(evt.queries)
      if (evt.type === "search-results") emitSearchResults(`search_${searchSeq}`, evt.results)
      if (evt.type === "think-delta" && evt.content) {
        reasoningChunks.push(evt.content)
        if (!reasoningOpen) {
          reasoningOpen = true
          emit(transientEvent("session.reasoning.started", { sessionID, assistantMessageID: assistantID, ordinal: 0 }))
        }
        emit(transientEvent("session.reasoning.delta", { sessionID, assistantMessageID: assistantID, ordinal: 0, delta: evt.content }))
      }
      if (evt.type === "content-delta" && evt.content) {
        if (reasoningOpen) {
          reasoningOpen = false
          emit(transientEvent("session.reasoning.ended", { sessionID, assistantMessageID: assistantID, ordinal: 0, text: reasoningChunks.join("") }))
        }
        if (!textOpen) {
          textOpen = true
          emit(transientEvent("session.text.started", { sessionID, assistantMessageID: assistantID, ordinal: 0 }))
        }
        textChunks.push(evt.content)
        emit(transientEvent("session.text.delta", { sessionID, assistantMessageID: assistantID, ordinal: 0, delta: evt.content }))
      }
      if (evt.type === "done") {
        finishReason = evt.finishReason
        tokens = evt.tokens
      }
    }
    finalizeParts()
    finish(sessionID, assistantID, finishReason ?? (stopped() ? "unknown" : "stop"), {
      input: text.length,
      output: textChunks.join("").length,
      reasoning: reasoningChunks.join("").length,
      cache: { read: 0, write: 0 },
    })
  } catch (err) {
    if (stopFlags.has(sessionID)) {
      finalizeParts()
      finish(sessionID, assistantID, "unknown", {
        input: text.length,
        output: textChunks.join("").length,
        reasoning: reasoningChunks.join("").length,
        cache: { read: 0, write: 0 },
      })
      return
    }
    finish(sessionID, assistantID, "error", zeroTokens())
    const errMsg = `⚠️ DeepSeek 错误: ${err instanceof Error ? err.message : String(err)}`
    emit(transientEvent("session.text.started", { sessionID, assistantMessageID: assistantID, ordinal: 0 }))
    emit(transientEvent("session.text.delta", { sessionID, assistantMessageID: assistantID, ordinal: 0, delta: errMsg }))
    emit(transientEvent("session.text.ended", { sessionID, assistantMessageID: assistantID, ordinal: 0, text: errMsg }))
  } finally {
    stopFlags.delete(sessionID)
    if (streamControllers.get(sessionID) === controller) streamControllers.delete(sessionID)
  }
}

function chunk(text, size = 6) {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out
}

function messageResponse(sessionID, order = "desc") {
  const list = messages.get(sessionID) ?? []
  return { data: order === "asc" ? [...list] : [...list].reverse(), cursor: { previous: null, next: null } }
}

const json = (data, status = 200) => Response.json(data, { status })
const voidResponse = () => new Response(null, { status: 204 })

const FS_IGNORE = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".venv", "venv", "__pycache__"])
const FS_SCAN_LIMIT = 20000
let fsCache: { at: number; files: string[] } | undefined

async function scanWorkspaceFiles(dir: string) {
  if (fsCache && Date.now() - fsCache.at < 10000) return fsCache.files
  const files: string[] = []
  let rgText = ""
  let rgOk = false
  try {
    const rg = Bun.spawn(["rg", "--files", "--no-config", "--glob=!**/.git/**", "--hidden", "."], { cwd: dir, stdout: "pipe", stderr: "ignore" })
    rgText = await new Response(rg.stdout).text()
    rgOk = (await rg.exited) === 0 && !!rgText.trim()
  } catch {}
  if (rgOk) {
    files.push(...rgText.split("\n").filter(Boolean).map((file) => (file.startsWith("./") ? file.slice(2) : file)))
  } else {
    const { readdir } = await import("node:fs/promises")
    const stack: string[] = [""]
    while (stack.length && files.length < FS_SCAN_LIMIT) {
      const rel = stack.pop()!
      let entries
      try {
        entries = await readdir(rel ? `${dir}/${rel}` : dir, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".git") || (rel === "" && FS_IGNORE.has(entry.name))) continue
        const path = rel ? `${rel}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          if (FS_IGNORE.has(entry.name)) continue
          stack.push(path)
        } else if (entry.isFile()) {
          files.push(path)
          if (files.length >= FS_SCAN_LIMIT) break
        }
      }
    }
  }
  fsCache = { at: Date.now(), files }
  return files
}

function fuzzyScore(candidate: string, query: string) {
  const p = candidate.toLowerCase()
  const q = query.toLowerCase()
  const base = p.split("/").pop() ?? p
  const baseIdx = base.indexOf(q)
  if (baseIdx >= 0) return 1000 - baseIdx - base.length * 0.1
  const pathIdx = p.indexOf(q)
  if (pathIdx >= 0) return 500 - pathIdx - p.length * 0.05
  let pi = 0
  for (const ch of q) {
    pi = p.indexOf(ch, pi)
    if (pi < 0) return -1
    pi++
  }
  return 100 - p.length * 0.05
}

const routes = {
  "GET /api/info": () =>
    json({
      version: serviceVersion,
      pid: process.pid,
      hostname: "127.0.0.1",
      urls: [`http://127.0.0.1:${Number(process.env.DSTERM_PORT) || 4598}`],
      paths: { config: `${process.env.HOME}/.config/dsterm` },
      capabilities: { persistentPty: false, chat: true, streaming: true, reasoning: true, sources: true, search: true, tools: false, files: false, regenerate: true, cloudSessions: false },
    }),
  "GET /api/config": () => json([{ type: "directory", path: `${process.env.HOME}/.config/dsterm` }]),
  "GET /api/location": () => json(locationInfo()),
      "GET /api/agent": () =>
        json({
          location: locationRef(),
          data: [{
            id: "build",
            name: "Build",
            request: { settings: {}, headers: {}, body: {} },
            description: "dsterm 默认 agent",
            mode: "primary",
            hidden: false,
            model: defaultAgentModel(),
            permissions: [{ action: "*", resource: "*", effect: "allow" }],
          }],
        }),
  "GET /api/model": () =>
    json({
      location: locationRef(),
      data: [{
        id: "default",
        modelID: "default",
        providerID: "dsterm",
        type: "chat",
        family: "deepseek",
        name: "DeepSeek Flash",
        compatibility: { reasoningField: "reasoning_content", streamUsage: true },
        package: "@dsterm/service",
        settings: {},
        capabilities: { tools: false, input: ["text"], output: ["text"], temperature: true },
        variants: [{ id: "default" }, { id: "search" }],
        time: { released: 0 },
        cost: [],
        status: "active",
        enabled: true,
        limit: { context: 128000, output: 8192 },
      }],
    }),
  "GET /api/model/default": () =>
    json({
      location: locationRef(),
      data: { providerID: "dsterm", modelID: "default" },
    }),
  "GET /api/provider": () =>
    json({
      location: locationRef(),
      data: [{
        id: "dsterm",
        integrationID: "dsterm",
        name: "DeepSeek Web",
        activation: "enabled",
        package: "@dsterm/service",
        settings: {},
      }],
    }),
  "GET /api/command": () => json({ location: locationRef(), data: [] }),
  "GET /api/experimental/usage/limits": () => json({ location: locationRef(), data: null }),
  "GET /api/experimental/migration/v1": () => json({ location: locationRef(), data: null }),
  "GET /api/experimental/session/:id/terminal": () => json({ location: locationRef(), data: null }),
  "GET /api/experimental/fs/list": () => json({ location: locationRef(), data: [] }),
  "GET /api/fs/find": async (req) => {
    const url = new URL(req.url)
    const query = url.searchParams.get("query") ?? ""
    const type = url.searchParams.get("type")
    const limit = Number(url.searchParams.get("limit")) || 50
    const files = await scanWorkspaceFiles(CWD)
    const dirs = new Set<string>()
    for (const file of files) {
      const parts = file.split("/")
      parts.pop()
      for (let i = 0; i < parts.length; i++) dirs.add(`${parts.slice(0, i + 1).join("/")}/`)
    }
    const items: { path: string; type: "file" | "directory" }[] = type === "directory"
      ? [...dirs].map((path) => ({ path, type: "directory" as const }))
      : type === "file"
        ? files.map((path) => ({ path, type: "file" as const }))
        : [...files.map((path) => ({ path, type: "file" as const })), ...[...dirs].map((path) => ({ path, type: "directory" as const }))]
    const entries: { path: string; type: "file" | "directory" }[] = []
    if (query) {
      const scored: { path: string; type: "file" | "directory"; score: number }[] = []
      for (const item of items) {
        const score = fuzzyScore(item.path, query)
        if (score >= 0) scored.push({ ...item, score })
      }
      scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
      for (const { path, type: entryType } of scored) {
        if (entries.length >= limit) break
        entries.push({ path, type: entryType })
      }
    }
    return json({ location: locationRef(), data: entries })
  },
  "GET /api/mcp": () => json({ location: locationRef(), data: [] }),
  "GET /api/mcp/resource": () => json({ location: locationRef(), data: [] }),
  "GET /api/reference": () => json({ location: locationRef(), data: [] }),
  "GET /api/skill": () => json({ location: locationRef(), data: [] }),
  "GET /api/shell": () => json({ location: locationRef(), data: [] }),
  "GET /api/form": () => json({ data: [] }),
  "GET /api/vcs": () => json({ location: locationRef(), data: null }),
  "GET /api/integration": () => json({ location: locationRef(), data: [] }),
  "GET /api/project": () => json({ location: locationRef(), data: [] }),
  "GET /api/plugin": () => json({ location: locationRef(), data: [] }),
  "GET /api/session/:id/permission": () => json({ location: locationRef(), data: [] }),
  "GET /api/session/:id/inbox": (_req, p) => json({ location: locationRef(), data: [] }),
  "GET /api/session/:id/message/:messageID": (_req, p) => {
    const list = messages.get(p.id) ?? []
    const found = list.find((m) => m.id === p.messageID)
    if (found) return json({ data: found })
    const info = sessions.get(p.id)
    return json({
      data: {
        id: p.messageID,
        type: "model-switched",
        model: info?.model ?? { providerID: "dsterm", modelID: "default" },
        time: { created: now() },
      },
    })
  },
  "POST /api/rpc/:rpcID/:method": () => json({ data: null }),
  "POST /api/session/:id/model": async (req, p) => {
    const body = await req.json().catch(() => ({}))
    const model = normalizeModel(body.model)
    const info = sessions.get(p.id)
    const previous = info?.model
    const changed =
      !previous || previous.providerID !== model.providerID || previous.id !== model.id || previous.variant !== model.variant
    if (info && changed) {
      info.model = model
      info.time.updated = now()
      emit(durableEvent(p.id, "session.model.selected", { sessionID: p.id, model, previous }))
    }
    return voidResponse()
  },
  "POST /api/session/:id/agent": async (req, p) => {
    const body = await req.json().catch(() => ({}))
    emit(durableEvent(p.id, "session.agent.selected", { sessionID: p.id, agent: body.agent ?? "build" }))
    return voidResponse()
  },
  "GET /api/session": async (req) => {
    const url = new URL(req.url)
    const search = url.searchParams.get("search")?.toLowerCase() ?? ""
    const limit = Number(url.searchParams.get("limit")) || 50
    const rawCursor = url.searchParams.get("cursor")
    let anchorTime: number | undefined
    if (rawCursor) {
      try {
        const parsed = JSON.parse(rawCursor)
        const time = parsed?.anchor?.time
        if (typeof time === "number" && Number.isFinite(time)) anchorTime = time
      } catch {}
    }
    let cloudPage: { list: { id: string; title: string; updated_at: number }[]; hasMore: boolean } = { list: [], hasMore: false }
    if (anchorTime !== undefined) {
      const page = await fetchSessions(creds!, { direction: "lte", updatedAt: anchorTime }).catch(() => ({
        chat_sessions: [],
        has_more: false,
      }))
      cloudPage = { list: page.chat_sessions ?? [], hasMore: Boolean(page.has_more) }
    } else {
      const cloud = await syncCloudTitles()
      cloudPage = { list: cloud, hasMore: cloudCache.hasMore }
    }
    const cloudItems = cloudPage.list.filter((c) => !seenCloud.has(c.id)).map(cloudSessionInfo)
    const items = [...cloudItems, ...Array.from(sessions.values())].filter(
      (s) => !search || s.title.toLowerCase().includes(search),
    )
    items.sort((a, b) => b.time.updated - a.time.updated)
    const slice = items.slice(0, limit)
    const lastSlice = slice.at(-1)
    const cursor: { next?: string } = {}
    if (cloudPage.hasMore && !search && lastSlice) {
      cursor.next = JSON.stringify({
        anchor: { id: lastSlice.id, time: lastSlice.time.updated / 1000, direction: "next" },
      })
    }
    return json({ data: slice, cursor })
  },
  "GET /api/session/active": () => json(null),
  "GET /api/session/:id": async (_req, p) => {
    const local = sessions.get(p.id)
    if (local) return json({ data: local })
    if (creds && p.id.startsWith("ses_")) {
      const cloud = await syncCloudTitles().catch(() => [])
      const match = cloud.find((c) => cloudSessionID(c.id) === p.id)
      if (match) {
        const info = sessions.get(p.id) ?? cloudSessionInfo(match)
        sessions.set(p.id, info)
        return json({ data: info })
      }
    }
    return json({ data: createSession(undefined, p.id) })
  },
  "POST /api/session": async (req) => {
    const body = await req.json().catch(() => ({}))
    return json({ data: createSession(body.title, body.id, body.model, body.agent) })
  },
  "POST /api/session/:id/retry": async (req, p) => {
    const list = messages.get(p.id) ?? []
    while (list.length && list[list.length - 1].type === "assistant") list.pop()
    const lastUser = [...list].reverse().find((m) => m.type === "user")
    const controller = new AbortController()
    streamControllers.set(p.id, controller)
    const files = Array.isArray(lastUser?.files) ? lastUser.files : []
    if (creds) runDeepseek(p.id, lastUser?.text ?? "", controller, files).catch(() => {})
    else runEcho(p.id, lastUser?.text ?? "")
    return voidResponse()
  },
  "POST /api/session/:id/prompt": async (req, p) => {
    const body = await req.json().catch(() => ({}))
    const text = typeof body.text === "string" ? body.text : ""
    const id = typeof body.id === "string" && body.id ? body.id : nextId("msg")
    const created = now()
    const delivery = body.delivery ?? "steer"
    const files = Array.isArray(body.files)
      ? body.files.filter((file) => {
          const uri = file?.source?.type === "uri" ? file.source.uri : file?.uri
          return typeof uri === "string" && uri.startsWith("file://")
        })
      : []
    if (!messages.has(p.id)) messages.set(p.id, [])
    messages.get(p.id).push({ id, time: { created }, text, type: "user", files })
    emit(durableEvent(p.id, "session.inbox.enqueued", {
      sessionID: p.id,
      inboxID: id,
      item: { type: "user", delivery, payload: { text } },
    }))
    emit(durableEvent(p.id, "session.inbox.delivered", { sessionID: p.id, inboxID: id }))
    const controller = new AbortController()
    streamControllers.set(p.id, controller)
    if (creds) runDeepseek(p.id, text, controller, files).catch(() => {})
    else runEcho(p.id, text)
    return json({ data: { id, sessionID: p.id, time: { created }, type: "user", delivery, payload: { text } } })
  },
  "POST /api/session/:id/interrupt": (_req, p) => {
    const controller = streamControllers.get(p.id)
    const state = upstream.get(p.id)
    if (creds && controller && state?.upstreamId && state.responseMessageId !== undefined) {
      stopFlags.set(p.id, true)
      void stopStream(creds, state.upstreamId, state.responseMessageId)
      setTimeout(() => {
        if (!stopFlags.has(p.id)) return
        stopFlags.delete(p.id)
        controller.abort()
      }, 5000)
    } else {
      controller?.abort()
    }
    return json({})
  },
  "POST /api/session/:id/move": () => voidResponse(),
  "POST /api/session/:id/view": () => voidResponse(),
  "PUT /api/session/:id/environment": () => voidResponse(),
  "POST /api/session/:id/environment": () => voidResponse(),
  "POST /api/session/:id/command": () => voidResponse(),
  "POST /api/session/:id/synthetic": () => json({}),
  "GET /api/session/:id/message": async (req, p) => {
    const order = new URL(req.url).searchParams.get("order") ?? "desc"
    const tail = p.id.startsWith("ses_") ? p.id.slice(4) : ""
    const upstreamId = upstream.get(p.id)?.upstreamId ?? (UUID_RE.test(tail) ? tail : undefined)
    if (creds && upstreamId && !streamControllers.has(p.id)) {
      try {
        const hist = await fetchHistory(creds, upstreamId)
        const items = hist.chat_messages ?? []
        messages.set(p.id, convertHistory(items))
        const last = items.at(-1)
        if (last) {
          upstream.set(p.id, { upstreamId, parentMessageId: last.message_id })
          saveUpstream()
        }
      } catch {}
    }
    return json(messageResponse(p.id, order))
  },
  "GET /api/dsterm/credentials": () => json({ configured: Boolean(creds) }),
  "POST /api/dsterm/credentials": async (req) => {
    const body = await req.json().catch(() => ({}))
    const userToken = typeof body.userToken === "string" ? body.userToken.trim() : ""
    const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : ""
    if (!userToken) return json({ _tag: "InvalidRequest", message: "userToken is required" }, 400)
    const path = `${process.env.HOME}/.config/dsterm/credentials.json`
    await Bun.write(path, JSON.stringify({ userToken, deviceId }, null, 2))
    const { chmod } = await import("node:fs/promises")
    await chmod(path, 0o600)
    await reloadCredentials()
    console.log(`[dsterm] 凭据已更新（${deviceId ? "含 deviceId" : "缺少 deviceId，可能触发设备风控"}）`)
    return json({ ok: true, warning: deviceId ? undefined : "deviceId 为空，可能触发设备风控" })
  },
  "PATCH /api/session/:id": async (req, p) => {
    const body = await req.json().catch(() => ({}))
    let info = sessions.get(p.id)
    if (!info && creds && p.id.startsWith("ses_")) {
      const cloud = await syncCloudTitles().catch(() => [])
      const match = cloud.find((c) => cloudSessionID(c.id) === p.id)
      if (match) {
        info = cloudSessionInfo(match)
        sessions.set(p.id, info)
      }
    }
    if (!info) return json({ _tag: "NotFoundError", message: `session ${p.id} not found` }, 404)
    if (typeof body.title === "string" && body.title.trim() && body.title !== info.title) {
      const title = body.title
      const st = upstream.get(p.id)
      const tail = p.id.startsWith("ses_") ? p.id.slice(4) : ""
      const uuid = st?.upstreamId ?? (UUID_RE.test(tail) ? tail : undefined)
      if (creds && uuid) {
        try {
          await renameChatSession(creds, uuid, title)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          console.log(`[dsterm] 云端重命名失败 ${p.id}: ${message}`)
          return json({ _tag: "ServiceError", message: `云端重命名失败: ${message}` }, 500)
        }
      }
      info.title = title
      info.time.updated = now()
      cloudCache.at = 0
      emit(durableEvent(p.id, "session.renamed", { sessionID: p.id, title }))
    }
    return voidResponse()
  },
  "DELETE /api/session/:id": async (_req, p) => {
    const st = upstream.get(p.id)
    const tail = p.id.startsWith("ses_") ? p.id.slice(4) : ""
    const uuid = st?.upstreamId ?? (UUID_RE.test(tail) ? tail : undefined)
    if (creds && uuid) {
      try {
        await deleteChatSession(creds, uuid)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.log(`[dsterm] 云端删除失败 ${p.id}: ${message}`)
        return json({ _tag: "ServiceError", message: `云端删除失败: ${message}` }, 500)
      }
    }
    upstream.delete(p.id)
    saveUpstream()
    sessions.delete(p.id)
    messages.delete(p.id)
    cloudCache.at = 0
    emit(durableEvent(p.id, "session.deleted", { sessionID: p.id }, 2))
    return voidResponse()
  },
}

function matchRoute(method, pathname) {
  for (const [key, handler] of Object.entries(routes)) {
    const [routeMethod, routePath] = key.split(" ")
    if (routeMethod !== method) continue
    const routeParts = routePath.split("/")
    const pathParts = pathname.split("/")
    if (routeParts.length !== pathParts.length) continue
    const params = {}
    let ok = true
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(":")) params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i])
      else if (routeParts[i] !== pathParts[i]) { ok = false; break }
    }
    if (ok) return { handler, params }
  }
  return null
}

function sseResponse() {
  const enc = new TextEncoder()
  let cleanup: (() => void) | undefined
  const stream = new ReadableStream({
    start(controller) {
      const write = (payload) => controller.enqueue(enc.encode(payload))
      subscribers.add(write)
      write(`data: ${JSON.stringify({ id: nextId("evt"), created: now(), type: "server.connected", data: {} })}\n\n`)
      const ka = setInterval(() => {
        try { write(": ping\n\n") } catch { clearInterval(ka) }
      }, 30000)
      cleanup = () => { clearInterval(ka); subscribers.delete(write) }
    },
    cancel() { cleanup?.() },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

export function startService(port: number = Number(process.env.DSTERM_PORT) || 4598) {
  return Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)
    const { pathname } = url
    if (pathname === "/api/event") return sseResponse()
    if (req.method === "POST") console.log(`[req] ${req.method} ${pathname}`)
    const matched = matchRoute(req.method, pathname)
    if (matched) {
      try {
        return await matched.handler(req, matched.params)
      } catch (err) {
        return json({ _tag: "ServiceError", message: String(err) }, 500)
      }
    }
    return json({ _tag: "NotFoundError", message: `${req.method} ${pathname}` }, 404)
  },
  })
}

export async function probeService(url: string): Promise<{ ok: boolean; version?: string }> {
  try {
    const response = await fetch(`${url}/api/info`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return { ok: false }
    const info: any = await response.json()
    const ok =
      typeof info?.pid === "number" &&
      typeof info?.hostname === "string" &&
      typeof info?.paths?.config === "string" &&
      info.paths.config.replace(/\\/g, "/").endsWith("/.config/dsterm") &&
      typeof info?.capabilities?.chat === "boolean"
    return { ok, version: ok && typeof info.version === "string" ? info.version : undefined }
  } catch {
    return { ok: false }
  }
}

let ownedServer: any
let ownedEndpoint: { url: string; port: number } | undefined

export async function ensureService(): Promise<{ url: string; port: number }> {
  if (ownedEndpoint) return ownedEndpoint
  const port = Number(process.env.DSTERM_PORT) || 4598
  const url = `http://127.0.0.1:${port}`
  try {
    const server = startService()
    ownedServer = server
    ownedEndpoint = { url: `http://127.0.0.1:${server.port!}`, port: server.port! }
    return ownedEndpoint
  } catch (err) {
    const probe = await probeService(url)
    if (probe.ok) {
      if (probe.version !== undefined && probe.version !== serviceVersion)
        console.warn(`[dsterm] 复用端口 ${port} 上的服务实例 ${probe.version}（当前客户端 ${serviceVersion}）`)
      return { url, port }
    }
    if (!isPortInUse(err)) throw err
    const fallback = startService(0)
    console.warn(`[dsterm] 端口 ${port} 被非 dsterm 进程占用，已改用临时端口 ${fallback.port}`)
    ownedServer = fallback
    ownedEndpoint = { url: `http://127.0.0.1:${fallback.port!}`, port: fallback.port! }
    return ownedEndpoint
  }
}

export async function restartService() {
  if (ownedServer) {
    ownedServer.stop(true)
    ownedServer = undefined
    ownedEndpoint = undefined
  }
  return ensureService()
}

function isPortInUse(err: unknown) {
  const code = (err as { code?: string })?.code
  const message = err instanceof Error ? err.message : String(err)
  return code === "EADDRINUSE" || /address already in use|EADDRINUSE/i.test(message)
}

if (import.meta.main) {
  console.log(`[dsterm] 模式: ${creds ? "DeepSeek Web 直连" : "echo（未配置凭证，写入 ~/.config/dsterm/credentials.json 启用）"}`)
  const port = Number(process.env.DSTERM_PORT) || 4598
  try {
    const server = startService()
    console.log(`[dsterm] service listening on http://127.0.0.1:${server.port}`)
  } catch (err) {
    const probe = await probeService(`http://127.0.0.1:${port}`)
    if (probe.ok) {
      console.log(`[dsterm] 端口 ${port} 已有服务实例在运行，已复用`)
      console.log(`[dsterm] 若行为异常（旧代码残留），请先执行: lsof -ti :${port} | xargs kill -9`)
      process.exit(0)
    }
    throw err
  }
}
