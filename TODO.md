# dsterm 待办与暂缓事项

## 暂缓：IDE 打开文件上下文注入（2026-10-31）

在 TUI 中探测当前 IDE（VSCode/Zed）打开的文件与选区，并随对话注入给 DeepSeek。**暂不实现注入，TUI 侧探测展示已通过 `config.prompt.editor` 默认值关闭。**

### 探测链路（TUI 原生，已可用，与 service 无关）

- VSCode：Claude Code 扩展在 `~/.claude/ide/<port>.lock` 写 lock（`{authToken, workspaceFolders, transport:"ws"}`）并开本地 WebSocket；TUI `discoverEditorConnection`（`packages/tui/src/editor.ts:45`）扫描 lock、按工作区匹配打分、直连扩展（MCP 协议），扩展实时推送 `selection_changed`（当前文件 + 选区文本 + 行范围）；`OPENCODE_EDITOR_SSE_PORT` / `CLAUDE_CODE_SSE_PORT` 环境变量可强制指定端口
- Zed：`ZED_TERM=true`（或 `TERM_PROGRAM=zed`）时轮询 Zed sqlite（`editor-zed.ts` `resolveZedSelection`）
- 展示：输入框下方显示当前文件/选区标签（`prompt/index.tsx` `fileContextEnabled`，配置项 `config.prompt.editor`，已通过 `~/.config/dsterm/cli.json` 的 `"prompt": {"editor": false}` 关闭，未改原生代码）

### 断裂点

TUI 提交 prompt 时，将 editor 上下文文本先经 `POST /api/session/:id/synthetic` 发给 service（`prompt/index.tsx` 提交流程，`formatEditorContext` 生成）。dsterm service 该路由为空实现（`() => json({})`），上下文被丢弃，DeepSeek 收不到。

### 实施方案（待做）

1. service 实现 synthetic 路由：收到 `{text}` 存入会话 pending context buffer
2. 下一个 `POST prompt` 到来时，buffer 内容拼在用户 prompt 前（上下文段 + 分隔 + 用户文本）发给 DeepSeek，消费后清空
3. 不进 transcript（与 TUI 端 synthetic 不显示的行为一致）；单附件失败降级不阻断对话

### 参考结论（同批探索）

- 文件上传协议已实现：`POST /api/v0/file/upload_file`（PoW，FormData 字段 `file`）→ `GET /file/fetch_files?file_ids=` 轮询至 `SUCCESS` → completion `ref_file_ids` 引用（`deepseek.ts` `uploadFileAndWait`）
- `@` 补全依赖 `GET /api/fs/find`（已实现：rg 优先 + 手动遍历兜底 + fuzzy 匹配）
