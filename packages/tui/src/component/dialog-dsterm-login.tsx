import { DialogPrompt } from "../ui/dialog-prompt"
import { type DialogContext, useDialog } from "../ui/dialog"
import { useClient } from "../context/client"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { Link } from "../ui/link"
import { errorMessage } from "../util/error"
import { syncDstermAuth } from "./dsterm-auth"

function tokenDescription() {
  const theme = useTheme().surface("dialog")
  return (
    <box gap={1}>
      <text fg={theme.text.muted} wrapMode="word">
        1. Open chat.deepseek.com and sign in
      </text>
      <Link href="https://chat.deepseek.com/" fg={theme.text.base}>
        chat.deepseek.com
      </Link>
      <text fg={theme.text.muted} wrapMode="word">
        2. DevTools → Application → Local Storage → copy the value of "userToken"
      </text>
    </box>
  )
}

function deviceDescription() {
  const theme = useTheme().surface("dialog")
  return (
    <box gap={1}>
      <text fg={theme.text.muted} wrapMode="word">
        DevTools → Network → request "POST /api/v0/users/auth_token/check_device" → copy "device_id" from its payload.
        Leave empty to skip (may trigger device risk control).
      </text>
    </box>
  )
}

export function DialogDstermLogin() {
  const dialog = useDialog()
  const client = useClient()
  const toast = useToast()

  function submit(userToken: string) {
    dialog.replace(() => (
      <DialogPrompt
        title="Device ID"
        description={deviceDescription}
        placeholder="device_id (optional)"
        onConfirm={(value) => {
          const deviceId = value.trim()
          const url = client.url
          if (!url) {
            toast.show({ message: "Service URL is unavailable", variant: "error", duration: 5000 })
            return
          }
          void fetch(`${url}/api/dsterm/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ userToken, deviceId }),
          })
            .then(async (resp) => {
              const body = await resp.json().catch(() => ({}))
              if (!resp.ok) throw new Error(body?.message ?? `HTTP ${resp.status}`)
              await syncDstermAuth(url)
              dialog.clear()
              toast.show({
                message: body?.warning ? `Credentials saved. ${body.warning}` : "Credentials saved and applied",
                variant: body?.warning ? "warning" : "success",
                duration: 5000,
              })
            })
            .catch((error) =>
              toast.show({
                message: `Failed to save credentials: ${errorMessage(error)}`,
                variant: "error",
                duration: 5000,
              }),
            )
        }}
        onCancel={() => dialog.clear()}
      />
    ))
  }

  return (
    <DialogPrompt
      title="DeepSeek credentials — userToken"
      description={tokenDescription}
      placeholder="userToken (required)"
      onConfirm={(value) => {
        const userToken = value.trim()
        if (!userToken) return
        submit(userToken)
      }}
      onCancel={() => dialog.clear()}
    />
  )
}

DialogDstermLogin.show = (dialog: DialogContext) => dialog.replace(() => <DialogDstermLogin />)
