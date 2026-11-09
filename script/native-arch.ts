const HEADER_SIZE = 64 * 1024

export namespace NativeArch {
  export async function verify(binary: string, arch: "arm64" | "x64") {
    const handle = Bun.file(binary)
    if (!(await handle.exists())) throw new Error(`Binary not found: ${binary}`)
    const header = Buffer.from(await handle.slice(0, HEADER_SIZE).arrayBuffer())
    const detected = detect(header)
    if (detected !== arch)
      throw new Error(`Binary architecture mismatch: expected ${arch}, detected ${detected ?? "unknown"}: ${binary}`)
  }
}

function detect(header: Buffer): "arm64" | "x64" | undefined {
  if (header.length < 20) return
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    const machine = header.readUInt16LE(18)
    if (machine === 0xb7) return "arm64"
    if (machine === 0x3e) return "x64"
    return
  }
  if (header[0] === 0x4d && header[1] === 0x5a) {
    const offset = header.readUInt32LE(0x3c)
    if (offset + 6 > header.length) return
    if (header.readUInt32LE(offset) !== 0x00004550) return
    const machine = header.readUInt16LE(offset + 4)
    if (machine === 0xaa64) return "arm64"
    if (machine === 0x8664) return "x64"
    return
  }
  if (header.readUInt32LE(0) === 0xfeedfacf) return cpuType(header.readUInt32LE(4))
  if (header.readUInt32BE(0) === 0xfeedfacf) return cpuType(header.readUInt32BE(4))
  return
}

function cpuType(value: number): "arm64" | "x64" | undefined {
  if (value === 0x0100000c) return "arm64"
  if (value === 0x01000007) return "x64"
  return
}
