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
    description: flattenText(c.description),
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
function firstTextBlock(contents: any): any | null {
  const data = contents?.data ?? [];
  return data.find((b: any) => ((b?.type ?? b?.base_type) === "Text") || flattenText(b?.content) != null) ?? null;
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
      try {
        const me: any = await arena.me();
        const size = per ?? 100;
        // Sweep EVERY page. Are.na's list endpoint returns partial/stale single pages,
        // so a one-page read can make channels look missing. Cap the loop as a backstop.
        const all: any[] = [];
        for (let p = page ?? 1, i = 0; i < 20; p++, i++) {
          const res: any = await arena.listUserContents(me.slug, size, p);
          const data = res.data ?? [];
          all.push(...data);
          if (data.length < size) break;
        }
        // Hide internal __ scratch channels (pipeline byproducts) so they never
        // pollute the board list or make a client miscount.
        const seen = new Set<number>();
        const channels: any[] = [];
        for (const x of all) {
          if (x.type !== "Channel" || String(x.title ?? "").startsWith("__")) continue;
          if (x.id != null && seen.has(x.id)) continue; // de-dupe overlap across pages
          if (x.id != null) seen.add(x.id);
          channels.push(slimChannel(x));
        }
        return ok({ owner: me.slug, count: channels.length, channels });
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
    { title: "Create a channel", description: "Create a channel. visibility: public | closed | private. Optional Markdown description for the board itself.",
      inputSchema: {
        title: z.string(),
        visibility: z.enum(["public", "closed", "private"]).optional(),
        description: z.string().optional().describe("Board (channel) description, Markdown."),
      } },
    async ({ title, visibility, description }) => {
      try { return ok(slimChannel(await arena.createChannel(title, visibility ?? "public", description))); } catch (e) { return fail(e); }
    });

  server.registerTool("arena_update_channel",
    { title: "Update a channel's title / description / visibility",
      description: "Update an existing board (channel): change its title, its description (Markdown), and/or visibility. Only the fields you pass are modified; pass an empty description string to clear it.",
      inputSchema: {
        channel_slug: z.string().describe("Slug of the board to update."),
        title: z.string().optional(),
        description: z.string().optional().describe("Board (channel) description, Markdown."),
        visibility: z.enum(["public", "closed", "private"]).optional(),
      } },
    async ({ channel_slug, title, description, visibility }) => {
      try { return ok(slimChannel(await arena.updateChannel(channel_slug, { title, description, visibility }))); } catch (e) { return fail(e); }
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

  server.registerTool("arena_remove_block",
    { title: "Remove a block from a board",
      description:
        "Remove a block from a channel (e.g. a piece that no longer fits the brief). Are.na can't delete a " +
        "block entity (405), but this deletes its CONNECTION to the board, which detaches it from that board " +
        "(the block itself is not destroyed). Pass the board slug and the block_id from arena_get_channel.",
      inputSchema: {
        channel_slug: z.string().describe("Board to remove the block from."),
        block_id: z.number().int().describe("Block id to remove (get it from arena_get_channel)."),
      } },
    async ({ channel_slug, block_id }) => {
      try {
        const c: any = await arena.getChannel(channel_slug);
        if (!c?.id) return fail(new Error(`Channel '${channel_slug}' not found.`));
        // The connection id lives on the channel-contents item, not on /blocks/:id/connections.
        let connId: number | null = null, title: string | null = null;
        for (let p = 1; p <= 20 && connId == null; p++) {
          const res: any = await arena.getChannelContents(channel_slug, 100, p);
          const data = res.data ?? [];
          const hit = data.find((b: any) => b.id === block_id);
          if (hit) { connId = hit.connection?.id ?? null; title = hit.title ?? null; }
          if (data.length < 100) break;
        }
        if (connId == null) return fail(new Error(`Block ${block_id} is not on '${channel_slug}'.`));
        await arena.removeConnection(connId);
        return ok({ removed: block_id, title, board: channel_slug });
      } catch (e) { return fail(e); }
    });

  // ---- the image-safe product tool (the pipeline as a tool) ----
  server.registerTool("arena_add_product",
    { title: "Add a product to a board (guaranteed real image)",
      description:
        "Add a product to a channel with a real product photo. Resolves the image from the given URL (and any " +
        "fallbacks), rejecting dead/redirecting links, screenshot renders, blanks, and error pages. If the page has " +
        "no usable image it SEARCHES the web for a real photo of the product by name (Brave Images); if even that " +
        "fails it still adds the product as a link block with the shop URL in the description. NEVER rejects a " +
        "product. Sets the product name as the block title.",
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
        const t = title || titleFromUrl(url);
        // Try the product's own image; fall back to a web image search by name.
        const r = await resolveImage([url, ...(fallback_urls ?? [])], t);
        if (r) {
          const desc = [note, `shop: ${url}`].filter(Boolean).join(" · ");
          const b: any = await arena.addBlock(c.id, r.img, { title: t, description: desc });
          return ok({ added: t, board: channel_slug, image_via: r.how, image: r.info, block_id: b?.id });
        }
        // Never reject a product: add it as a link block (Are.na builds its own preview).
        const b: any = await arena.addBlock(c.id, url, { title: t, description: [note].filter(Boolean).join(" · ") });
        return ok({ added: t, board: channel_slug, image_via: "link", note: "no image found; added as a link block", block_id: b?.id });
      } catch (e) { return fail(e); }
    });

  server.registerTool("arena_add_products",
    { title: "Add several products to a board (guaranteed real images)",
      description: "Batch version of arena_add_product. Each item is {url, title?, note?, fallback_urls?}. EVERY item is added: with its product photo when the page has one, else a web-searched photo (by name), else as a link block. Never skips a product. Returns how each item got its image (og/arena/search/link).",
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
        const added: string[] = [];
        const image_via: Record<string, string> = {};
        for (const it of items) {
          const t = it.title || titleFromUrl(it.url);
          const r = await resolveImage([it.url, ...(it.fallback_urls ?? [])], t);
          if (r) {
            const desc = [it.note, `shop: ${it.url}`].filter(Boolean).join(" · ");
            await arena.addBlock(c.id, r.img, { title: t, description: desc });
            image_via[t] = r.how;
          } else {
            // Never skip: add as a link block so the product still lands on the board.
            await arena.addBlock(c.id, it.url, { title: t, description: [it.note].filter(Boolean).join(" · ") });
            image_via[t] = "link";
          }
          added.push(t);
        }
        return ok({ board: channel_slug, added_count: added.length, added, image_via });
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

  // ---- style evolution: journal (capture) + directives (live layer) ----
  // The mens-style skill is the durable brain; these keep it evolving:
  //  - style_log appends a raw learning to the Style Journal (append-only capture).
  //  - style_directives reads the living directives doc (the mutable layer the skill loads).
  //  - style_set_directives edits that doc in place (the fast loop).
  // A periodic /style-review promotes durable journal learnings into the skill (the slow loop).
  const JOURNAL = () => process.env.STYLE_JOURNAL_SLUG || "style-journal";
  const DIRECTIVES = () => process.env.STYLE_DIRECTIVES_SLUG || "style-directives";

  server.registerTool("style_log",
    { title: "Log a style learning",
      description:
        "Append a durable style learning or preference shift to the Style Journal (append-only). " +
        "Use when Grayson states a new preference, dislike, or direction, or you notice a repeated pattern " +
        "worth remembering (e.g. 'decided he's done with cropped hems', 'leaning into wider trousers'). " +
        "These accumulate and get reviewed later and promoted into the mens-style skill or the directives.",
      inputSchema: {
        note: z.string().describe("The learning, in his voice or as an observation."),
        tags: z.array(z.string()).optional().describe("Optional tags e.g. ['fit','watches','dislike']."),
      } },
    async ({ note, tags }) => {
      try {
        const c: any = await arena.getChannel(JOURNAL());
        if (!c?.id) return fail(new Error(`Journal channel '${JOURNAL()}' not found.`));
        const date = new Date().toISOString().slice(0, 10);
        const tagline = tags?.length ? `\n\ntags: ${tags.join(", ")}` : "";
        const b: any = await arena.addBlock(c.id, `**[${date}]** ${note}${tagline}`);
        return ok({ logged: note, journal: JOURNAL(), date, block_id: b?.id });
      } catch (e) { return fail(e); }
    });

  server.registerTool("style_directives",
    { title: "Read the living style directives",
      description:
        "Return the current, mutable style directives (current-season focus + recent preference updates) " +
        "that sit on top of the durable mens-style skill. Call this at the START of any styling task so " +
        "recommendations reflect the latest direction, not just the static skill.",
      inputSchema: {} },
    async () => {
      try {
        const contents: any = await arena.getChannelContents(DIRECTIVES(), 50, 1);
        const tb = firstTextBlock(contents);
        return ok(tb ? (flattenText(tb.content) ?? "(directives are empty)") : "(no directives set yet)");
      } catch (e) { return fail(e); }
    });

  server.registerTool("style_set_directives",
    { title: "Update the living style directives",
      description:
        "Replace the style directives document (the mutable layer read by style_directives). Pass the FULL " +
        "new Markdown body, not a diff. Use to update current-season focus or fold in a confirmed preference " +
        "shift. Durable rule changes belong in the mens-style skill via /style-review, not here.",
      inputSchema: { content: z.string().describe("Full Markdown body of the new directives doc.") } },
    async ({ content }) => {
      try {
        const c: any = await arena.getChannel(DIRECTIVES());
        if (!c?.id) return fail(new Error(`Directives channel '${DIRECTIVES()}' not found.`));
        const contents: any = await arena.getChannelContents(DIRECTIVES(), 50, 1);
        const tb = firstTextBlock(contents);
        if (tb?.id) {
          await arena.updateBlock(tb.id, { content });
          return ok({ updated: true, directives: DIRECTIVES(), block_id: tb.id });
        }
        const b: any = await arena.addBlock(c.id, content);
        return ok({ created: true, directives: DIRECTIVES(), block_id: b?.id });
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
    // This is a STATELESS server (no session), so it has no server-initiated SSE
    // stream. Reply 405 to a GET /mcp so clients (e.g. Open WebUI) don't sit in a
    // "GET stream disconnected, reconnecting..." loop and intermittently drop the
    // tools mid-chat.
    app.get("/mcp", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "method not allowed" }));
    app.post("/mcp", async (req, res) => {
      if (AUTH && req.header("authorization") !== `Bearer ${AUTH}`) {
        res.status(401).json({ error: "unauthorized" }); return;
      }
      const server = buildServer();
      // enableJsonResponse: answer each POST with a JSON body instead of an SSE
      // stream - correct for a stateless request/response tool server, and it
      // avoids the flaky long-lived SSE stream that was breaking tool calls.
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
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
