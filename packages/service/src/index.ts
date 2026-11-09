if (!process.argv.includes("--tui")) {
  console.error("用法: bun run dev（等价于 bun run src/index.ts --tui）")
  process.exit(1)
}

const { spawn } = await import("node:child_process")
const fs = await import("node:fs")
const path = await import("node:path")
const serviceDir = path.dirname(Bun.fileURLToPath(import.meta.url))
const cliRoot = path.resolve(serviceDir, "../../cli")
const logDir = `${process.env.HOME}/.config/dsterm/logs`
fs.mkdirSync(logDir, { recursive: true })
const logFd = fs.openSync(`${logDir}/service.log`, "a")

const servicePkgDir = path.resolve(serviceDir, "..")
const service = spawn("bun", ["run", "src/server.ts"], { cwd: servicePkgDir, stdio: ["ignore", logFd, logFd] })
const url = `http://127.0.0.1:${process.env.DSTERM_PORT || 4598}`

let ready = false
for (let i = 0; i < 50; i++) {
  try {
    const resp = await fetch(`${url}/api/info`)
    if (resp.ok) { ready = true; break }
  } catch {}
  await new Promise((r) => setTimeout(r, 200))
}
if (!ready) {
  console.error("[dsterm] service 启动失败，日志见 ~/.config/dsterm/logs/service.log")
  service.kill()
  process.exit(1)
}

const tui = spawn("bun", ["run", "--cwd", cliRoot, "src/index.ts", "--server", url], { stdio: "inherit" })
const cleanup = () => {
  try { service.kill() } catch {}
}
tui.on("exit", (code) => {
  cleanup()
  process.exit(code ?? 0)
})
process.on("SIGINT", () => {
  cleanup()
  process.exit(0)
})
