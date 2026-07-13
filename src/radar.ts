// Style Radar — weekly trend scanner. Scrapes underground menswear sources, filters through
// the wearer's gruff West Loop taste via the Anthropic API, sources REAL product images with
// the pipeline, and posts fresh candidates to a "Radar" Are.na channel (a staging board to review).
// Runs as a scheduled Fly machine: node dist/radar.js
import { arena } from "./arena.js";
import { resolveImage } from "./pipeline.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY!;
const RADAR_CHANNEL = process.env.RADAR_CHANNEL_SLUG!; // e.g. "radar-xxxx"
const MODEL = process.env.RADAR_MODEL || "claude-sonnet-5";

const TASTE = `Chicago West Loop / River North / Wicker Park "gruff dude": masculine, rugged-but-elevated, industrial-creative, a little rough around the edges. Workwear backbone (Carhartt WIP is the spine — chore coats, raw/selvedge denim, flannel, work boots, henleys, chunky knits, beanies) crossed with elevated streetwear and real texture; tonal earthy / wet-asphalt palettes. Loves oversized graphic tees, Nike + New Balance (+ ASICS/Salomon gorp), trendy NON-dad shoes. Natural breathable fabrics only (cotton/wool/merino/linen/leather/canvas) — dislikes polyester blends and non-breathable synthetics (winter tech shells the exception). Watches: Shinola/Detroit/boutique/robust, case <=41mm, NO Seiko, up to ~$1200. Eyewear: round, thin, narrow-to-medium, brow-revealing. NEVER: jorts/denim shorts, preppy/resort/fashion-y/femme, Seiko. Build 5'9"/185 slightly heavy -> darker/tonal/structured/skimming. Value/in-the-loop budget: shoes ~$250, tees ~$45-80, a coat can splurge.`;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
// RSS feeds (Reddit .json 403s but .rss returns 200; editorial feeds are open).
const SOURCES: [string, string][] = [
  ["r/streetwear", "https://www.reddit.com/r/streetwear/top.rss?t=week"],
  ["r/rawdenim", "https://www.reddit.com/r/rawdenim/top.rss?t=week"],
  ["r/goodyearwelt", "https://www.reddit.com/r/goodyearwelt/top.rss?t=week"],
  ["r/malefashionadvice", "https://www.reddit.com/r/malefashionadvice/top.rss?t=week"],
  ["r/streetwearstartup", "https://www.reddit.com/r/streetwearstartup/top.rss?t=week"],
  ["Hypebeast", "https://hypebeast.com/feed"],
  ["Highsnobiety", "https://www.highsnobiety.com/feed/"],
  ["Die Workwear", "https://dieworkwear.substack.com/feed"],
  ["Permanent Style", "https://www.permanentstyle.com/feed"],
  ["Put This On", "https://putthison.com/rss"],
];

function titlesFromXml(xml: string, limit: number): string[] {
  const out: string[] = [];
  const re = /<title>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/title>/gi;
  let m: RegExpExecArray | null, first = true;
  while ((m = re.exec(xml)) && out.length < limit) {
    const t = m[1].replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&#8217;/g, "'").trim();
    if (first) { first = false; continue; } // skip the feed/channel title
    if (t) out.push(t);
  }
  return out;
}

async function scrape(): Promise<string> {
  const out: string[] = [];
  for (const [name, url] of SOURCES) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" } });
      if (!r.ok) { out.push(`## ${name}: (fetch ${r.status})`); continue; }
      const titles = titlesFromXml(await r.text(), 15);
      out.push(`## ${name}\n${titles.map((t) => "- " + t).join("\n")}`);
    } catch (e: any) { out.push(`## ${name}: (error ${e?.name})`); }
  }
  return out.join("\n\n");
}

async function askClaude(signal: string): Promise<any[]> {
  const prompt = `You are a menswear trend scout WITH WEB SEARCH. Signals scraped this week from enthusiast communities & editorial:\n\n=== SIGNALS ===\n${signal}\n\n=== WEARER TASTE (filter hard against this) ===\n${TASTE}\n\nUSE WEB SEARCH to (1) confirm what is genuinely bubbling up RIGHT NOW in this exact gruff West Loop aesthetic (current streetwear/workwear/gorp/raw-denim/boot chatter, drops, editorial), and (2) find a REAL, CURRENTLY-LIVE product-page URL for each pick. Then propose EXACTLY 8-12 specific pieces that fit this wearer and feel fresh/in-the-loop. Favor lesser-known/underground finds over obvious staples; skip anything off-aesthetic (no preppy/resort/fashion-y/femme, no Seiko, no jorts).\n\nEach candidate_urls MUST be a REAL product page you verified via search, on IMAGE-RELIABLE hosts ONLY: goat.com/sneakers|apparel, amazon.com/dp/, us.carhartt-wip.com/products/, garmentory.com (numeric-id product page), uniqlo.com/us/en/products/E.... Prefer goat.com and amazon.com/dp (most reliable images). Give 1-2 real URLs each.\n\nAfter searching, respond with ONLY a JSON array (no other prose): [{"title":"Brand — Product (Colorway)","why":"1-2 sentences: why it's trending AND why it fits his gruff West Loop aesthetic","candidate_urls":["real_url1","real_url2"]}]`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL, max_tokens: 8000,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 10 }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const text: string = (j?.content || []).find((b: any) => b.type === "text")?.text || "[]";
  const m = text.match(/\[[\s\S]*\]/);
  return m ? JSON.parse(m[0]) : [];
}

async function main() {
  if (!ANTHROPIC_KEY || !RADAR_CHANNEL) { console.error("missing ANTHROPIC_API_KEY or RADAR_CHANNEL_SLUG"); process.exit(1); }
  const ch: any = await arena.getChannel(RADAR_CHANNEL);
  if (!ch?.id) { console.error("Radar channel not found:", RADAR_CHANNEL); process.exit(1); }
  // existing titles (dedupe so we don't repost the same pieces every week)
  const existing = new Set<string>();
  const cont: any = await arena.getChannelContents(RADAR_CHANNEL, 100, 1).catch(() => ({ data: [] }));
  for (const b of cont.data || []) if (b.title) existing.add(b.title.trim().toLowerCase());

  const signal = await scrape();
  const cands = await askClaude(signal);
  console.error(`claude proposed ${cands.length} candidates`);

  const added: string[] = [], skipped: string[] = [];
  for (const c of cands) {
    const title = (c.title || "").trim();
    if (!title || existing.has(title.toLowerCase())) { skipped.push(title + " (dup)"); continue; }
    const r = await resolveImage(c.candidate_urls || []);
    if (!r) { skipped.push(title + " (no image)"); continue; }
    const desc = [c.why, `shop: ${r.src}`].filter(Boolean).join(" · ");
    await arena.addBlock(ch.id, r.img, { title, description: desc }).catch(() => skipped.push(title + " (add-fail)"));
    added.push(title);
    await new Promise((res) => setTimeout(res, 700));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  await arena.addBlock(ch.id, `**Radar — ${stamp}**\nAdded ${added.length}: ${added.join(", ") || "none"}.\nSkipped ${skipped.length}.`, {})
    .catch(() => {});
  console.error(`RADAR DONE ${stamp}: added ${added.length}, skipped ${skipped.length}`);
  console.error("added:", added.join(" | "));
}

main().catch((e) => { console.error("radar fatal:", e); process.exit(1); });
