# figma-mcp

MCP server that connects AI agents (Cursor, Claude Code) to Figma: read node trees, classify assets, export SVG/PNG, and measure layout gaps.

```
Agent ←stdio→ MCP server ←WebSocket→ relay (port 3055) ←WebSocket→ Figma plugin
```

| Path | Role |
|------|------|
| `src/talk_to_figma_mcp/server.ts` | MCP server (built to `dist/`) |
| `src/socket.ts` | WebSocket relay |
| `src/cursor_mcp_plugin/` | Figma plugin (`code.js`, `ui.html`) |

## Setup

1. Install [Bun](https://bun.sh), then from the repo root:

```bash
bun install
bun setup          # writes .cursor/mcp.json and .mcp.json
bun socket         # relay on ws://localhost:3055
```

2. In Figma: **Plugins → Development → Link existing plugin** → `src/cursor_mcp_plugin/manifest.json`, run the plugin, and join the same channel the agent uses.

3. In the agent: call `list_channels` / `join_channel` before any Figma command.

### MCP config

Published package (from `bun setup`):

```json
{
  "mcpServers": {
    "figma-mcp": {
      "command": "bunx",
      "args": ["figma-mcp@latest"]
    }
  }
}
```

Local development:

```json
{
  "mcpServers": {
    "figma-mcp": {
      "command": "bun",
      "args": ["/absolute/path/to/figma-mcp/src/talk_to_figma_mcp/server.ts"]
    }
  }
}
```

## Tools

| Tool | Purpose |
|------|---------|
| `list_channels` | Active relay channels (name, client count, description) |
| `join_channel` | Join by name and/or `channel_description` (auto-match or create) |
| `get_node_info` | Single node tree (filtered) |
| `get_nodes_info` | Batch node trees |
| `get_asset` | Asset prediction scores and `exportNodeIds` |
| `export_node_as_svg` | SVG string; optional `writePath` + `outputDir` |
| `export_node_as_image` | PNG (base64 or file); `scale` 2–4 for retina |
| `measure_gap_between` | Edge gap and offsets between two nodes |

Node IDs: Figma API form (`2403:34143`), URL form (`2403-34143`), or instance path (`I2403-34143-…`).

## Notes for agents

- **`join_channel` first** — no Figma calls work until the MCP server and plugin share a channel.
- **Unpainted nodes** — `get_node_info` / `get_nodes_info` omit children with `absoluteRenderBounds: null`; do not emit HTML for them.
- **Export** — prefer `export_node_as_svg` when the subtree has **< 3** vector primitives and SVG is **≤ 8 KB**; otherwise `export_node_as_image` (`scale: 2`–`4`). Use `outputDir` to write under your project (absolute or relative to MCP server cwd).
- **WSL** — uncomment `hostname: "0.0.0.0"` in `src/socket.ts` if the plugin cannot reach the relay.

## Development

```bash
bun run build      # tsup → dist/
bun run dev        # watch build
bun run start      # run dist/server.js
```

Plugin sources are edited directly in `src/cursor_mcp_plugin/` (no separate plugin build).

## License

MIT
