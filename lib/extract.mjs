// Pure helpers for pulling recipes out of web pages. No network calls here,
// so everything in this file can be tested with saved HTML.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', frac12: '½', frac14: '¼', frac34: '¾', times: '×', eacute: 'é', egrave: 'è', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', reg: '®', trade: '™', copy: '©' };

export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

export function cleanText(s) {
  return decodeEntities(decodeEntities(String(s ?? '')).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function getMeta(html, name) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[:.]/g, '\\$&')}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name.replace(/[:.]/g, '\\$&')}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m ? decodeEntities(m[1]).trim() : '';
}

/** ISO 8601 duration (PT1H30M) to minutes. */
export function isoMinutes(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 0 ? Math.round(v) : null;
  const m = String(v).match(/P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+)S)?/i);
  if (!m) return null;
  const mins = (+(m[1] || 0)) * 1440 + (+(m[2] || 0)) * 60 + (+(m[3] || 0)) + Math.round((+(m[4] || 0)) / 60);
  return mins > 0 ? Math.round(mins) : null;
}

function asArray(v) { return v == null ? [] : Array.isArray(v) ? v : [v]; }
function isRecipe(node) { return node && typeof node === 'object' && asArray(node['@type']).some(t => String(t).toLowerCase() === 'recipe'); }

function findRecipeNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; } return null; }
  if (isRecipe(node)) return node;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item']) {
    if (node[k]) { const r = findRecipeNode(node[k], depth + 1); if (r) return r; }
  }
  return null;
}

export function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { out.push(JSON.parse(raw)); continue; } catch {}
    try { out.push(JSON.parse(raw.replace(/[\u0000-\u001f]+/g, ' '))); } catch {}
  }
  return out;
}

export function findJsonLdRecipe(html) {
  for (const b of jsonLdBlocks(html)) { const r = findRecipeNode(b); if (r) return r; }
  return null;
}

function firstNumber(v) {
  for (const x of asArray(v)) {
    const m = String(x).match(/\d+(?:\.\d+)?/);
    if (m) return parseFloat(m[0]);
  }
  return null;
}

function imageOf(v) {
  for (const x of asArray(v)) {
    if (typeof x === 'string' && /^https?:/i.test(x)) return x;
    if (x && typeof x === 'object') { const u = x.url || x.contentUrl || x['@id']; if (typeof u === 'string' && /^https?:/i.test(u)) return u; }
  }
  return '';
}

function stepsOf(v) {
  const out = [];
  const walk = (x) => {
    if (x == null) return;
    if (typeof x === 'string') {
      cleanText(x).split(/\n+/).map(s => s.trim()).filter(Boolean).forEach(s => out.push(s.replace(/^\d+[.)]\s*/, '')));
      return;
    }
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object') {
      const t = asArray(x['@type']).map(String);
      if (t.includes('HowToSection')) {
        if (x.name) out.push(cleanText(x.name).replace(/:?$/, ':'));
        walk(x.itemListElement || x.steps);
        return;
      }
      const text = x.text || x.name || x.description;
      if (text) walk(String(text));
      else if (x.itemListElement) walk(x.itemListElement);
    }
  };
  walk(v);
  return out;
}

function tagsOf(r) {
  const words = [];
  for (const v of [r.recipeCategory, r.keywords]) {
    for (const x of asArray(v)) String(x).split(',').forEach(w => { w = cleanText(w).toLowerCase(); if (w && w.length <= 20 && !words.includes(w)) words.push(w); });
  }
  return words.slice(0, 4);
}

/** Map a schema.org Recipe node to the app's recipe shape. */
export function mapJsonLd(r, sourceUrl) {
  const prep = isoMinutes(r.prepTime);
  let cook = isoMinutes(r.cookTime);
  const total = isoMinutes(r.totalTime);
  if (!cook && total && total > (prep || 0)) cook = total - (prep || 0);
  const cuisine = asArray(r.recipeCuisine).map(cleanText).filter(Boolean)[0] || '';
  return {
    title: cleanText(r.name || r.headline || ''),
    description: cleanText(r.description || '').slice(0, 400),
    servings: firstNumber(r.recipeYield),
    prepMin: prep,
    cookMin: cook,
    cuisine,
    tags: tagsOf(r),
    ingredients: asArray(r.recipeIngredient || r.ingredients).map(cleanText).filter(Boolean),
    steps: stepsOf(r.recipeInstructions),
    notes: '',
    sourceUrl: sourceUrl || '',
    imageUrl: imageOf(r.image),
    rating: ratingOf(r.aggregateRating),
    diets: dietsFromSchema(r.suitableForDiet),
    totalMin: total || ((prep || 0) + (cook || 0)) || null,
  };
}

function ratingOf(a) {
  if (!a || typeof a !== 'object') return null;
  const value = parseFloat(a.ratingValue);
  const count = parseInt(a.ratingCount || a.reviewCount || 0, 10) || 0;
  if (!isFinite(value) || value <= 0) return null;
  const best = parseFloat(a.bestRating) || 5;
  return { value: Math.round((value / best) * 5 * 10) / 10, count };
}

const SCHEMA_DIETS = { VeganDiet: 'vegan', VegetarianDiet: 'vegetarian', GlutenFreeDiet: 'gluten-free', LowCalorieDiet: 'low-calorie', LowFatDiet: 'low-fat', LowLactoseDiet: 'dairy-free', DiabeticDiet: 'diabetic-friendly', HalalDiet: 'halal', KosherDiet: 'kosher', LowSaltDiet: 'low-salt' };
function dietsFromSchema(v) {
  const out = [];
  for (const x of asArray(v)) { const k = String(x).split('/').pop(); if (SCHEMA_DIETS[k] && !out.includes(SCHEMA_DIETS[k])) out.push(SCHEMA_DIETS[k]); }
  return out;
}

/** Diet labels guessed from the ingredient list. Conservative: a label only shows when nothing contradicts it. */
const MEAT = /\b(chicken|beef|pork|bacon|ham|turkey|lamb|sausage|fish|salmon|shrimp|prawn|tuna|anchov|gelatin|prosciutto|pepperoni|salami|crab|lobster|scallop|chorizo|veal|duck|steak|meatball|clam|mussel|oyster|cod|tilapia|halibut|venison)/i;
const DAIRY = /\b(milk|butter|cheese|cream|yogurt|yoghurt|ghee|whey|parmesan|parmigiano|mozzarella|cheddar|ricotta|feta|mascarpone|buttermilk|half[- ]and[- ]half|cr[eè]me fra[iî]che|custard)/i;
const NOT_DAIRY = /\b(coconut|almond|oat|soy|cashew|rice|peanut|nut|vegan|dairy[- ]free|cocoa|shea|apple|plant[- ]based)\s+(milk|butter|cream|cheese|yogurt)|\bcream of tartar|\bbutternut|\bbuttercup/gi;
const EGG = /\b(eggs?|egg yolks?|egg whites?|mayo|mayonnaise|meringue)\b/i;
const HONEY = /\bhoney\b/i;
const GLUTEN = /\b(flour|bread|breadcrumbs?|panko|pasta|spaghetti|penne|macaroni|noodles?|couscous|barley|bulgur|farro|seitan|beer|crackers?|tortillas?|pita|bun|buns|croutons|wheat|semolina|orzo|soy sauce|biscuits?|pie crust|puff pastry)\b/i;
const NOT_GLUTEN = /\b(almond|coconut|rice|tapioca|cassava|oat|chickpea|corn|gluten[- ]free|potato|buckwheat)\s+(flour|noodles?|pasta|tortillas?|bread)|\btamari\b|\bcorn tortillas?/gi;
const CARBY = /\b(sugar|flour|rice|pasta|spaghetti|penne|macaroni|linguine|fettuccine|rigatoni|ziti|lasagna|orzo|gnocchi|couscous|noodles?|potato(es)?|bread|honey|maple syrup|molasses|beans|chickpeas|lentils|corn|tortillas?|oats|quinoa|banana|crackers?|cereal|breadcrumbs?|panko)\b/i;
const NOT_CARBY = /\b(almond|coconut)\s+flour|\bcauliflower rice|\bsugar[- ]free|\bgreen beans/gi;
export function dietGuess(ingredients) {
  const text = asArray(ingredients).join('\n');
  const plain = (re) => text.replace(re, ' ');
  const meat = MEAT.test(text);
  const dairy = DAIRY.test(plain(NOT_DAIRY));
  const egg = EGG.test(text);
  const gluten = GLUTEN.test(plain(NOT_GLUTEN));
  const carby = CARBY.test(plain(NOT_CARBY));
  const out = [];
  if (!meat && !dairy && !egg && !HONEY.test(text)) out.push('vegan');
  if (!meat) out.push('vegetarian');
  if (!dairy) out.push('dairy-free');
  if (!gluten) out.push('gluten-free');
  if (!carby) out.push('low-carb');
  return out;
}

/** Recipe page links from a site's own search results page. */
export function linksFrom(html, re, limit = 3) {
  const out = [];
  for (const m of String(html || '').matchAll(re)) { const u = m[0].replace(/["'].*$/, ''); if (!out.includes(u)) out.push(u); if (out.length >= limit) break; }
  return out;
}

/** Readable text from a page, for when there is no structured recipe. */
export function htmlToText(html, limit = 40000) {
  let h = String(html || '');
  h = h.replace(/<(script|style|noscript|svg|iframe|nav|footer|header|form)[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ');
  return cleanText(h).replace(/\n{3,}/g, '\n\n').slice(0, limit);
}

export function platformOf(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, ''); } catch { return 'invalid'; }
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(host)) return 'facebook';
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
  if (/(^|\.)(pinterest\.[a-z.]+|pin\.it)$/.test(host)) return 'pinterest';
  if (/(^|\.)threads\.(net|com)$/.test(host)) return 'threads';
  return 'web';
}

/** Instagram and Facebook put the caption in og:description as `N likes, N comments - user on date: "caption"`. */
export function captionFromOg(desc) {
  const d = String(desc || '');
  const m = d.match(/:\s*["“]([\s\S]+)["”]\s*\.?\s*$/);
  return (m ? m[1] : d).trim();
}

/** YouTube keeps the full description in the page's player JSON. */
export function youtubeDescription(html) {
  const m = String(html).match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1].replace(/\\n/g, '\n'); }
}

/** First http(s) URL inside shared text (apps often share "Check this out https://..."). */
export function firstUrl(s) {
  const m = String(s || '').match(/https?:\/\/[^\s<>"']+/i);
  return m ? m[0].replace(/[).,]+$/, '') : '';
}

/** Pull a JSON object or array out of a model reply. */
export function parseJsonReply(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch {}
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
