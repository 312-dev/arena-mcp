# arena-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Are.na](https://www.are.na) — let an AI assistant create channels, save blocks from any URL, browse, and search your visual boards.

Are.na is a quieter, human-curated alternative to Pinterest: channels are boards, blocks are the things you pin (images, links, embeds, or text). This server exposes those primitives as MCP tools so a model can build and fill boards for you.

## Tools

| Tool | What it does |
| --- | --- |
| `arena_me` | The authenticated user's profile (name, slug, tier, counts). |
| `arena_list_my_channels` | List channels you own (title, slug, visibility, block count, URL). |
| `arena_get_channel` | Fetch a channel by slug plus a page of its blocks. |
| `arena_create_channel` | Create a channel. `visibility`: `public` \| `closed` \| `private`. |
| `arena_add_block` | Add a block to a channel by slug — `value` is any URL (image/link/embed) **or** Markdown text. |
| `arena_search` | Full-text search. **Requires an Are.na Premium subscription** (returns a clear error otherwise). |

## Setup

Requires Node 18+.

```bash
npm install
npm run build
```

### Authentication

Create a **personal access token** at [dev.are.na](https://dev.are.na) (New Application → the app page shows a personal access token) and expose it as an env var:

```bash
export ARENA_ACCESS_TOKEN="your-token"
```

A read-only token can browse; creating channels and blocks needs a **write-scoped** token.

### Register with your MCP client

Claude Code / Claude Desktop (`claude_desktop_config.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "arena": {
      "command": "node",
      "args": ["/absolute/path/to/arena-mcp/dist/index.js"],
      "env": { "ARENA_ACCESS_TOKEN": "your-token" }
    }
  }
}
```

## Notes on the Are.na API

- Built against the **v3 REST API** (`https://api.are.na/v3`). The v2 API is being wound down; authenticated and write endpoints there now return `401`/`410`.
- Channels use `visibility` (`public`/`closed`/`private`).
- Blocks are created at `POST /v3/blocks` with `{ value, channel_ids }`. A URL is saved as a *pending* block and finishes processing (fetching the image/title) a moment later server-side.
- `arena_search` hits `GET /v3/search`, which Are.na gates behind Premium.

## License

MIT
