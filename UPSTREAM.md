# Upstream 溯源

本仓库的 `packages/` 下 20 个包整体拷贝自 opencode 上游，用于改造为 DeepSeek Web 终端客户端（dsterm）。

- 上游仓库：https://github.com/sst/opencode
- 分支：`dev`
- 基准提交：`a8091a2ea0339424457bf73cfda9a37d0a2d97a3`
  （2026-10-30，`fix(app): add top inset to recently closed menu search (#60652)`）
- 拷贝时间：2026-10-31
- 对照标签：`opencode-upstream-a8091a2`（指向本次导入提交，后续改造用 `git diff opencode-upstream-a8091a2 -- packages/tui` 对比）

## 拷贝范围

packages/（源码未改动）：tui、client、core、ai、protocol、schema、plugin、plugin-browser、codemode、httpapi-codegen、http-recorder、server、cli、script、theme、ui、util、latex、merman、simulation

根配置（自上游合并）：package.json（workspaces.catalog 64 条 + patchedDependencies 18 条）、tsconfig.json、patches/

> 说明：cli/server/script 三个包经 git diff 校验与基准提交在内容上零差异（当时经由前一提交 `da87c475` 下载）。

## 与上游的已知偏差

1. `bunfig.toml` 增加 `linker = "hoisted"`：修复 isolated 安装下 `@opentui/core` 双实例导致的 `RGBA instanceof` 崩溃（TUI 启动即崩）
2. `workspaces` 收窄为 `packages/*`（上游为 32 包全量图）
3. `trustedDependencies` 仅保留 esbuild、node-pty、protobufjs
4. 未拷贝上游 `bun.lock`，依赖在本机以 npmmirror 重新解析生成
5. `packages/sdk`、`packages/service` 为 dsterm 自研占位目录（尚未创建，git 不追踪空目录）
