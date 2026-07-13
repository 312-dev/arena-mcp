// Minimal Are.na v3 REST client.
// Docs: https://www.are.na/developers  ·  API base: https://api.are.na/v3
// Auth: a personal access token (created at https://dev.are.na) sent as a Bearer token.
//
// Notes on v3 (verified against the live API, July 2026):
//  - The v2 API is being wound down; authenticated + write endpoints there now 401/410.
//  - Channels use `visibility` ("public" | "closed" | "private"), not v2's `status`.
//  - Blocks are created at POST /blocks with { value, channel_ids: [<numeric id>] } —
//    a URL becomes a PendingBlock (processes async into an Image/Link), text becomes a Text block.
//  - A user's own channels are listed via GET /users/:slug/contents (returns Channel objects).
//  - Search (GET /search) requires an Are.na Premium subscription.

const BASE = "https://api.are.na/v3";

export class ArenaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ArenaError";
  }
}

function token(): string {
  const t = process.env.ARENA_ACCESS_TOKEN;
  if (!t) {
    throw new Error(
      "ARENA_ACCESS_TOKEN is not set. Create a personal access token at https://dev.are.na and export it before starting the server.",
    );
  }
  return t;
}

const enc = encodeURIComponent;

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });

  const raw = await res.text();
  let body: any = undefined;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  if (!res.ok) {
    // v3 errors come back as { title, status } or { error, code, details:{message} }.
    const message =
      body && typeof body === "object"
        ? (body.details?.message ?? body.message ?? body.error ?? body.title ?? res.statusText)
        : typeof body === "string" && body
          ? body
          : res.statusText;
    throw new ArenaError(res.status, `Are.na API ${res.status}: ${message}`);
  }

  return body as T;
}

export type ChannelVisibility = "public" | "closed" | "private";

export const arena = {
  /** The authenticated user. */
  me: () => request(`/me`),

  /** A channel's metadata (contents fetched separately via getChannelContents). */
  getChannel: (slug: string) => request(`/channels/${enc(slug)}`),

  /** A page of a channel's contents: { meta, data }. */
  getChannelContents: (slug: string, per = 24, page = 1) =>
    request(`/channels/${enc(slug)}/contents?per=${per}&page=${page}`),

  /** Create a new channel owned by the authenticated user. */
  createChannel: (title: string, visibility: ChannelVisibility = "public") =>
    request(`/channels`, {
      method: "POST",
      body: JSON.stringify({ title, visibility }),
    }),

  /** Create a block from a URL (image/link/embed) or Markdown text and connect it to a channel by id. */
  addBlock: (channelId: number, value: string, description?: string) =>
    request(`/blocks`, {
      method: "POST",
      body: JSON.stringify({
        value,
        channel_ids: [channelId],
        ...(description ? { description } : {}),
      }),
    }),

  /** A user's own channels (GET /users/:slug/contents returns Channel objects). */
  listUserContents: (slug: string, per = 50, page = 1) =>
    request(`/users/${enc(slug)}/contents?per=${per}&page=${page}`),

  /** Full-text search ({ meta, data }). Requires an Are.na Premium subscription. */
  search: (q: string, per = 20, page = 1) =>
    request(`/search?q=${enc(q)}&per=${per}&page=${page}`),
};
