#!/usr/bin/env bun
import path from "node:path"
import rootPackage from "../../../package.json"
import { npmDir } from "@opencode/script/pack"

const dir = path.resolve(import.meta.dirname, "..")
const registry = "https://registry.npmjs.org"
const name = "@showlotus/dsterm"
const tag = process.argv.find((arg) => arg.startsWith("--tag="))?.slice("--tag=".length) ?? "alpha"
const otp = process.argv.find((arg) => arg.startsWith("--otp="))?.slice("--otp=".length)
const skipBuild = process.argv.includes("--skip-build")
const version = rootPackage.version
if (!version) throw new Error("no version field in the repository root package.json")
const targetArg = process.argv.find((arg) => arg.startsWith("--target="))?.slice("--target=".length)
const platform = process.platform === "win32" ? "windows" : process.platform
const target = targetArg ?? `${platform}-${process.arch}`
const env = {
  ...process.env,
  OPENCODE_VERSION: version,
  OPENCODE_CHANNEL: process.env.OPENCODE_CHANNEL ?? "alpha",
  ...(target !== "all" ? { OPENCODE_TARGET: target } : {}),
}

function run(command: string[], options: { env?: typeof process.env; stdin?: boolean } = {}) {
  console.log(`+ ${command.join(" ")}`)
  const result = Bun.spawnSync(command, {
    ...(options.env ? { env: options.env } : {}),
    cwd: dir,
    stdout: "inherit",
    stderr: "inherit",
    stdin: options.stdin ? "inherit" : "ignore",
  })
  if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}: ${command.join(" ")}`)
}

function capture(command: string[]) {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  return { code: result.exitCode, out: result.stdout?.toString().trim() ?? "" }
}

const publishArgs = ["--tag", tag, "--registry", registry, "--access", "public", ...(otp ? ["--otp", otp] : [])]

async function published(packageName: string) {
  return capture(["npm", "view", `${packageName}@${version}`, "version", "--registry", registry]).code === 0
}

const login = capture(["npm", "whoami", "--registry", registry])
if (login.code !== 0) throw new Error("not logged in to npm, run `npm login` first")
console.log(`npm user: ${login.out}`)

const existing = capture(["npm", "view", `${name}@${version}`, "version", "--registry", registry])
if (existing.code === 0) throw new Error(`${name}@${version} is already published`)
console.log(`${name}@${version} is ready to publish`)

if (!skipBuild) {
  console.log(`building target: ${target}`)
  run(["bun", "install", "--os=*", "--cpu=*", "--libc=*"])
  run(["bun", "script/build.ts", "--skip-web-ui"], { env, stdin: true })
  run(["bun", "script/pack.ts"], { env, stdin: true })
}

const files = [...new Bun.Glob(`*-${version}.tgz`).scanSync({ cwd: npmDir })].sort()
const main = `${name.replace("@", "").replace("/", "-")}-${version}.tgz`
if (!files.includes(main)) throw new Error(`missing ${path.join(npmDir, main)}`)
const platforms = files.filter((file) => file !== main)
if (!platforms.length) throw new Error(`no platform tarballs found in ${npmDir}`)
console.log(`publishing ${files.length} tarballs: ${files.join(", ")}`)
for (const file of platforms) {
  const packageName = file.slice(0, -`.tgz`.length).replace(`-${version}`, "")
  if (await published(packageName)) {
    console.log(`skipping ${packageName} (already published)`)
    continue
  }
  run(["npm", "publish", path.join(npmDir, file), ...publishArgs], { stdin: true })
}
if (!(await published(name))) run(["npm", "publish", path.join(npmDir, main), ...publishArgs], { stdin: true })
else console.log(`skipping ${name} (already published)`)

const check = capture(["npm", "view", name, "dist-tags", "--registry", registry])
if (check.code !== 0)
  console.log(`warning: dist-tags check failed (registry propagation delay), verify later: npm view ${name} dist-tags`)
else console.log(`dist-tags: ${check.out}`)
console.log(`published ${name}@${version} with dist-tag ${tag}`)
