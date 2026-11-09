import { ensureService, probeService } from "@dsterm/service/server"

function hold() {
  return new Promise<void>((resolve) => {
    process.stdin.resume()
    process.stdin.once("end", resolve)
    process.stdin.once("close", resolve)
    process.stdin.once("error", resolve)
  })
}

const action = process.argv[2] ?? "ensure"

if (action === "ensure") {
  const service = await ensureService()
  console.log(`RESULT ${JSON.stringify(service)}`)
  await hold()
  process.exit(0)
}

if (action === "ensure-reconnect") {
  const first = await ensureService()
  console.log(`RESULT ${JSON.stringify(first)}`)
  for (let attempt = 0; attempt < 300; attempt++) {
    const probe = await probeService(`http://127.0.0.1:${first.port}`)
    if (!probe.ok) break
    await Bun.sleep(100)
  }
  const second = await ensureService()
  console.log(`RESULT ${JSON.stringify(second)}`)
  await hold()
  process.exit(0)
}

throw new Error(`unknown action: ${action}`)
