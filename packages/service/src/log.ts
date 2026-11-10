import { appendFileSync, mkdirSync } from "node:fs"

const logDir = `${process.env.HOME}/.config/dsterm/logs`

export function log(message: string) {
  try {
    mkdirSync(logDir, { recursive: true })
    appendFileSync(`${logDir}/service.log`, `${new Date().toISOString()} ${message}\n`)
  } catch {}
}
