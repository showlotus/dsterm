<p align="center">
  <picture>
    <source srcset="./logo-dark.png" media="(prefers-color-scheme: dark)">
    <source srcset="./logo-light.png" media="(prefers-color-scheme: light)">
    <img src="./logo-light.png" alt="dsterm logo">
  </picture>
</p>

<p align="center"><i>Run <b>DeepSeek Web</b> in the terminal, using the <a href="https://github.com/sst/opencode" target="_blank">opencode</a> TUI.</i></p>

dsterm is a thin bridge, not an agent: the opencode TUI provides the interface, and a local
service forwards your messages to your own DeepSeek Web session, then streams the reply back
(reasoning and web-search sources included). It has **no tool calling**, and cannot run commands
or edit files on your behalf. Web search, when used, happens on DeepSeek's side; dsterm only
displays the returned sources.

No API key is required — dsterm talks to the DeepSeek Web chat endpoint using the `userToken`
from your browser session, not the official API. See [Sign in](#sign-in) for setup.

The TUI is forked from opencode (see [UPSTREAM.md](UPSTREAM.md)); the agent/tool layer is not used.

## Install

```bash
# run without installing
npx @showlotus/dsterm

# or install globally (provides both `dsterm` and `dst` commands)
npm install -g @showlotus/dsterm
```

## Sign in

1. Open [chat.deepseek.com](https://chat.deepseek.com) and sign in.
2. DevTools → Application → Local Storage → copy the value of `userToken`.
3. In dsterm, press `ctrl+p` and run **Configure DeepSeek credentials**, then paste the token.
   - Optional: paste `device_id` from the `POST /api/v0/users/auth_token/check_device` request
     payload to reduce device risk-control prompts.

You can also set `DSTERM_USER_TOKEN` (and optionally `DSTERM_DEVICE_ID`) before launching dsterm.
Credentials are stored in `~/.config/dsterm/credentials.json` with `0600` permissions.

## Usage

```bash
dsterm    # or the shorthand: dst
```

## Platform support

Prebuilt binaries are published for every target below; npm installs the right one automatically.

| Platform | Architecture |
| -------- | ------------ |
| macOS | arm64 (Apple Silicon), x64 (Intel) |
| Linux (glibc) | arm64, x64 |
| Linux (musl) | arm64, x64 |
| Windows | x64 |

Windows on ARM runs the x64 build under emulation.

Installing on an unsupported platform fails with a clear
`dsterm does not provide a binary for ...` message.

## Development

Requires [Bun](https://bun.sh).

```bash
bun install    # install workspace dependencies
bun run dev    # run the service in dev mode
```

Build, pack and publish live in `packages/cli/script/`:

```bash
bun script/build.ts     # compile the dsterm binary
bun script/pack.ts      # assemble npm tarballs into dist/npm
bun script/publish.ts   # build + pack + publish to npm
```

Releases are published by GitHub Actions when a `v*` tag is pushed (the tag must match the version
in the root `package.json`). To publish an alpha build locally:

```bash
bun run publish:alpha
```

## License

[MIT](packages/cli/package.json)
