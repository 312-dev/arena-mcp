# arena-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for [Are.na](https://www.are.na) — create channels, browse, search, and add products to your boards **with guaranteed real product images**. Plus a weekly **Style Radar** that scans underground menswear trends and stages fresh finds.

Are.na is a quieter, human-curated alternative to Pinterest: channels are boards, blocks are the things you pin.

## Tools

| Tool | What it does |
| --- | --- |
| `arena_me` | The authenticated user's profile. |
| `arena_list_my_channels` | List channels you own. |
| `arena_get_channel` | Fetch a channel by slug + a page of its blocks. |
| `arena_create_channel` | Create a channel (`public`/`closed`/`private`). |
| `arena_add_block` | Add a raw block from a URL or Markdown (no image validation). |
| **`arena_add_product`** | **Add a product with a GUARANTEED real image.** Resolves the image (og:image + Are.na fetcher fallback), rejects dead/redirecting links, screenshot renders, blanks, and error pages; sets the product-name title. Refuses rather than add a broken block. |
| **`arena_add_products`** | Batch version — per-item report, skips (never adds) anything without a real image. |
| `arena_search` | Full-text search (requires Are.na Premium). |

`arena_add_product` accepts `fallback_urls` — if the primary link is dead it tries the fallbacks (a GOAT `goat.com`, Amazon `/dp/`, or garmentory product URL image-resolves reliably).

## The image pipeline (`src/pipeline.ts`)

The hard-won bit. For any candidate URL it: skips listing/search pages; scrapes `og:image` with a browser UA; **detects dead links** (a product URL that redirects off its `/products/` path to a catalog is dead); falls back to Are.na's own fetcher; and **pixel-validates** with `sharp` — rejecting `2560×2560` screenshot renders, blanks (`std<20`), error pages (`mean>248`), and tiny images. Only a real product photo gets added. Reliable image hosts: Carhartt WIP, Uniqlo, Nike (valid product URLs), Amazon `/dp/`, **GOAT**, garmentory product pages, watch retailers.

## Run

Requires Node 18+. `npm install && npm run build`.

**Local (stdio, for Claude Code / Desktop):**
```json
{ "mcpServers": { "arena": { "command": "node", "args": ["/abs/path/arena-mcp/dist/index.js"],
  "env": { "ARENA_ACCESS_TOKEN": "…" } } } }
```

**Remote (streamable HTTP, hosted on Fly):** set `MCP_HTTP=1` and it serves `POST /mcp` on `$PORT` behind a bearer token (`MCP_AUTH_TOKEN`). Deployed at `https://arena-mcp.fly.dev/mcp`. Connect from Claude Desktop / claude.ai as a custom connector with `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Get a personal access token at [dev.are.na](https://dev.are.na) → `ARENA_ACCESS_TOKEN` (write scope to create channels/blocks).

## Style Radar (`src/radar.ts`)

A weekly trend scanner (runs as a scheduled Fly machine, `node dist/radar.js`). It scrapes underground/enthusiast RSS (r/streetwear, r/rawdenim, r/goodyearwelt, r/malefashionadvice, Hypebeast, Highsnobiety, Die Workwear, Permanent Style, Put This On), then uses the Anthropic API **with web search** to find fresh, on-aesthetic pieces *and their real product URLs*, runs them through the image pipeline, and posts survivors to a **Radar** Are.na channel (a staging board you review). Env: `ANTHROPIC_API_KEY`, `RADAR_CHANNEL_SLUG`, `ARENA_ACCESS_TOKEN`.

## Deploy notes (v3 API)

Built against Are.na **v3** (`https://api.are.na/v3`; v2 writes are wound down). Blocks: `POST /v3/blocks {value, channel_ids}`; image URL under `image.src`; `visibility` not `status`; individual blocks can't be deleted (rebuild the channel). Search is Premium-gated.

## License

MIT
