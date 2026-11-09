import { createSignal } from "solid-js"

const [authed, setAuthed] = createSignal(false)

export function dstermAuthed() {
  return authed()
}

export async function syncDstermAuth(url: string | undefined) {
  if (!url) return
  try {
    const resp = await fetch(`${url}/api/dsterm/credentials`)
    const body = await resp.json().catch(() => ({}))
    setAuthed(Boolean(body?.configured))
  } catch {
    return
  }
}
