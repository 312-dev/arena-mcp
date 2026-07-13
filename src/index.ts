import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { arena, ArenaError } from "./arena.js";

const server = new McpServer({ name: "arena-mcp", version: "0.1.0" });

// ---- helpers ---------------------------------------------------------------

function ok(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function fail(e: unknown) {
  const msg =
    e instanceof ArenaError
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e);
  return {
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
    isError: true,
  };
}

function ownerSlug(c: any): string | null {
  return c?.owner?.slug ?? c?.user?.slug ?? null;
}

function channelUrl(c: any): string | null {
  const owner = ownerSlug(c);
  return c?.slug && owner ? `https://www.are.na/${owner}/${c.slug}` : null;
}

function slimChannel(c: any) {
  if (!c) return c;
  return {
    id: c.id,
    title: c.title,
    slug: c.slug,
    visibility: c.visibility,
    blocks: c.counts?.contents ?? c.counts?.blocks ?? c.length ?? null,
    owner: ownerSlug(c),
    url: channelUrl(c),
  };
}

// v3 wraps rich text as { markdown, html, plain }; flatten to plain text.
function flattenText(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return v.plain ?? v.markdown ?? null;
}

function slimBlock(b: any) {
  if (!b) return b;
  return {
    id: b.id,
    type: b.type ?? b.base_type ?? null,
    title: b.title ?? null,
    source: b.source?.url ?? (typeof b.source === "string" ? b.source : null),
    image: b.image?.display?.url ?? b.image?.original?.url ?? null,
    content: flattenText(b.content),
    description: flattenText(b.description),
  };
}

// ---- tools -----------------------------------------------------------------

server.registerTool(
  "arena_me",
  {
    title: "Get authenticated Are.na user",
    description:
      "Return the profile of the account the access token belongs to (name, slug, id, tier, and channel/follower counts).",
    inputSchema: {},
  },
  async () => {
    try {
      const me: any = await arena.me();
      return ok({
        id: me.id,
        name: me.name,
        slug: me.slug,
        tier: me.tier,
        counts: me.counts,
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "arena_list_my_channels",
  {
    title: "List my channels",
    description:
      "List the channels owned by the authenticated user (title, slug, visibility, block count, URL).",
    inputSchema: {
      per: z.number().int().min(1).max(100).optional().describe("Results per page (default 50)."),
      page: z.number().int().min(1).optional().describe("Page number (default 1)."),
    },
  },
  async ({ per, page }) => {
    try {
      const me: any = await arena.me();
      const res: any = await arena.listUserContents(me.slug, per ?? 50, page ?? 1);
      const channels = (res.data ?? []).filter((x: any) => x.type === "Channel");
      return ok({ owner: me.slug, channels: channels.map(slimChannel) });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "arena_get_channel",
  {
    title: "Get a channel and its contents",
    description:
      "Fetch a channel by its slug (the last path segment of an are.na channel URL) along with a page of its blocks.",
    inputSchema: {
      slug: z.string().describe("Channel slug, e.g. 'assembly-moodboard'."),
      per: z.number().int().min(1).max(100).optional().describe("Blocks per page (default 24)."),
      page: z.number().int().min(1).optional().describe("Page number (default 1)."),
    },
  },
  async ({ slug, per, page }) => {
    try {
      const [c, contents]: [any, any] = await Promise.all([
        arena.getChannel(slug),
        arena.getChannelContents(slug, per ?? 24, page ?? 1),
      ]);
      return ok({
        ...slimChannel(c),
        page: contents.meta?.current_page,
        total_blocks: contents.meta?.total_count,
        contents: (contents.data ?? []).map(slimBlock),
      });
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "arena_create_channel",
  {
    title: "Create a channel",
    description:
      "Create a new channel (board) owned by the authenticated user. Visibility: public (anyone can see + add), closed (anyone can see, only you add), or private (only you).",
    inputSchema: {
      title: z.string().describe("The channel title."),
      visibility: z
        .enum(["public", "closed", "private"])
        .optional()
        .describe("Visibility. Default 'public'."),
    },
  },
  async ({ title, visibility }) => {
    try {
      const c: any = await arena.createChannel(title, visibility ?? "public");
      return ok(slimChannel(c));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "arena_add_block",
  {
    title: "Add a block to a channel",
    description:
      "Add a block to a channel by slug. `value` is either a URL to any image, link, or embeddable media on any website (Are.na fetches the preview automatically) OR Markdown text. A URL is added as a pending block and finishes processing server-side a moment later.",
    inputSchema: {
      channel_slug: z.string().describe("Slug of the channel to add to."),
      value: z
        .string()
        .describe("A URL (image/link/embed on any site) or Markdown text to save as a block."),
      description: z.string().optional().describe("Optional caption/description for the block."),
    },
  },
  async ({ channel_slug, value, description }) => {
    try {
      const c: any = await arena.getChannel(channel_slug);
      if (!c?.id) return fail(new Error(`Channel '${channel_slug}' not found.`));
      const b: any = await arena.addBlock(c.id, value, description);
      return ok(slimBlock(b));
    } catch (e) {
      return fail(e);
    }
  },
);

server.registerTool(
  "arena_search",
  {
    title: "Search Are.na",
    description:
      "Full-text search across public Are.na channels, blocks, and users. NOTE: the Are.na search API requires a Premium subscription; without one this returns a Premium-required error.",
    inputSchema: {
      query: z.string().describe("Search terms."),
      per: z.number().int().min(1).max(100).optional().describe("Results per page (default 20)."),
    },
  },
  async ({ query, per }) => {
    try {
      const res: any = await arena.search(query, per ?? 20);
      const results = (res.data ?? []).map((x: any) =>
        x.type === "Channel" ? slimChannel(x) : slimBlock(x),
      );
      return ok({ total: res.meta?.total_count, results });
    } catch (e) {
      return fail(e);
    }
  },
);

// ---- boot ------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr so we never corrupt the stdio JSON-RPC stream on stdout.
  console.error("arena-mcp running on stdio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
