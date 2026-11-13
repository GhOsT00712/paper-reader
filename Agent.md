# Paper Reader contributor guide

Paper Reader is a vanilla TypeScript app with two Vite entry points, Cloudflare Pages Functions, and a shared D1 database. See [architecture.md](architecture.md) for the data model, request paths, and sync contract.

## Local workflow

Use Node.js 22.12 or newer. Run these commands from the repository root.

```sh
npm ci
npm run check
npm run build
npm run db:local
npm run dev
```

Open the local URL printed by Wrangler. Rebuild the frontend after edits when running through Wrangler. Use the local database for fixtures and exploratory writes.

## Where to make changes

| Area | Files |
|---|---|
| Library, menus, dialogs, keyboard shortcuts | [index.html](index.html), [src/main.ts](src/main.ts) |
| Shared theme and styles | [src/theme.ts](src/theme.ts), [src/style.css](src/style.css) |
| PDF layout, controls, reflow, and rendering | [reader.html](reader.html), [src/reader.ts](src/reader.ts), [src/reader.css](src/reader.css), [src/reader-text.ts](src/reader-text.ts), [src/reader-raster.ts](src/reader-raster.ts) |
| Source detection, versioning, and sync | [src/pdf-source.ts](src/pdf-source.ts), [src/reader-sync.ts](src/reader-sync.ts), [src/pdf-state.ts](src/pdf-state.ts) |
| API and schema | [functions/api/papers](functions/api/papers), [migrations](migrations) |

## Project conventions

- Use the existing TypeScript and Tailwind/CSS setup. Reuse shared theme tokens and keep control labels, keyboard focus, and reduced-motion support.
- Preserve saved paper IDs, normalized URL behavior, reading status, and existing JSON, CSV, and BibTeX exports when making UI changes. Keep shortcuts inactive while users type or interact with a dialog.
- Use PDF coordinates for highlights. Keep page number and fractional offset compatible with saved reading positions. Preserve batch IDs on retry and retain highlight tombstones so old retries cannot resurrect deleted highlights.
- Use bound SQL parameters. Add a new migration for schema changes and apply it before code that requires it. Keep the shared data model in mind when changing writes. Everyone who can reach the app uses the same library.
- Preserve source validation and redirect checks in the server-side PDF fetch path. Store reading state and annotations in D1. PDF bytes are fetched for the active reader session.

## Verification and release

Run `npm run check` and `npm run build`. For library changes, exercise the affected search, filtering, editing, or export flows. For reader changes, check PDF view and Text view on a narrow touch viewport and verify that saved annotations and position restore in a second session.

Cloudflare Pages builds production from `main`. Follow the repository's [deployment instructions](README.md#deploy-on-cloudflare-pages) for D1 migrations and settings. Check the production deployment commit and exercise the live feature after rollout.
