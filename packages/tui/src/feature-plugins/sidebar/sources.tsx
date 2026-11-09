import { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Locale } from "../../util/locale"
import { Link } from "../../ui/link"

interface SourceItem {
  url: string
  title: string
  site_name?: string
}

interface SourceRound {
  messageID: string
  label: string
  sources: SourceItem[]
}

const LABEL_MAX = 24

function collectRounds(context: Plugin.Context, sessionID: string): SourceRound[] {
  const messages = context.data.session.message.list(sessionID)
  const rounds: SourceRound[] = []
  let lastUserText = ""
  for (const message of messages) {
    if (message.type === "user") {
      lastUserText = message.text ?? ""
      continue
    }
    if (message.type !== "assistant") continue
    const sources: SourceItem[] = []
    const seen = new Set<string>()
    for (const part of message.content) {
      if (part.type !== "tool" || part.name !== "websearch" || part.state.status !== "completed") continue
      const text = part.state.content.find((item) => item.type === "text")?.text
      if (!text) continue
      try {
        const parsed = JSON.parse(text)
        for (const source of parsed.sources ?? []) {
          if (typeof source?.url !== "string" || seen.has(source.url)) continue
          seen.add(source.url)
          sources.push({
            url: source.url,
            title: typeof source.title === "string" ? source.title : source.url,
            site_name: typeof source.site_name === "string" ? source.site_name : undefined,
          })
        }
      } catch {}
    }
    if (sources.length > 0) {
      rounds.push({
        messageID: message.id,
        label: Locale.truncate(lastUserText.replace(/\s+/g, " ").trim() || "Search sources", LABEL_MAX),
        sources,
      })
    }
  }
  return rounds
}

function groupBySite(sources: SourceItem[]) {
  const bySite = new Map<string, SourceItem[]>()
  for (const source of sources) {
    const site = source.site_name ?? new URL(source.url).hostname
    const list = bySite.get(site) ?? []
    list.push(source)
    bySite.set(site, list)
  }
  return [...bySite.entries()]
}

export function SidebarSources(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  const [expanded, setExpanded] = createSignal(false)
  const [roundOverrides, setRoundOverrides] = createSignal<Record<string, boolean>>({})
  const rounds = createMemo(() => collectRounds(props.context, props.sessionID))
  const total = createMemo(() => rounds().reduce((sum, round) => sum + round.sources.length, 0))
  const multi = createMemo(() => rounds().length > 1)
  const roundExpanded = (id: string) => {
    const override = roundOverrides()[id]
    if (override !== undefined) return override
    return false
  }
  const toggleRound = (id: string) => {
    setRoundOverrides((prev) => ({ ...prev, [id]: !roundExpanded(id) }))
  }

  return (
    <Show when={total() > 0}>
      <box>
        <box onMouseUp={() => setExpanded((prev) => !prev)}>
          <text fg={theme.text.base}>
            {multi()
              ? `${expanded() ? "-" : "+"} Sources · ${total()} sources · ${rounds().length} rounds`
              : `${expanded() ? "-" : "+"} Sources · ${total()}`}
          </text>
        </box>
        <Show when={expanded()}>
          <For each={rounds()}>
            {(round) => {
              const collapsed = () => multi() && !roundExpanded(round.messageID)
              return (
                <box marginTop={multi() ? 1 : 0}>
                  <Show
                    when={multi()}
                    fallback={
                      <box paddingLeft={3}>
                        <For each={groupBySite(round.sources)}>
                          {([site, items]) => (
                            <box marginTop={1}>
                              <text fg={theme.text.muted}>{site}</text>
                              <For each={items}>
                                {(item) => (
                                  <Link href={item.url} fg={theme.text.base} wrapMode="word">
                                    {` - ${item.title}`}
                                  </Link>
                                )}
                              </For>
                            </box>
                          )}
                        </For>
                      </box>
                    }
                  >
                    <box
                      paddingLeft={1}
                      onMouseUp={() => toggleRound(round.messageID)}
                    >
                      <text fg={theme.text.base}>
                        {`${collapsed() ? "+" : "-"} ${round.label} (${round.sources.length})`}
                      </text>
                    </box>
                    <Show when={!collapsed()}>
                      <box paddingLeft={3}>
                        <For each={groupBySite(round.sources)}>
                          {([site, items]) => (
                            <box marginTop={1}>
                              <text fg={theme.text.muted}>{site}</text>
                              <For each={items}>
                                {(item) => (
                                  <Link href={item.url} fg={theme.text.base} wrapMode="word">
                                    {` - ${item.title}`}
                                  </Link>
                                )}
                              </For>
                            </box>
                          )}
                        </For>
                      </box>
                    </Show>
                  </Show>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "dsterm.sidebar.sources",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarSources context={context} sessionID={props.sessionID} />,
    })
  },
})
