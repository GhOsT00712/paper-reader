# Paper Reading List

Save research paper links, open them at the original source, and move papers between Unread and Read. D1 stores one shared list for all devices. Anyone who reaches the site can read and update it.

## Run locally

Use Node.js 22.12 or newer.

```sh
npm ci
npm run check
npm run build
npm run db:local
npm run dev
```

Open the URL Wrangler prints, typically http://localhost:8788. Rebuild after changing the frontend.

## Deploy on Cloudflare Pages

1. Create a D1 database with `npx wrangler d1 create paper-reading-list`.
2. Replace the placeholder `database_id` in `wrangler.jsonc` with the ID printed by Wrangler. Leave `preview_database_id` as `DB` for local development.
3. Run `npx wrangler d1 migrations apply paper-reading-list --remote`.
4. In Cloudflare Pages, connect this GitHub repository. Select `main` as the production branch, `npm run build` as the build command, and `dist` as the output directory. Select Node.js 22.12 or newer for the build. Disable branch previews to keep the deployment to one shared list.
5. Open the assigned `pages.dev` URL. Save a paper, open the source link, and mark it as read. Refresh from a second device and confirm the status persists.

The frontend, API, and D1 database fit Cloudflare's free tiers for ordinary personal use. Saved links and titles are public. Keep private links and URLs containing access tokens out of the list.
