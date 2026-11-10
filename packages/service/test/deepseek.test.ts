import { describe, expect, test } from "bun:test"
import { parseCompletionStream, type StreamEvent } from "../src/deepseek"

function sse(...payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const frames = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`)
  return new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
}

async function collect(...payloads: unknown[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = []
  for await (const evt of parseCompletionStream(sse(...payloads))) events.push(evt)
  return events
}

const join = (events: StreamEvent[], type: "think-delta" | "content-delta") =>
  events
    .filter((evt): evt is Extract<StreamEvent, { type: "think-delta" | "content-delta" }> => evt.type === type)
    .map((evt) => evt.content)
    .join("")

describe("parseCompletionStream", () => {
  test("legacy APPEND format separates think and response", async () => {
    const events = await collect(
      { v: { response: { status: "IN_PROGRESS", fragments: [{ type: "THINK" }] } } },
      { p: "response/fragments/-1/content", o: "APPEND", v: "思考中" },
      { p: "response/fragments", o: "APPEND", v: [{ type: "RESPONSE", content: "答案开头" }] },
      { p: "response/fragments/-1/content", o: "APPEND", v: "，答案继续" },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("思考中")
    expect(join(events, "content-delta")).toBe("答案开头，答案继续")
    expect(events.find((evt) => evt.type === "done")?.finishReason).toBe("stop")
  })

  test("SET fragments array registers RESPONSE and routes body deltas out of think", async () => {
    const events = await collect(
      { v: { response: { status: "IN_PROGRESS", fragments: [{ type: "THINK", content: "思考内容" }] } } },
      { p: "response/fragments/-1/content", o: "APPEND", v: "，更多思考" },
      { p: "response/fragments", o: "SET", v: [{ type: "THINK" }, { type: "RESPONSE", content: "Capital" }] },
      { p: "response/fragments/-1/content", o: "APPEND", v: "a Franței este Paris." },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("思考内容，更多思考")
    expect(join(events, "content-delta")).toBe("Capitala Franței este Paris.")
  })

  test("TEMPLATE_RESPONSE counts as body content", async () => {
    const events = await collect(
      { p: "response/fragments", o: "APPEND", v: [{ type: "THINK", content: "想" }] },
      { p: "response/fragments", o: "SET", v: [{ type: "THINK" }, { type: "TEMPLATE_RESPONSE", content: "模板答案" }] },
      { p: "response/fragments/-1/content", o: "APPEND", v: "，追加" },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("想")
    expect(join(events, "content-delta")).toBe("模板答案，追加")
  })

  test("APPEND accepts a single fragment object", async () => {
    const events = await collect(
      { p: "response/fragments", o: "APPEND", v: { type: "THINK", content: "单独对象" } },
      { p: "response/fragments/-1/content", o: "APPEND", v: "增量" },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("单独对象增量")
  })

  test("SET shrinks the fragment list and updates known types", async () => {
    const events = await collect(
      { p: "response/fragments", o: "APPEND", v: [{ type: "THINK", content: "a" }, { type: "RESPONSE", content: "b" }] },
      { p: "response/fragments", o: "SET", v: [{ type: "RESPONSE" }] },
      { p: "response/fragments/-1/content", o: "APPEND", v: "c" },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("a")
    expect(join(events, "content-delta")).toBe("bc")
  })

  test("unknown paths are ignored without breaking the stream", async () => {
    const events = await collect(
      { p: "response/fragments", o: "APPEND", v: [{ type: "THINK", content: "t" }] },
      { p: "response/fragments/-1/elapsed_secs", o: "SET", v: 1 },
      { p: "response/quasi_status", o: "SET", v: "OK" },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("t")
    expect(events.find((evt) => evt.type === "done")).toBeDefined()
  })

  test("deep search batches resolve inner paths against the fragment and keep sticky routing", async () => {
    const events = await collect(
      { v: { response: { status: "IN_PROGRESS", fragments: [{ type: "THINK" }] } } },
      { p: "response/fragments/-1/content", o: "APPEND", v: "阶段一思考" },
      {
        p: "response",
        o: "BATCH",
        v: [
          {
            p: "fragments",
            v: [
              { id: 2, type: "THINK", content: "阶段一思考" },
              { id: 3, type: "TOOL_SEARCH", status: "WIP", content: null, queries: [{ query: "上海 天气" }], results: [{ url: "https://a", title: "A" }] },
            ],
          },
          { p: "has_pending_fragment", v: false },
        ],
      },
      { p: "response/fragments/-1/results", o: "SET", v: [{ url: "https://a", title: "A" }] },
      {
        p: "response",
        o: "BATCH",
        v: [
          {
            p: "fragments",
            v: [
              { id: 2, type: "THINK", content: "阶段一思考" },
              { id: 3, type: "TOOL_SEARCH", status: "FINISHED", content: "搜索到 13 个网页" },
              { id: 4, type: "THINK", content: "阶段" },
            ],
          },
          { p: "has_pending_fragment", v: false },
        ],
      },
      { p: "response/fragments/-1/content", o: "APPEND", v: "二思考" },
      {
        p: "response/fragments",
        o: "SET",
        v: [
          { id: 2, type: "THINK", content: "阶段一思考" },
          { id: 3, type: "TOOL_SEARCH", status: "FINISHED", content: "搜索到 13 个网页" },
          { id: 4, type: "THINK", content: "阶段二思考" },
          { id: 9, type: "RESPONSE", content: "答案开头" },
        ],
      },
      {
        p: "response/fragments/-1",
        o: "BATCH",
        v: [
          { p: "references", v: [{ id: 5, type: "TOOL_OPEN" }] },
          { p: "content", o: "APPEND", v: "[reference:0]" },
        ],
      },
      { v: "，答案继续" },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("阶段一思考阶段二思考")
    expect(join(events, "content-delta")).toBe("答案开头[reference:0]，答案继续")
    expect(events.some((evt) => evt.type === "search-start")).toBe(true)
    expect(events.some((evt) => evt.type === "search-results")).toBe(true)
    expect(events.find((evt) => evt.type === "done")?.finishReason).toBe("stop")
  })

  test("text streamed during a pending window is recovered by the next list sync", async () => {
    const events = await collect(
      { v: { response: { status: "IN_PROGRESS", fragments: [{ type: "THINK" }] } } },
      { p: "response/fragments/-1/content", o: "APPEND", v: "搜索前思考" },
      {
        p: "response",
        o: "BATCH",
        v: [
          {
            p: "fragments",
            v: [
              { id: 2, type: "THINK", content: "搜索前思考" },
              { id: 3, type: "TOOL_SEARCH", status: "WIP", content: null },
            ],
          },
        ],
      },
      { p: "response/fragments/-1/content", o: "APPEND", v: "搜索后思考" },
      {
        p: "response",
        o: "BATCH",
        v: [
          {
            p: "fragments",
            v: [
              { id: 2, type: "THINK", content: "搜索前思考" },
              { id: 3, type: "TOOL_SEARCH", status: "FINISHED", content: "搜索到 13 个网页" },
              { id: 4, type: "THINK", content: "搜索后思考" },
            ],
          },
        ],
      },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "think-delta")).toBe("搜索前思考搜索后思考")
  })

  test("bare citation op arrays after a citation batch stay on the fragment", async () => {
    const events = await collect(
      { v: { response: { status: "IN_PROGRESS", fragments: [{ type: "THINK" }, { type: "RESPONSE", content: "" }] } } },
      {
        p: "response/fragments/-1",
        o: "BATCH",
        v: [
          { p: "content", o: "APPEND", v: "[reference:0]" },
          { p: "references", o: "SET", v: [{ id: 5, type: "TOOL_OPEN" }] },
        ],
      },
      { v: [{ p: "content", o: "APPEND", v: "[reference:1]" }, { p: "references", v: [{ id: 6, type: "TOOL_OPEN" }] }] },
      { p: "response/fragments/-1/content", o: "APPEND", v: "正文" },
      { p: "response/status", o: "SET", v: "FINISHED" },
    )
    expect(join(events, "content-delta")).toBe("[reference:0][reference:1]正文")
  })
})
