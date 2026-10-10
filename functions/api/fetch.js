// Cloudflare Pages Function: /api/fetch
// Used by "סטודיו עיצוב" to import product images from a link.
//   /api/fetch?mode=ping              -> {ok:true}
//   /api/fetch?mode=page&url=<page>   -> {title, images:[...]}  (product page → candidate images)
//   /api/fetch?mode=img&url=<image>   -> the image bytes (same-origin, so the editor can process it)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const MAX_IMG = 15 * 1024 * 1024, MAX_HTML = 3 * 1024 * 1024;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

function safeTarget(raw) {
  let t; try { t = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(t.protocol)) return null;
  const h = t.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(":") ) return null;
  return t;
}
const decode = s => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/gi, "/").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
const attr = (tag, name) => { const m = tag.match(new RegExp("\\s" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)'|([^\\s>]+))", "i")); return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : ""; };
const BAD = /(logo|icon|sprite|pixel|spacer|blank|placeholder|avatar|flag|payment|visa|mastercard|banner|badge|rating|star|loader|loading|arrow|social|facebook|whatsapp|instagram|tracking|\.svg(\?|$)|\.gif(\?|$)|data:)/i;

function parse(html, base) {
  const out = [], seen = new Set(); let title = "";
  const add = (u, pri) => { if (!u) return; u = String(u).trim(); if (!u || u.startsWith("data:")) return; try { u = new URL(u, base).toString(); } catch { return; } if (seen.has(u) || (pri < 2 && BAD.test(u))) return; seen.add(u); out.push({ u, pri }); };
  // JSON-LD Product
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = n => { if (!n || typeof n !== "object") return; if (Array.isArray(n)) return n.forEach(walk);
        const ty = [].concat(n["@type"] || []).join(" ");
        if (/Product/i.test(ty)) { if (!title && n.name) title = String(n.name); [].concat(n.image || []).forEach(i => add(typeof i === "string" ? i : i && (i.url || i.contentUrl), 3)); }
        Object.values(n).forEach(v => typeof v === "object" && walk(v)); };
      walk(JSON.parse(m[1].trim()));
    } catch {}
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) { const t = m[0], p = (attr(t, "property") || attr(t, "name")).toLowerCase();
    if (p === "og:image" || p === "og:image:url" || p === "og:image:secure_url" || p === "twitter:image") add(attr(t, "content"), 2);
    if (!title && p === "og:title") title = attr(t, "content"); }
  for (const m of html.matchAll(/<link\b[^>]*rel=["']?image_src[^>]*>/gi)) add(attr(m[0], "href"), 2);
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) { const t = m[0];
    const ss = attr(t, "srcset") || attr(t, "data-srcset"); let best = "";
    if (ss) { let bw = 0; ss.split(",").forEach(p => { const [u, w] = p.trim().split(/\s+/); const n = parseFloat(w) || 1; if (n >= bw) { bw = n; best = u; } }); }
    add(best || attr(t, "data-zoom-image") || attr(t, "data-large") || attr(t, "data-original") || attr(t, "data-lazy-src") || attr(t, "data-src") || attr(t, "src"), 1);
    if (out.length > 120) break; }
  if (!title) { const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i); if (m) title = decode(m[1]).trim(); }
  out.sort((a, b) => b.pri - a.pri);
  return { title: title.replace(/\s+/g, " ").slice(0, 160), images: out.slice(0, 40).map(x => x.u) };
}

export async function onRequestGet({ request }) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return json({ error: "forbidden" }, 403);
  const q = new URL(request.url).searchParams, mode = q.get("mode") || "img";
  if (mode === "ping") return json({ ok: true });
  const t = safeTarget(q.get("url") || "");
  if (!t) return json({ error: "bad_url" }, 400);
  let r;
  try {
    r = await fetch(t.toString(), { redirect: "follow", headers: { "User-Agent": UA, "Accept-Language": "he-IL,he;q=0.9,en;q=0.8",
      Accept: mode === "img" ? "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8" : "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5" }, cf: { cacheTtl: 3600 } });
  } catch (e) { return json({ error: "unreachable" }, 502); }
  if (!r.ok) return json({ error: "upstream", status: r.status }, 502);
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  if (mode === "img") {
    if (!ct.startsWith("image/") || ct.includes("svg")) return json({ error: "not_image" }, 415);
    if (+(r.headers.get("content-length") || 0) > MAX_IMG) return json({ error: "too_large" }, 413);
    const buf = await r.arrayBuffer(); if (buf.byteLength > MAX_IMG) return json({ error: "too_large" }, 413);
    return new Response(buf, { headers: { "content-type": ct, "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
  }
  if (ct.startsWith("image/")) return json({ title: "", images: [t.toString()] });
  if (!ct.includes("html") && !ct.includes("xml")) return json({ error: "not_html" }, 415);
  let html = await r.text(); if (html.length > MAX_HTML) html = html.slice(0, MAX_HTML);
  return json(parse(html, r.url || t.toString()));
}
