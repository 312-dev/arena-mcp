import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { arena, ArenaError } from "./arena.js";
import { resolveImage } from "./pipeline.js";

// ---- helpers ---------------------------------------------------------------

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}
function fail(e: unknown) {
  const msg = e instanceof ArenaError ? e.message : e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true };
}
function ownerSlug(c: any): string | null { return c?.owner?.slug ?? c?.user?.slug ?? null; }
function channelUrl(c: any): string | null {
  const o = ownerSlug(c);
  return c?.slug && o ? `https://www.are.na/${o}/${c.slug}` : null;
}
function slimChannel(c: any) {
  if (!c) return c;
  return { id: c.id, title: c.title, slug: c.slug, visibility: c.visibility,
    blocks: c.counts?.contents ?? c.counts?.blocks ?? c.length ?? null, owner: ownerSlug(c), url: channelUrl(c) };
}
function flattenText(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return v.plain ?? v.markdown ?? null;
}
function slimBlock(b: any) {
  if (!b) return b;
  return { id: b.id, type: b.type ?? b.base_type ?? null, title: b.title ?? null,
    source: b.source?.url ?? (typeof b.source === "string" ? b.source : null),
    image: b.image?.src ?? b.image?.display?.url ?? null,
    content: flattenText(b.content), description: flattenText(b.description) };
}
function titleFromUrl(u: string): string {
  try {
    const seg = new URL(u).pathname.split("/").filter(Boolean).pop() || "";
    return seg.replace(/\.\w+$/, "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 80) || "Saved piece";
  } catch { return "Saved piece"; }
}

// ---- tool registration (shared by stdio + http) ----------------------------

export function registerTools(server: McpServer) {
  server.registerTool("arena_me",
    { title: "Get authenticated Are.na user", description: "Profile of the account the token belongs to.", inputSchema: {} },
    async () => {
      try { const me: any = await arena.me();
        return ok({ id: me.id, name: me.name, slug: me.slug, tier: me.tier, counts: me.counts });
      } catch (e) { return fail(e); }
    });

  server.registerTool("arena_list_my_channels",
    { title: "List my channels", description: "Channels owned by the authenticated user.",
      inputSchema: { per: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() } },
    async ({ per, page }) => {
      try { const me: any = await arena.me();
        const res: any = await arena.listUserContents(me.slug, per ?? 50, page ?? 1);
        return ok({ owner: me.slug, channels: (res.data ?? []).filter((x: any) => x.type === "Channel").map(slimChannel) });
      } catch (e) { return fail(e); }
    });

  server.registerTool("arena_get_channel",
    { title: "Get a channel and its contents", description: "Fetch a channel by slug with a page of its blocks.",
      inputSchema: { slug: z.string(), per: z.number().int().min(1).max(100).optional(), page: z.number().int().min(1).optional() } },
    async ({ slug, per, page }) => {
      try {
        const [c, contents]: [any, any] = await Promise.all([arena.getChannel(slug), arena.getChannelContents(slug, per ?? 24, page ?? 1)]);
        return ok({ ...slimChannel(c), total_blocks: contents.meta?.total_count, contents: (contents.data ?? []).map(slimBlock) });
      } catch (e) { return fail(e); }
    });

  server.registerTool("arena_create_channel",
    { title: "Create a channel", description: "Create a channel. visibility: public | closed | private.",
      inputSchema: { title: z.string(), visibility: z.enum(["public", "closed", "private"]).optional() } },
    async ({ title, visibility }) => {
      try { return ok(slimChannel(await arena.createChannel(title, visibility ?? "public"))); } catch (e) { return fail(e); }
    });

  server.registerTool("arena_add_block",
    { title: "Add a raw block to a channel",
      description: "Add a block from a URL or Markdown text WITHOUT image validation. For products prefer arena_add_product.",
      inputSchema: { channel_slug: z.string(), value: z.string(), description: z.string().optional() } },
    async ({ channel_slug, value, description }) => {
      try {
        const c: any = await arena.getChannel(channel_slug);
        if (!c?.id) return fail(new Error(`Channel '${channel_slug}' not found.`));
        return ok(slimBlock(await arena.addBlock(c.id, value, { description })));
      } catch (e) { return fail(e); }
    });

  // ---- the image-safe product tool (the pipeline as a tool) ----
  server.registerTool("arena_add_product",
    { title: "Add a product to a board (guaranteed real image)",
      description:
        "Add a product to a channel with a GUARANTEED real product photo. Resolves the image from the given URL " +
        "(and any fallbacks), rejecting dead/redirecting links, screenshot renders, blanks, and error pages. " +
        "If it can't get a real image it does NOT add a broken block — it returns an error asking for a better source " +
        "(a GOAT goat.com, Amazon /dp/, or garmentory product URL). Sets the product name as the block title.",
      inputSchema: {
        channel_slug: z.string().describe("Slug of the board to add to."),
        url: z.string().url().describe("Primary product-page URL."),
        title: z.string().optional().describe("Product name for the block title (recommended)."),
        note: z.string().optional().describe("Why it's a good pick / how to wear it (block description)."),
        fallback_urls: z.array(z.string().url()).optional().describe("Alternate product URLs to try if the primary is dead (e.g. GOAT/Amazon)."),
      } },
    async ({ channel_slug, url, title, note, fallback_urls }) => {
      try {
        const c: any = await arena.getChannel(channel_slug);
        if (!c?.id) return fail(new Error(`Channel '${channel_slug}' not found.`));
        const r = await resolveImage([url, ...(fallback_urls ?? [])]);
        if (!r) return fail(new Error(
          "No real product image could be resolved — the link is likely dead/redirecting or the retailer blocks bots. " +
          "Try a goat.com, amazon.com/dp/, or garmentory.com product URL in `url` or `fallback_urls`."));
        const t = title || titleFromUrl(r.src);
        const desc = [note, `shop: ${r.src}`].filter(Boolean).join(" · ");
        const b: any = await arena.addBlock(c.id, r.img, { title: t, description: desc });
        return ok({ added: t, board: channel_slug, image_via: r.how, image: r.info, block_id: b?.id });
      } catch (e) { return fail(e); }
    });

  server.registerTool("arena_add_products",
    { title: "Add several products to a board (guaranteed real images)",
      description: "Batch version of arena_add_product. Each item is {url, title?, note?, fallback_urls?}. Returns a per-item report; items with no real image are reported as skipped, never added broken.",
      inputSchema: {
        channel_slug: z.string(),
        items: z.array(z.object({
          url: z.string().url(), title: z.string().optional(), note: z.string().optional(),
          fallback_urls: z.array(z.string().url()).optional(),
        })).max(60),
      } },
    async ({ channel_slug, items }) => {
      try {
        const c: any = await arena.getChannel(channel_slug);
        if (!c?.id) return fail(new Error(`Channel '${channel_slug}' not found.`));
        const added: string[] = [], skipped: string[] = [];
        for (const it of items) {
          const r = await resolveImage([it.url, ...(it.fallback_urls ?? [])]);
          const t = it.title || titleFromUrl(it.url);
          if (!r) { skipped.push(t); continue; }
          const desc = [it.note, `shop: ${r.src}`].filter(Boolean).join(" · ");
          await arena.addBlock(c.id, r.img, { title: t, description: desc });
          added.push(t);
        }
        return ok({ board: channel_slug, added_count: added.length, skipped_count: skipped.length, added, skipped });
      } catch (e) { return fail(e); }
    });

  server.registerTool("arena_search",
    { title: "Search Are.na", description: "Full-text search. Requires an Are.na Premium subscription.",
      inputSchema: { query: z.string(), per: z.number().int().min(1).max(100).optional() } },
    async ({ query, per }) => {
      try {
        const res: any = await arena.search(query, per ?? 20);
        return ok({ total: res.meta?.total_count, results: (res.data ?? []).map((x: any) => x.type === "Channel" ? slimChannel(x) : slimBlock(x)) });
      } catch (e) { return fail(e); }
    });
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "arena-mcp", version: "0.2.0" });
  registerTools(server);
  return server;
}

// ---- boot: stdio locally, streamable HTTP on Fly ---------------------------

async function main() {
  if (process.env.MCP_HTTP === "1") {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    const AUTH = process.env.MCP_AUTH_TOKEN;
    app.get("/health", (_req, res) => res.json({ ok: true, name: "arena-mcp" }));
    app.post("/mcp", async (req, res) => {
      if (AUTH && req.header("authorization") !== `Bearer ${AUTH}`) {
        res.status(401).json({ error: "unauthorized" }); return;
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
    const port = Number(process.env.PORT || 8080);
    app.listen(port, () => console.error(`arena-mcp HTTP on :${port}`));
  } else {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    console.error("arena-mcp running on stdio");
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
