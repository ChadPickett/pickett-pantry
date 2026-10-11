# Pickett Pantry

Family recipe box, meal planner and grocery list. Install it on your phone from Chrome and it shows up in the Share menu: share a recipe link, an Instagram/TikTok/YouTube/Facebook post, or a screenshot, and it looks up the recipe for you.

## How it works

- `public/` is the app (one page, plus the install manifest and service worker that receives shared links).
- `netlify/functions/api.mts` is the server: household passcode, storage (Netlify Blobs), photo storage, recipe lookup and Claude calls.
- `lib/extract.mjs` reads recipes out of web pages. Recipe websites publish structured recipe data, which is read directly. Social posts use the caption, which Claude turns into a recipe.

Claude runs through Netlify's AI Gateway (model `claude-haiku-5-5`), billed to the Netlify account's credits. No API key needed.

## Deploying

Netlify builds this repo automatically on every push to `main`. There is no build step.
