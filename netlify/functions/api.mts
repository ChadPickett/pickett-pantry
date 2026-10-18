import type { Config, Context } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import {
  findJsonLdRecipe, mapJsonLd, htmlToText, platformOf, getMeta, captionFromOg,
  youtubeDescription, firstUrl, parseJsonReply,
} from "../../lib/extract.mjs";
import { FIREBASE_PROJECT_ID } from "../../lib/firebase-config.mjs";

const MODEL = "claude-haiku-5-5";
const COLLECTIONS = ["recipes", "cookbooks", "plan", "groceries", "settings"];
const ID_RE = /^[A-Za-z0-9_\-.~:@+]{1,80}$/;
const AI_MONTHLY_LIMIT = Number(process.env.AI_MONTHLY_LIMIT || 40);
const BROWSER_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36";
const PREVIEW_UA = "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

const store = () => getStore({ name: "pantry", consistency: "strong" });
const photos = () => getStore({ name: "photos", consistency: "strong" });
const newId = () => Date.now().toString(36) + randomBytes(8).toString("hex");

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const fail = (message: string, status = 400, extra: Record<string, unknown> = {}) => json({ error: message, ...extra }, status);

/* ---------------- accounts (Firebase sign-in) ---------------- */
const JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"));
type Who = { uid: string; email: string; name: string };
async function whoIs(req: Request): Promise<Who | null> {
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`, audience: FIREBASE_PROJECT_ID });
    if (!payload.sub) return null;
    const email = String((payload as any).email || "");
    return { uid: String(payload.sub), email, name: String((payload as any).name || email.split("@")[0] || "Cook") };
  } catch { return null; }
}

type UserRec = { kitchenId: string; name: string; email: string; createdAt: number };
type Kitchen = { name: string; ownerUid: string; members: string[]; inviteCode: string; createdAt: number };

async function getJSON<T>(key: string): Promise<T | null> { return (await store().get(key, { type: "json" })) as T | null; }
async function putJSON(key: string, v: unknown) { await store().setJSON(key, v); }

async function newKitchen(who: Who): Promise<string> {
  const kid = newId();
  const inviteCode = randomBytes(6).toString("hex");
  await putJSON(`kitchens/${kid}`, { name: (who.name.split(" ")[0] || "My") + "’s Kitchen", ownerUid: who.uid, members: [who.uid], inviteCode, createdAt: Date.now() } satisfies Kitchen);
  await putJSON(`invites/${inviteCode}`, { kitchenId: kid });
  return kid;
}

/** Look up (or create on first sign-in) the person's record and kitchen. */
async function account(who: Who) {
  let user = await getJSON<UserRec>(`users/${who.uid}`);
  let kitchen = user ? await getJSON<Kitchen>(`kitchens/${user.kitchenId}`) : null;
  if (!user || !kitchen || !kitchen.members.includes(who.uid)) {
    const kitchenId = await newKitchen(who);
    user = { kitchenId, name: who.name, email: who.email, createdAt: user?.createdAt || Date.now() };
    await putJSON(`users/${who.uid}`, user);
    kitchen = (await getJSON<Kitchen>(`kitchens/${kitchenId}`))!;
    if (!(await store().get("meta/admin"))) await store().set("meta/admin", who.uid); // first person ever is the site owner
  } else if (user.name !== who.name || user.email !== who.email) {
    const oldDefault = (user.name.split(" ")[0] || "My") + "’s Kitchen";
    if (kitchen.ownerUid === who.uid && kitchen.name === oldDefault) {
      kitchen = { ...kitchen, name: (who.name.split(" ")[0] || "My") + "’s Kitchen" };
      await putJSON(`kitchens/${user.kitchenId}`, kitchen);
    }
    user = { ...user, name: who.name, email: who.email };
    await putJSON(`users/${who.uid}`, user);
  }
  return { user, kitchen, kid: user.kitchenId };
}

async function isUnlimited(k: Kitchen) {
  const admin = await store().get("meta/admin");
  return !!admin && k.members.includes(String(admin));
}
const monthKey = () => new Date().toISOString().slice(0, 7);
async function usage(kid: string, k: Kitchen) {
  const u = (await getJSON<{ count: number }>(`k/${kid}/usage/${monthKey()}`)) || { count: 0 };
  const unlimited = await isUnlimited(k);
  return { used: u.count, limit: unlimited ? null : AI_MONTHLY_LIMIT };
}
async function canSpendAi(kid: string, k: Kitchen) {
  const u = await usage(kid, k);
  return !(u.limit != null && u.used >= u.limit);
}
async function recordAi(kid: string, k: Kitchen) {
  const u = await usage(kid, k);
  await putJSON(`k/${kid}/usage/${monthKey()}`, { count: u.used + 1 });
}
const BUSY_MSG = "The recipe helper is busy right now. Try again in a minute.";
const BUSY_MSG_PHOTO = "Reading photos isn’t working right now. Try again in a minute, or paste the recipe text instead.";
const LIMIT_MSG = "Your kitchen has used all of this month’s Claude imports. Recipe website links still work, and the count resets on the 1st.";

async function bump(kid: string) { await store().set(`k/${kid}/rev`, Date.now().toString(36) + randomBytes(3).toString("hex")); }

async function readKitchenData(kid: string) {
  const s = store();
  const out: Record<string, any> = { rev: (await s.get(`k/${kid}/rev`)) || "0" };
  await Promise.all(COLLECTIONS.map(async (col) => {
    const prefix = `k/${kid}/${col}/`;
    const { blobs } = await s.list({ prefix });
    const docs = await Promise.all(blobs.map(async (b) => { const d = await s.get(b.key, { type: "json" }); return d ? { ...(d as any), id: b.key.slice(prefix.length) } : null; }));
    out[col] = docs.filter(Boolean);
  }));
  out.settings = (out.settings as any[]).find((d) => d.id === "main") || {};
  return out;
}

async function memberList(k: Kitchen) {
  const people = await Promise.all(k.members.map(async (uid) => { const u = await getJSON<UserRec>(`users/${uid}`); return { uid, name: u?.name || "Cook", email: u?.email || "", owner: uid === k.ownerUid }; }));
  return people;
}

/* ---------------- Claude ---------------- */
// Netlify's AI Gateway provides the key. Read it fresh on every call (it is set when the
// function starts up) and fall back to the gateway's own variables if the Anthropic ones are missing.
function envVar(name: string): string {
  const g: any = globalThis as any;
  try { const v = g.Netlify?.env?.get?.(name); if (v) return String(v); } catch {}
  return process.env[name] || "";
}
function aiCreds() {
  const key = envVar("ANTHROPIC_API_KEY") || envVar("NETLIFY_AI_GATEWAY_KEY");
  let base = envVar("ANTHROPIC_BASE_URL");
  if (!base && envVar("NETLIFY_AI_GATEWAY_URL")) base = envVar("NETLIFY_AI_GATEWAY_URL").replace(/\/$/, "") + "/anthropic";
  return { key, base };
}
let client: Anthropic | null = null; let clientKey = "";
function claude() {
  const { key, base } = aiCreds();
  if (!key) {
    console.error("AI unavailable: no key. Present:", ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "NETLIFY_AI_GATEWAY_KEY", "NETLIFY_AI_GATEWAY_URL"].filter((n) => !!envVar(n)).join(",") || "none");
    return null;
  }
  if (!client || clientKey !== key) { client = new Anthropic({ apiKey: key, ...(base ? { baseURL: base } : {}) }); clientKey = key; }
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
/** Rough recipe from plain text, used when Claude can't be reached. */
function roughRecipe(text: string, src: string) {
  const lines = String(text || "").split(/\r?\n|(?<=[.!?])\s+(?=\d+[.)]\s)/).map((l) => l.replace(/#[\w-]+/g, "").replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim()).filter(Boolean);
  const ingredients: string[] = []; const steps: string[] = []; const rest: string[] = [];
  let mode = "";
  for (const l of lines) {
    if (/^(ingredients?|you('|’)ll need|what you need)\s*:?$/i.test(l)) { mode = "i"; continue; }
    if (/^(instructions?|directions?|method|steps|how to make( it)?)\s*:?$/i.test(l)) { mode = "s"; continue; }
    if (/^\d+[.)]\s+/.test(l) && mode !== "i") { steps.push(l.replace(/^\d+[.)]\s+/, "")); continue; }
    if (mode === "i" || /^[-•*▢]\s*/.test(l) || /^(\d+([\/.]\d+)?|[½⅓⅔¼¾])\s*(cups?|tbsp|tsp|tablespoons?|teaspoons?|oz|ounces?|lbs?|pounds?|g|grams?|kg|ml|l|cloves?|cans?|pinch)?\b/i.test(l)) { ingredients.push(l.replace(/^[-•*▢]\s*/, "")); continue; }
    if (mode === "s") { steps.push(l); continue; }
    rest.push(l);
  }
  const first = rest[0] || lines[0] || "Imported recipe";
  const title = (first.split(/(?<=[!.?])\s/)[0] || first).replace(/[!.:?]+$/, "").slice(0, 70);
  const nothingSorted = !ingredients.length && !steps.length;
  const notes = (nothingSorted ? lines : rest.slice(1)).join("\n").slice(0, 4000);
  return { title, description: "", servings: null, prepMin: null, cookMin: null, cuisine: "", tags: [], ingredients, steps, notes, sourceUrl: src || "" };
}

async function structure(text: string, src: string, images: { media_type: string; data: string }[] = []): Promise<{ recipe: any; ai: boolean } | null> {
  try {
    const r = await structureAi(text, src, images);
    return r ? { recipe: r, ai: true } : null;
  } catch (e: any) {
    console.error("Claude call failed:", e?.message || e);
    if (images.length || !text) throw new Error("ai_unavailable");
    return { recipe: roughRecipe(text, src), ai: false };
  }
}
async function structureAi(text: string, src: string, images: { media_type: string; data: string }[] = []) {
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
    const id = newId();
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

async function importRecipe(body: any, ai: { can: () => Promise<boolean>; used: () => Promise<void> }) {
  const shared = String(body.text || "");
  const url = String(body.url || "").trim() || firstUrl(shared);
  const extra = shared.replace(url, "").trim();
  const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  const finish = async (res: { recipe: any; ai: boolean } | null) => { if (res?.ai) await ai.used(); return res; };

  if (images.length) {
    const parsed = images.map((d: string) => { const m = String(d).match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/); return m ? { media_type: m[1], data: m[2] } : null; }).filter(Boolean);
    if (!parsed.length) return { error: "Those images couldn’t be read. Try JPG or PNG." };
    if (!(await ai.can())) return { error: LIMIT_MSG, limit: true };
    let r; try { r = await finish(await structure(extra, url, parsed as any)); } catch { return { error: BUSY_MSG_PHOTO }; }
    return r ? { recipe: r.recipe, method: "photo" } : { error: "Couldn’t find a recipe in those images. Make sure the ingredients and steps are visible." };
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
    if (!(await ai.can())) return { error: LIMIT_MSG, limit: true, url: found.finalUrl };
    const r = await finish(await structure(text, found.finalUrl || url));
    if (!r) return { error: found.platform === "web" ? "Couldn’t find a recipe on that page." : "That post doesn’t have the recipe written in its caption. If it’s only in the video, take a screenshot of the recipe and share that instead.", url: found.finalUrl };
    if (!r.recipe.notes && found.author) r.recipe.notes = "Recipe by " + found.author;
    const imageId = await savePhotoFromUrl(found.imageUrl || "");
    return { recipe: { ...r.recipe, imageId }, method: r.ai ? "caption" : "rough" };
  }
  if (extra.length >= 20) {
    if (!(await ai.can())) return { error: LIMIT_MSG, limit: true };
    const r = await finish(await structure(extra, ""));
    return r ? { recipe: r.recipe, method: r.ai ? "text" : "rough" } : { error: "Couldn’t find a recipe in that text." };
  }
  return { error: "Share a link, some recipe text, or a screenshot." };
}

/* ---------------- router ---------------- */
export default async (req: Request, _ctx: Context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = req.method;

  try {
    /* public routes */
    if (path[0] === "photo" && path[1] && method === "GET") {
      if (!ID_RE.test(path[1])) return fail("bad id", 404);
      const r = await photos().getWithMetadata(path[1], { type: "arrayBuffer" });
      if (!r) return new Response("not found", { status: 404 });
      return new Response(r.data as ArrayBuffer, { headers: { "content-type": String((r.metadata as any)?.type || "image/jpeg"), "cache-control": "public, max-age=31536000, immutable" } });
    }
    if (path[0] === "status" && method === "GET") return json({ ai: !!process.env.ANTHROPIC_API_KEY, configured: !FIREBASE_PROJECT_ID.startsWith("REPLACE") });
    if (path[0] === "share" && path[1] && method === "GET") {
      if (!ID_RE.test(path[1])) return fail("That link isn’t valid.", 404);
      const s = await getJSON<any>(`shares/${path[1]}`);
      return s ? json(s) : fail("That recipe link has expired or was removed.", 404);
    }

    /* everything else needs a signed-in person */
    const who = await whoIs(req);
    if (!who) return fail("Please sign in again.", 401);
    const { user, kitchen, kid } = await account(who);

    if (path[0] === "me" && method === "GET") {
      return json({
        user: { uid: who.uid, name: user.name, email: user.email },
        kitchen: { id: kid, name: kitchen.name, owner: kitchen.ownerUid === who.uid, inviteCode: kitchen.inviteCode, members: await memberList(kitchen) },
        usage: await usage(kid, kitchen),
      });
    }

    if (path[0] === "kitchen") {
      const body = method === "POST" ? await req.json().catch(() => ({})) : {};
      if (path[1] === "rename" && method === "POST") {
        const name = String(body.name || "").trim().slice(0, 60); if (!name) return fail("Type a name.");
        await putJSON(`kitchens/${kid}`, { ...kitchen, name }); return json({ ok: true });
      }
      if (path[1] === "invite" && method === "POST") {
        await store().delete(`invites/${kitchen.inviteCode}`);
        const inviteCode = randomBytes(6).toString("hex");
        await putJSON(`kitchens/${kid}`, { ...kitchen, inviteCode }); await putJSON(`invites/${inviteCode}`, { kitchenId: kid });
        return json({ inviteCode });
      }
      if (path[1] === "invite" && path[2] && method === "GET") {
        const inv = await getJSON<{ kitchenId: string }>(`invites/${path[2]}`);
        const k = inv && (await getJSON<Kitchen>(`kitchens/${inv.kitchenId}`));
        if (!inv || !k || k.inviteCode !== path[2]) return fail("That invite link is no longer valid. Ask for a new one.", 404);
        const owner = await getJSON<UserRec>(`users/${k.ownerUid}`);
        return json({ kitchenName: k.name, ownerName: owner?.name || "", already: inv.kitchenId === kid });
      }
      if (path[1] === "join" && method === "POST") {
        const code = String(body.code || "");
        const inv = /^[a-f0-9]{12}$/.test(code) ? await getJSON<{ kitchenId: string }>(`invites/${code}`) : null;
        const target = inv && (await getJSON<Kitchen>(`kitchens/${inv.kitchenId}`));
        if (!inv || !target || target.inviteCode !== code) return fail("That invite link is no longer valid. Ask for a new one.", 404);
        if (inv.kitchenId === kid) return json({ ok: true });
        // bring your recipes and cookbooks along if you were cooking alone
        if (kitchen.members.length === 1 && body.bringRecipes !== false) {
          const s = store();
          for (const col of ["recipes", "cookbooks"]) {
            const { blobs } = await s.list({ prefix: `k/${kid}/${col}/` });
            for (const b of blobs) { const d = await s.get(b.key, { type: "json" }); if (d) await s.setJSON(`k/${inv.kitchenId}/${col}/${b.key.split("/").pop()}`, d); }
          }
        }
        await leaveKitchen(who.uid, kid, kitchen);
        await putJSON(`kitchens/${inv.kitchenId}`, { ...target, members: Array.from(new Set([...target.members, who.uid])) });
        await putJSON(`users/${who.uid}`, { ...user, kitchenId: inv.kitchenId });
        await bump(inv.kitchenId);
        return json({ ok: true });
      }
      if (path[1] === "leave" && method === "POST") {
        if (kitchen.members.length === 1) return fail("You’re the only one in this kitchen.");
        await leaveKitchen(who.uid, kid, kitchen);
        const fresh = await newKitchen(who);
        await putJSON(`users/${who.uid}`, { ...user, kitchenId: fresh });
        return json({ ok: true });
      }
      if (path[1] === "remove" && method === "POST") {
        if (kitchen.ownerUid !== who.uid) return fail("Only the kitchen’s owner can remove people.", 403);
        const uid = String(body.uid || ""); if (!kitchen.members.includes(uid) || uid === who.uid) return fail("That person isn’t in your kitchen.");
        await putJSON(`kitchens/${kid}`, { ...kitchen, members: kitchen.members.filter((m) => m !== uid) });
        return json({ ok: true }); // their next visit gives them a fresh kitchen
      }
    }

    if (path[0] === "rev" && method === "GET") return json({ rev: (await store().get(`k/${kid}/rev`)) || "0" });
    if (path[0] === "data" && method === "GET") return json(await readKitchenData(kid));

    if (path[0] === "doc" && COLLECTIONS.includes(path[1]) && path[2] && ID_RE.test(path[2])) {
      const key = `k/${kid}/${path[1]}/${path[2]}`;
      if (method === "PUT") {
        const body = await req.json();
        if (!body || typeof body !== "object" || Array.isArray(body)) return fail("Expected an object.");
        if (JSON.stringify(body).length > 300_000) return fail("That item is too large.");
        delete (body as any).id;
        await store().setJSON(key, body); await bump(kid);
        return json({ ok: true });
      }
      if (method === "DELETE") { await store().delete(key); await bump(kid); return json({ ok: true }); }
    }

    if (path[0] === "photo" && method === "POST") {
      const type = req.headers.get("content-type") || "";
      if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return fail("Use a JPG, PNG or WebP image.");
      const buf = await req.arrayBuffer();
      if (buf.byteLength > 5_000_000) return fail("That photo is too large.");
      const id = newId();
      await photos().set(id, buf, { metadata: { type } });
      return json({ id });
    }

    if (path[0] === "share" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const r = body.recipe;
      if (!r || typeof r !== "object" || !r.title) return fail("Nothing to share.");
      const keep = ["title", "description", "servings", "prepMin", "cookMin", "cuisine", "tags", "ingredients", "steps", "notes", "sourceUrl", "imageId"];
      const recipe: Record<string, unknown> = {}; for (const k of keep) if (r[k] != null) recipe[k] = r[k];
      if (JSON.stringify(recipe).length > 200_000) return fail("That recipe is too large to share.");
      const id = randomBytes(9).toString("base64url");
      await putJSON(`shares/${id}`, { recipe, from: user.name, createdAt: Date.now() });
      return json({ id });
    }

    if (path[0] === "import" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const res: any = await importRecipe(body, { can: () => canSpendAi(kid, kitchen), used: () => recordAi(kid, kitchen) });
      res.usage = await usage(kid, kitchen);
      return json(res);
    }

    if (path[0] === "ai" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const messages = Array.isArray(body.messages) ? body.messages.filter((m: any) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()).slice(-20) : [];
      if (!messages.length || messages[messages.length - 1].role !== "user") return fail("Nothing to ask.");
      // the API wants turns to alternate, so fold back-to-back turns from the same side together
      for (let i = messages.length - 1; i > 0; i--) if (messages[i].role === messages[i - 1].role) { messages[i - 1] = { role: messages[i].role, content: messages[i - 1].content + "\n\n" + messages[i].content }; messages.splice(i, 1); }
      if (messages[0].role !== "user") messages.shift();
      if (JSON.stringify(messages).length > 120_000) return fail("That’s too much text.");
      if (!(await canSpendAi(kid, kitchen))) return fail(LIMIT_MSG, 429, { limit: true });
      const text = await ask(messages, Math.min(Number(body.maxTokens) || 1500, 3000), typeof body.system === "string" ? body.system.slice(0, 20000) : undefined);
      await recordAi(kid, kitchen);
      if (body.json) { const j = parseJsonReply(text); if (j == null) return fail("Claude’s answer didn’t come back in a usable form. Try again.", 502); return json({ data: j }); }
      return json({ text });
    }

    return fail("Not found", 404);
  } catch (e: any) {
    if (e?.message === "ai_unavailable" || e?.status >= 500 || e?.status === 429 || /overloaded|rate/i.test(String(e?.message || ""))) { console.error("AI error:", e?.status, e?.message); return fail(BUSY_MSG, 503); }
    console.error(e);
    return fail("Something went wrong on the server. Try again.", 500);
  }
};

async function leaveKitchen(uid: string, kid: string, k: Kitchen) {
  const members = k.members.filter((m) => m !== uid);
  if (!members.length) return; // an empty kitchen just sits unused
  await putJSON(`kitchens/${kid}`, { ...k, members, ownerUid: k.ownerUid === uid ? members[0] : k.ownerUid });
}

export const config: Config = { path: "/api/*" };
