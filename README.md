# dsterm

<p align="center">
  <picture>
    <source srcset="./logo-dark.png" media="(prefers-color-scheme: dark)">
    <source srcset="./logo-light.png" media="(prefers-color-scheme: light)">
    <img src="./logo-light.png" alt="dsterm logo">
  </picture>
</p>

Terminal AI coding agent with an embedded DeepSeek web service — launch the TUI and start coding with DeepSeek, no API key setup required.

A fork of [opencode](https://github.com/sst/opencode), reworked into a standalone DeepSeek terminal client (see [UPSTREAM.md](UPSTREAM.md)).

> **Alpha** — currently built and published for **macOS (Apple Silicon)** only.

## Install

```bash
# run without installing
npx @showlotus/dsterm@alpha

# or install globally (provides both `dsterm` and `dst` commands)
npm install -g @showlotus/dsterm
```

## Usage

```bash
dsterm    # or the shorthand: dst
```

## Platform support (alpha)

| Platform | Architecture        | Status        |
| -------- | ------------------- | ------------- |
| macOS    | arm64 (Apple Silicon) | published   |
| Other platforms | —            | planned       |

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

Release from the repository root (version is read from `package.json`):

```bash
bun run publish:alpha
```

## License

[MIT](packages/cli/package.json)
