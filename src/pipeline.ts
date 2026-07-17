// Image-safe resolution pipeline — the TS port of the battle-tested seed_board.py logic.
// Guarantees a block gets a REAL product photo (never a screenshot render, dead-link
// catalog page, blank, or error page). See arena-boards/references/image-resolution.md.
import sharp from "sharp";
import { arena } from "./arena.js";

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---- URL sanity ------------------------------------------------------------
const LISTING = ["search?", "?q=", "/collections/", "/brands/", "/w/", "/s?k=", "/gp/search"];
const CATEGORY_END = new Set([
  "men","women","mens","sweaters","t-shirts","tanks-and-sleeveless","pants","outerwear",
  "shorts","knitwear","bottoms","tops","shirts","polos","accessories","footwear","denim",
  "jeans","trousers","belts","socks","bags","hats","innerwear","heattech","linen",
  "sweatshirts","hoodies","coats","tees","t-shirt","polo","cargo","tapered",
]);
const PRODUCT_MARKERS = ["/products/", "/product/", "/dp/", "/t/", "/sneakers/", "/apparel/"];

export function looksLikeProduct(u: string): boolean {
  const ul = u.toLowerCase();
  if (LISTING.some((x) => ul.includes(x))) return false;
  const last = ul.split("?")[0].replace(/\/+$/, "").split("/").pop() || "";
  if (CATEGORY_END.has(last)) return false;
  if (/^(mens?|womens?|kids?)-[a-z-]+$/.test(last)) return false;
  if (ul.includes("garmentory.com") && !/\/\d{5,}-/.test(ul)) return false;
  return true;
}

function pathOf(u: string): string {
  try { return new URL(u).pathname.toLowerCase(); } catch { return u.toLowerCase(); }
}

// A product URL that redirects off its product path (to a collection/home) is DEAD.
export function isDeadRedirect(reqUrl: string, finalUrl: string): boolean {
  const rp = pathOf(reqUrl), fp = pathOf(finalUrl);
  if (fp === "" || fp === "/") return true;
  if ((fp.includes("/collections/") || fp.includes("/search")) && !rp.includes("/collections/")) return true;
  for (const m of PRODUCT_MARKERS) if (rp.includes(m) && !fp.includes(m)) return true;
  return false;
}

// ---- og:image scrape -------------------------------------------------------
const OG_PATTERNS = [
  /property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)/i,
  /content=["']([^"']+)["'][^>]*property=["']og:image/i,
  /name=["']twitter:image(?::src)?["'][^>]*content=["']([^"']+)/i,
];

async function fetchText(url: string, timeoutMs = 18000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: {
        "User-Agent": BROWSER,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Dest": "document",
        "Upgrade-Insecure-Requests": "1",
      },
    });
  } finally { clearTimeout(t); }
}

// Returns { img, dead }. dead=true means skip this candidate entirely.
export async function ogImage(url: string, tries = 3): Promise<{ img: string | null; dead: boolean }> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchText(url);
      if (isDeadRedirect(url, r.url)) return { img: null, dead: true };
      if (r.status === 404) return { img: null, dead: true };
      const ct = r.headers.get("content-type") || "";
      if (ct.startsWith("image/")) return { img: url, dead: false };
      const html = (await r.text()).slice(0, 400000);
      for (const pat of OG_PATTERNS) {
        const m = html.match(pat);
        if (m) { let v = m[1]; if (v.startsWith("//")) v = "https:" + v; return { img: v, dead: false }; }
      }
      return { img: null, dead: false };
    } catch {
      if (i + 1 < tries) { await sleep((i + 1) * 3000); continue; }
      return { img: null, dead: false };
    }
  }
  return { img: null, dead: false };
}

// ---- pixel validation (reject screenshots / blanks / error pages) ----------
export async function validImage(imgUrl: string | null): Promise<{ ok: boolean; info: string }> {
  if (!imgUrl) return { ok: false, info: "none" };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(imgUrl, { headers: { "User-Agent": BROWSER }, signal: ctrl.signal }).finally(() => clearTimeout(t));
    const buf = Buffer.from(await res.arrayBuffer());
    const img = sharp(buf);
    const meta = await img.metadata();
    const w = meta.width || 0, h = meta.height || 0;
    const stats = await img.stats();
    const chans = stats.channels.slice(0, 3);
    const mean = chans.reduce((a: number, c: any) => a + c.mean, 0) / chans.length;
    const std = chans.reduce((a: number, c: any) => a + c.stdev, 0) / chans.length;
    if (w === 2560 && h === 2560) return { ok: false, info: "arena-render(screenshot)" };
    if (Math.min(w, h) < 150) return { ok: false, info: `tiny ${w}x${h}` };
    if (std < 20) return { ok: false, info: `blank std=${std.toFixed(0)}` };
    if (mean > 248) return { ok: false, info: `error-page mean=${mean.toFixed(0)}` };
    return { ok: true, info: `${w}x${h} std=${std.toFixed(0)}` };
  } catch (e: any) {
    return { ok: false, info: `fetchfail:${e?.name || "err"}` };
  }
}

// ---- Are.na fetcher fallback (uses a cached private scratch channel) --------
let scratchId: number | null = null;
async function getScratch(): Promise<number> {
  if (scratchId) return scratchId;
  // Reuse an existing __mcp_scratch across cold-starts instead of minting a new one
  // each time the serverless process boots (which is how these leaked before).
  try {
    const me: any = await arena.me();
    const res: any = await arena.listUserContents(me.slug, 100, 1);
    const existing = (res.data ?? []).find((c: any) => c.type === "Channel" && c.title === "__mcp_scratch");
    if (existing?.id) { scratchId = existing.id; return scratchId!; }
  } catch { /* fall through and create one */ }
  const c: any = await arena.createChannel("__mcp_scratch", "private");
  scratchId = c.id;
  return scratchId!;
}
function imgSrc(image: any): string | null {
  if (!image || typeof image !== "object") return null;
  if (image.src) return image.src;
  for (const k of ["large", "medium", "original", "square", "small"]) {
    const v = image[k];
    if (typeof v === "string" && v.startsWith("http")) return v;
    if (v && typeof v === "object" && v.url) return v.url;
  }
  return null;
}
async function arenaFetchImage(url: string): Promise<string | null> {
  const sid = await getScratch();
  const blk: any = await arena.addBlock(sid, url).catch(() => null);
  if (!blk?.id) return null;
  for (let i = 0; i < 11; i++) {
    await sleep(3000);
    const b: any = await arena.getBlock(blk.id).catch(() => null);
    if (b && b.type !== "PendingBlock") return imgSrc(b.image);
  }
  return null;
}

// ---- keyed image-search fallback (Brave Images) ----------------------------
// When a product's own page yields no usable image, find a real photo of it by
// name. No-ops (returns []) if BRAVE_SEARCH_API_KEY isn't set.
export async function braveImageSearch(query: string, count = 6): Promise<string[]> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key || !query) return [];
  try {
    const u = `https://api.search.brave.com/res/v1/images/search?q=${encodeURIComponent(query)}&count=${count}&country=us`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(u, {
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (!r.ok) return [];
    const j: any = await r.json();
    const out: string[] = [];
    for (const it of j.results ?? []) {
      const full = it?.properties?.url, thumb = it?.thumbnail?.src;
      if (typeof full === "string") out.push(full);
      else if (typeof thumb === "string") out.push(thumb);
    }
    return out;
  } catch { return []; }
}

// ---- resolve: first candidate that yields a real product image -------------
export interface Resolved { img: string; how: "og" | "arena" | "search"; src: string; info: string; }
// candidates = product-page URLs to scrape; searchQuery = product name to fall
// back to a web image search for if none of the pages yield a usable photo.
export async function resolveImage(candidates: string[], searchQuery?: string): Promise<Resolved | null> {
  for (const url of candidates) {
    if (!looksLikeProduct(url)) continue;
    const { img, dead } = await ogImage(url);
    if (dead) continue;
    let v = await validImage(img);
    if (v.ok && img) return { img, how: "og", src: url, info: v.info };
    const img2 = await arenaFetchImage(url);
    v = await validImage(img2);
    if (v.ok && img2) return { img: img2, how: "arena", src: url, info: v.info };
  }
  // Fallback: find a real product photo online by name (Brave Images).
  if (searchQuery) {
    for (const imgUrl of await braveImageSearch(searchQuery)) {
      const v = await validImage(imgUrl);
      if (v.ok) return { img: imgUrl, how: "search", src: searchQuery, info: v.info };
    }
  }
  return null;
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
