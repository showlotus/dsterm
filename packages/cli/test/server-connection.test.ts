import { NodeFileSystem, NodeServices } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { OPENCODE_VERSION } from "../src/version"
import { expect, test } from "bun:test"
import { Console, Effect, FileSystem, Option, Scope } from "effect"
import { Command } from "effect/cli"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Commands, PrintLogs, Server, Standalone } from "../src/commands/commands"
import { Spec } from "../src/framework/spec"
import { ServerConnection } from "../src/services/server-connection"
import { ServiceConfig } from "../src/services/service-config"
import { isolatedEnv } from "./fixture/environment"

test("resolution defaults to the embedded dsterm service and honors explicit --server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-server-resolution-"))
  const server = Bun.serve({
    port: 0,
    fetch() {
      return Response.json({
        version: OPENCODE_VERSION,
        pid: process.pid,
        urls: [],
      })
    },
  })
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    const resolved = await runPromise(ServerConnection.resolve())

    expect(resolved.service).toBeDefined()
    expect(resolved.endpoint.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const info = await fetch(`${resolved.endpoint.url}/api/info`).then((response) => response.json())
    expect(info).toMatchObject({ hostname: "127.0.0.1" })

    const reconnected = await runPromise(resolved.service!.reconnect())
    expect(reconnected.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const reconnectedInfo = await fetch(`${reconnected.url}/api/info`).then((response) => response.json())
    expect(reconnectedInfo).toMatchObject({ hostname: "127.0.0.1" })

    const explicit = await runPromise(ServerConnection.resolve({ server: server.url.toString() }))
    expect(explicit.endpoint.url).toBe(server.url.toString())
    expect(explicit.service).toBeUndefined()
  } finally {
    await server.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("ensureService falls back to an ephemeral port when a foreign listener holds DSTERM_PORT", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-foreign-port-"))
  const foreign = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ hello: "world" }),
  })
  const child = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, "fixture/dsterm-service-lifecycle.ts"), "ensure"],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root, { DSTERM_PORT: String(foreign.port) }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const service = await resultReader(child.stdout)()
    expect(service.port).not.toBe(foreign.port)
    const info = await fetch(`${service.url}/api/info`).then((response) => response.json())
    expect(info).toMatchObject({ hostname: "127.0.0.1" })
    child.kill()
    const stderr = await new Response(child.stderr).text()
    expect(stderr).toContain("已改用临时端口")
  } finally {
    child.kill()
    await foreign.stop(true)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("ensureService reuses a running dsterm instance and rebinds after it exits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-reuse-"))
  const incumbent = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/info") return new Response(null, { status: 404 })
      return Response.json({
        version: "test-incumbent",
        pid: process.pid,
        hostname: "127.0.0.1",
        urls: [],
        paths: { config: `${process.env.HOME}/.config/dsterm` },
        capabilities: { chat: true },
      })
    },
  })
  const child = Bun.spawn(
    [process.execPath, "run", path.join(import.meta.dir, "fixture/dsterm-service-lifecycle.ts"), "ensure-reconnect"],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root, { DSTERM_PORT: String(incumbent.port) }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const nextResult = resultReader(child.stdout)
    const first = await nextResult()
    expect(first.port).toBe(incumbent.port)
    await incumbent.stop(true)
    const second = await nextResult()
    expect(second.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const info = await fetch(`${second.url}/api/info`).then((response) => response.json())
    expect(info).toMatchObject({ hostname: "127.0.0.1" })
  } finally {
    child.kill()
    await incumbent.stop(true).catch(() => {})
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("service options only require a matching version when requested", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-service-options-"))
  const layer = Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })
  const runPromise = <A, E>(effect: Effect.Effect<A, E, Global.Service | FileSystem.FileSystem | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(NodeFileSystem.layer), Effect.scoped))

  try {
    expect((await runPromise(ServiceConfig.options())).version).toBeUndefined()
    expect((await runPromise(ServiceConfig.options({ checkVersion: true }))).version).toBe(OPENCODE_VERSION)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("global --server and --standalone flags parse in any position for server-connecting commands and reject on local-only commands", async () => {
  const captured: Array<{
    readonly path: string
    readonly server: string | undefined
    readonly standalone: boolean
  }> = []

  function bindTree(
    node: Spec.Any,
    prefix: ReadonlyArray<string> = [],
  ): Command.Command<string, unknown, unknown, unknown, never> {
    const currentPath = [...prefix, node.name].join(" ")
    const withHandler = node.spec.pipe(
      Command.withHandler((input: Record<string, unknown>) =>
        Effect.gen(function* () {
          const serverFlag = yield* Effect.serviceOption(Server).pipe(Effect.map(Option.flatten))
          const standaloneFlag = yield* Effect.serviceOption(Standalone)
          const inputServer = Option.isOption(input.server)
            ? Option.getOrUndefined(input.server as Option.Option<string>)
            : undefined
          const inputStandalone = typeof input.standalone === "boolean" ? input.standalone : undefined
          captured.push({
            path: currentPath,
            server: inputServer ?? Option.getOrUndefined(serverFlag),
            standalone: inputStandalone ?? Option.getOrElse(standaloneFlag, () => false),
          })
        }),
      ),
    ) as Command.Command<string, unknown, unknown, unknown, never>
    const children = Object.values(node.commands)
    if (children.length === 0) return withHandler
    return withHandler.pipe(
      Command.withSubcommands(children.map((child) => bindTree(child, [...prefix, node.name]))),
    ) as Command.Command<string, unknown, unknown, unknown, never>
  }

  const silentConsole: Console.Console = Object.assign(Object.create(console), {
    log: () => {},
    error: () => {},
  })

  const runArgs = (args: ReadonlyArray<string>) =>
    Effect.runPromise(
      Command.runWith(bindTree(Commands).pipe(Command.withGlobalFlags([PrintLogs])), {
        version: OPENCODE_VERSION,
        renderErrors: false,
      })(args).pipe(Effect.provideService(Console.Console, silentConsole), Effect.provide(NodeServices.layer)),
    )

  const url = "http://127.0.0.1:43210"
  const serverCases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
    [["--server", url, "session", "list"], "dsterm session list"],
    [["session", "--server", url, "list"], "dsterm session list"],
    [["session", "list", "--server", url], "dsterm session list"],
    [["session", "--server", url, "delete", "ses_123"], "dsterm session delete"],
    [["--server", url, "plugin", "list"], "dsterm plugin list"],
    [["plugin", "--server", url, "list"], "dsterm plugin list"],
    [["plugin", "list", "--server", url], "dsterm plugin list"],
    [["plugin", "--server", url, "check"], "dsterm plugin check"],
    [["plugin", "--server", url, "update"], "dsterm plugin update"],
    [["--server", url, "mcp", "list"], "dsterm mcp list"],
    [["mcp", "--server", url, "list"], "dsterm mcp list"],
    [["mcp", "list", "--server", url], "dsterm mcp list"],
    [["mcp", "--server", url, "auth", "linear"], "dsterm mcp auth"],
    [["mcp", "--server", url, "logout", "linear"], "dsterm mcp logout"],
    [["auth", "--server", url, "list"], "dsterm auth list"],
    [["debug", "--server", url, "config"], "dsterm debug config"],
    [["debug", "--server", url, "agents"], "dsterm debug agents"],
    [["debug", "--server", url, "heap-dump"], "dsterm debug heap-dump"],
    [["--server", url, "models"], "dsterm models"],
    [["models", "--server", url], "dsterm models"],
    [["--server", url, "run", "hello"], "dsterm run"],
    [["run", "hello", "--server", url], "dsterm run"],
  ]

  for (const [args, expectedPath] of serverCases) {
    captured.length = 0
    await runArgs(args)
    expect(captured).toEqual([{ path: expectedPath, server: url, standalone: false }])
  }

  captured.length = 0
  await runArgs(["session", "--standalone", "list"])
  expect(captured).toEqual([{ path: "dsterm session list", server: undefined, standalone: true }])

  await expect(runArgs(["plugin", "add", "some-plugin", "--server", url])).rejects.toThrow()
  await expect(runArgs(["plugin", "remove", "some-plugin", "--server", url])).rejects.toThrow()
  await expect(runArgs(["mcp", "add", "my-mcp", "--url", "https://example.com/mcp", "--server", url])).rejects.toThrow()
  await expect(runArgs(["serve", "--server", url])).rejects.toThrow()
  await expect(runArgs(["--server", url, "serve"])).rejects.toThrow()
  await expect(runArgs(["service", "status", "--server", url])).rejects.toThrow()
  await expect(runArgs(["service", "--server", url, "start"])).rejects.toThrow()
})

test("local config commands do not start or require a server", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-local-config-cmd-"))
  try {
    const env = isolatedEnv(root)
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        path.join(import.meta.dir, "../src/index.ts"),
        "mcp",
        "add",
        "demo",
        "--global",
        "--url",
        "https://example.com/mcp",
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env,
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toContain('MCP server "demo" added')
    const config = await Bun.file(path.join(root, "config", "opencode.json")).json()
    expect(config).toMatchObject({
      mcp: {
        servers: {
          demo: { type: "remote", url: "https://example.com/mcp" },
        },
      },
    })
    expect(await Bun.file(path.join(root, "state", "opencode", ServiceConfig.filename())).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

function resultReader(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return async () => {
    for (;;) {
      const newline = buffer.indexOf("\n")
      if (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith("RESULT")) return JSON.parse(line.slice("RESULT ".length))
        continue
      }
      const { done, value } = await reader.read()
      if (done) throw new Error("fixture exited before printing a result")
      buffer += decoder.decode(value, { stream: true })
    }
  }
}
