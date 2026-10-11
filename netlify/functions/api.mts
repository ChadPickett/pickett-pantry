import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  findJsonLdRecipe, mapJsonLd, htmlToText, platformOf, getMeta, captionFromOg,
  youtubeDescription, firstUrl, parseJsonReply, cleanText,
} from "../../lib/extract.mjs";

const MODEL = "claude-haiku-5-5";
const COLLECTIONS = ["recipes", "cookbooks", "plan", "groceries", "settings"];
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,80}$/;
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const PREVIEW_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const data = () => getStore({ name: "pantry", consistency: "strong" });
const photos = () => getStore({ name: "photos", consistency: "strong" });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

/* ---------------- passcode ---------------- */
type Auth = { salt: string; hash: string };
const hashPass = (salt: string, pass: string) => createHash("sha256").update(salt + ":" + pass).digest("hex");
const tokenFor = (a: Auth) => createHmac("sha256", a.hash).update("pickett-pantry-session-v1").digest("hex");
async function getAuth(): Promise<Auth | null> { return (await data().get("meta/auth", { type: "json" })) as Auth | null; }
function same(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
async function authed(req: Request) {
  const a = await getAuth(); if (!a) return false;
  const t = req.headers.get("x-pp-token") || "";
  return !!t && same(t, tokenFor(a));
}
async function bump() { await data().set("meta/rev", Date.now().toString(36) + randomBytes(3).toString("hex")); }

/* ---------------- Claude ---------------- */
let client: Anthropic | null = null;
function claude() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client ??= new Anthropic();
  return client;
}
async function ask(content: any, maxTokens = 3000, system?: string): Promise<string> {
  const c = claude();
  if (!c) throw new Error("ai_unavailable");
  const msg = await c.messages.create({
    model: MODEL, max_tokens: maxTokens, ...(system ? { system } : {}),
    messages: Array.isArray(content) && content[0]?.role ? content : [{ role: "user", content }],
  });
  return msg.content.map((b: any) => (b.type === "text" ? b.text : "")).join("").trim();
}

const IMPORT_RULES = `You turn recipe content into clean JSON for a home recipe app. Use only what the content says. Never invent ingredients, amounts or steps. If something is missing, use null or an empty list.
Ingredients: one line each, written as "quantity unit ingredient, prep note" (for example "2 cups flour, sifted" or "3 cloves garlic, minced"). Use plain fractions like 1/2. If the recipe has sections, add a line ending in a colon before each section (for example "For the sauce:").
Steps: one step per string, in order, without leading numbers. Section labels go in as their own line ending in a colon.
Drop hashtags, emojis, follow-me requests, sponsor text and life stories. Put useful tips in notes.
Reply with only this JSON: {"title":string,"description":string|null,"servings":number|null,"prepMinutes":number|null,"cookMinutes":number|null,"cuisine":string|null,"tags":[string],"ingredients":[string],"steps":[string],"notes":string|null}
tags: up to 4 short lowercase words such as "dinner", "dessert", "vegetarian", "slow cooker". If there is no recipe in the content, reply {"error":"no recipe found"}.`;

function fromAi(j: any, src: string) {
  const n = (v: any) => { const x = parseFloat(v); return isFinite(x) && x > 0 ? x : null; };
  return {
    title: String(j.title || "").trim(), description: j.description || "", servings: n(j.servings), prepMin: n(j.prepMinutes), cookMin: n(j.cookMinutes),
    cuisine: j.cuisine || "", tags: Array.isArray(j.tags) ? j.tags.map(String).slice(0, 6) : [],
    ingredients: Array.isArray(j.ingredients) ? j.ingredients.map(String) : [], steps: Array.isArray(j.steps) ? j.steps.map(String) : [],
    notes: j.notes || "", sourceUrl: src || "",
  };
}
async function structure(text: string, src: string, images: { media_type: string; data: string }[] = []) {
  const content: any[] = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
  content.push({ type: "text", text: IMPORT_RULES + (src ? `\nSource link: ${src}` : "") + (images.length ? "\nThe images are photos or screenshots of one recipe, in page order." : "") + (text ? `\nContent:\n"""\n${text.slice(0, 50000)}\n"""` : "") });
  const j = parseJsonReply(await ask(content, 4000));
  if (!j || j.error || !j.title) return null;
  return fromAi(j, src);
}

/* ---------------- fetching pages ---------------- */
async function grab(url: string, ua = BROWSER_UA, ms = 12000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "user-agent": ua, "accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", "accept-language": "en-US,en;q=0.9" } });
    const text = (await r.text()).slice(0, 3_000_000);
    return { ok: r.ok, status: r.status, url: r.url || url, text };
  } finally { clearTimeout(t); }
}

async function savePhotoFromUrl(imageUrl: string): Promise<string | null> {
  if (!/^https?:\/\//i.test(imageUrl || "")) return null;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(imageUrl, { signal: ctl.signal, headers: { "user-agent": BROWSER_UA } });
    clearTimeout(t);
    const type = r.headers.get("content-type") || "";
    if (!r.ok || !/^image\/(jpeg|png|webp|gif|avif)/.test(type)) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 2000 || buf.byteLength > 6_000_000) return null;
    const id = Date.now().toString(36) + randomBytes(8).toString("hex");
    await photos().set(id, buf, { metadata: { type } });
    return id;
  } catch { return null; }
}

type Found = { recipe?: any; caption?: string; imageUrl?: string; author?: string; finalUrl: string; platform: string };

async function lookUp(url: string): Promise<Found> {
  const platform = platformOf(url);
  if (platform === "tiktok") {
    let finalUrl = url;
    try { const g = await grab(url, BROWSER_UA, 8000); finalUrl = g.url || url; } catch {}
    const o = await grab("https://www.tiktok.com/oembed?url=" + encodeURIComponent(finalUrl), BROWSER_UA, 8000);
    let j: any = {}; try { j = JSON.parse(o.text); } catch {}
    return { caption: j.title || "", imageUrl: j.thumbnail_url, author: j.author_name, finalUrl, platform };
  }
  if (platform === "youtube") {
    const g = await grab(url);
    const desc = youtubeDescription(g.text);
    const title = getMeta(g.text, "og:title");
    return { caption: [title, desc].filter(Boolean).join("\n\n"), imageUrl: getMeta(g.text, "og:image"), finalUrl: g.url, platform };
  }
  if (platform === "instagram" || platform === "facebook" || platform === "threads") {
    const g = await grab(url, PREVIEW_UA);
    const desc = getMeta(g.text, "og:description") || getMeta(g.text, "description");
    const title = getMeta(g.text, "og:title");
    let caption = captionFromOg(desc);
    if (caption.length < 40 && title.length > caption.length) caption = captionFromOg(title);
    return { caption, imageUrl: getMeta(g.text, "og:image"), finalUrl: g.url, platform };
  }
  // websites and Pinterest
  const g = await grab(url);
  const node = findJsonLdRecipe(g.text);
  if (node) {
    const recipe = mapJsonLd(node, g.url || url);
    if (recipe.title && recipe.ingredients.length) return { recipe, finalUrl: g.url, platform };
  }
  if (platform === "pinterest") {
    const src = getMeta(g.text, "pinterestapp:source") || getMeta(g.text, "og:see_also");
    if (src && /^https?:/.test(src) && platformOf(src) === "web") { try { return await lookUp(src); } catch {} }
  }
  return { caption: htmlToText(g.text), imageUrl: getMeta(g.text, "og:image"), finalUrl: g.url, platform };
}

async function importRecipe(body: any) {
  const shared = String(body.text || "");
  const url = String(body.url || "").trim() || firstUrl(shared);
  const extra = shared.replace(url, "").trim();
  const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];

  if (images.length) {
    const parsed = images.map((d: string) => { const m = String(d).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/); return m ? { media_type: m[1], data: m[2] } : null; }).filter(Boolean);
    if (!parsed.length) return { error: "Those images couldn’t be read. Try JPG or PNG." };
    const r = await structure(extra, url, parsed as any);
    return r ? { recipe: r, method: "photo" } : { error: "Claude couldn’t find a recipe in those images." };
  }
  if (url) {
    if (platformOf(url) === "invalid") return { error: "That link doesn’t look right." };
    let found: Found;
    try { found = await lookUp(url); }
    catch { return { error: "That site didn’t respond. Try again, or paste the recipe text instead.", url }; }
    if (found.recipe) {
      const imageId = await savePhotoFromUrl(found.recipe.imageUrl);
      delete found.recipe.imageUrl;
      return { recipe: { ...found.recipe, imageId }, method: "structured" };
    }
    const text = [found.caption, extra].filter(Boolean).join("\n\n");
    if (text.replace(/\s/g, "").length < 40) {
      return { error: found.platform === "web" ? "That page didn’t include a readable recipe. Paste the recipe text instead." : "That post’s caption couldn’t be read (the account may be private, or the recipe is only in the video). Take a screenshot of the recipe and share that instead.", url: found.finalUrl };
    }
    const r = await structure(text, found.finalUrl || url);
    if (!r) return { error: found.platform === "web" ? "Claude couldn’t find a recipe on that page." : "That post doesn’t have the recipe written in its caption. If it’s only in the video, take a screenshot of the recipe and share that instead.", url: found.finalUrl };
    if (!r.notes && found.author) r.notes = "Recipe by " + found.author;
    const imageId = await savePhotoFromUrl(found.imageUrl || "");
    return { recipe: { ...r, imageId }, method: "caption" };
  }
  if (extra.length >= 20) {
    const r = await structure(extra, "");
    return r ? { recipe: r, method: "text" } : { error: "Claude couldn’t find a recipe in that text." };
  }
  return { error: "Share a link, some recipe text, or a screenshot." };
}

/* ---------------- router ---------------- */
export default async (req: Request, _ctx: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  try {
    // public photo serving (ids are long random strings)
    if (path[0] === "photo" && path[1] && method === "GET") {
      if (!ID_RE.test(path[1])) return fail("bad id", 404);
      const r = await photos().getWithMetadata(path[1], { type: "arrayBuffer" });
      if (!r) return new Response("not found", { status: 404 });
      return new Response(r.data as ArrayBuffer, { headers: { "content-type": String((r.metadata as any)?.type || "image/jpeg"), "cache-control": "public, max-age=31536000, immutable" } });
    }

    if (path[0] === "status" && method === "GET") {
      return json({ setup: !(await getAuth()), ai: !!process.env.ANTHROPIC_API_KEY });
    }

    if (path[0] === "login" && method === "POST") {
      const { passcode } = await req.json().catch(() => ({}));
      const pass = String(passcode || "");
      let a = await getAuth();
      if (!a) {
        if (pass.length < 4) return fail("Pick a passcode with at least 4 characters.");
        const salt = randomBytes(16).toString("hex");
        a = { salt, hash: hashPass(salt, pass) };
        await data().setJSON("meta/auth", a);
        return json({ token: tokenFor(a), created: true });
      }
      if (!same(hashPass(a.salt, pass), a.hash)) { await new Promise((r) => setTimeout(r, 800)); return fail("That passcode isn’t right.", 401); }
      return json({ token: tokenFor(a) });
    }

    if (!(await authed(req))) return fail("Please sign in again.", 401);

    if (path[0] === "passcode" && method === "POST") {
      const { passcode } = await req.json().catch(() => ({}));
      const pass = String(passcode || ""); if (pass.length < 4) return fail("Pick a passcode with at least 4 characters.");
      const salt = randomBytes(16).toString("hex"); const a = { salt, hash: hashPass(salt, pass) };
      await data().setJSON("meta/auth", a);
      return json({ token: tokenFor(a) });
    }

    if (path[0] === "rev" && method === "GET") {
      return json({ rev: (await data().get("meta/rev")) || "0" });
    }

    if (path[0] === "data" && method === "GET") {
      const store = data();
      const out: Record<string, any> = { rev: (await store.get("meta/rev")) || "0" };
      await Promise.all(COLLECTIONS.map(async (col) => {
        const { blobs } = await store.list({ prefix: col + "/" });
        const docs = await Promise.all(blobs.map(async (b) => { const d = await store.get(b.key, { type: "json" }); return d ? { ...(d as any), id: b.key.slice(col.length + 1) } : null; }));
        out[col] = docs.filter(Boolean);
      }));
      out.settings = (out.settings as any[]).find((d) => d.id === "main") || {};
      return json(out);
    }

    if (path[0] === "doc" && COLLECTIONS.includes(path[1]) && path[2] && ID_RE.test(path[2])) {
      const key = path[1] + "/" + path[2];
      if (method === "PUT") {
        const body = await req.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Expected an object.");
        const s = JSON.stringify(body); if (s.length > 300_000) return fail("That item is too large.");
        delete (body as any).id;
        await data().setJSON(key, body); await bump();
        return json({ ok: true });
      }
      if (method === "DELETE") { await data().delete(key); await bump(); return json({ ok: true }); }
    }

    if (path[0] === "photo" && method === "POST") {
      const type = req.headers.get("content-type") || "";
      if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return fail("Use a JPG, PNG or WebP image.");
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 5_000_000) return fail("That photo is too large.");
      const id = Date.now().toString(36) + randomBytes(8).toString("hex");
      await photos().set(id, buf, { metadata: { type } });
      return json({ id });
    }

    if (path[0] === "import" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      return json(await importRecipe(body));
    }

    if (path[0] === "ai" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const messages = Array.isArray(body.messages) ? body.messages.filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).slice(-20) : [];
      if (!messages.length || messages[messages.length - 1].role !== "user") return fail("Nothing to ask.");
      // the API wants turns to alternate, so fold back-to-back turns from the same side together
      for (let i = messages.length - 1; i > 0; i--) if (messages[i].role === messages[i - 1].role) { messages[i - 1] = { role: messages[i].role, content: messages[i - 1].content + "\n\n" + messages[i].content }; messages.splice(i, 1); }
      if (messages[0].role !== "user") messages.shift();
      if (JSON.stringify(messages).length > 120_000) return fail("That’s too much text.");
      const text = await ask(messages, Math.min(Number(body.maxTokens) || 1500, 3000), typeof body.system === "string" ? body.system.slice(0, 20000) : undefined);
      if (body.json) { const j = parseJsonReply(text); if (j == null) return fail("Claude’s answer didn’t come back in a usable form. Try again.", 502); return json({ data: j }); }
      return json({ text });
    }

    return fail("Not found", 404);
  } catch (e: any) {
    if (e?.message === "ai_unavailable") return fail("Claude isn’t switched on for this site yet. In Netlify, check that AI features are enabled, then redeploy.", 503);
    console.error(e);
    return fail("Something went wrong on the server. Try again.", 500);
  }
};

export const config: Config = { path: "/api/*" };
