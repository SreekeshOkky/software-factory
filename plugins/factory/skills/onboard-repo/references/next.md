# Next.js harness

Layers: Vitest (or the repo's existing Jest) with Testing Library for components and
`lib/`, Playwright for e2e against `next build && next start`, `tsc --noEmit` (plus
`next lint` if ESLint is already configured) for static checks.

## Survey hints
- App Router (`app/`) vs Pages Router (`pages/`). Mixed is possible.
- `next.config.*`: `output` (`export` / `standalone`), `basePath`, `trailingSlash`,
  `images`, redirects/headers, i18n.
- Server Components vs `"use client"` files. Server Actions. Route handlers (`app/api/**/route.ts`).
- Data fetching that needs secrets at build time (env vars). Note safe defaults for tests.
- Path aliases in `tsconfig.json` (`@/*`). Vitest needs them mirrored.
- Default port 3000.

## Packages
If Jest is already set up, keep it. Otherwise:
```bash
npm i -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event vite-tsconfig-paths @playwright/test
npx playwright install chromium
```

## `vitest.config.mts`
```ts
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [tsconfigPaths(), react()],
	test: {
		environment: "jsdom",
		include: ["tests/unit/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
		setupFiles: ["tests/setup.ts"], // import "@testing-library/jest-dom/vitest";
	},
});
```
Async Server Components can't be rendered by Testing Library. Test their data
functions as plain units and cover the rendered page in Playwright.

## Seed tests
- Unit: a real function from `lib/` or `utils/`.
- Component: render a real client component with `render()` and assert on roles
  (`screen.getByRole("button", { name: … })`).
- E2E: visit `/` and one other route; assert status 200, one `h1`, `<title>`.

## `playwright.config.ts`
```ts
import { defineConfig, devices } from "@playwright/test";
const PORT = Number(process.env.E2E_PORT ?? 3100);
export default defineConfig({
	testDir: "tests/e2e",
	use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] } },
		{ name: "mobile", use: { ...devices["Pixel 7"] } },
	],
	webServer: {
		command: `npm run build && npx next start -p ${PORT}`,
		url: `http://localhost:${PORT}/`,
		reuseExistingServer: false,
		timeout: 240_000,
	},
});
```
With `output: "export"`, there's no `next start`. Serve `out/` with a small static server
(see the Astro reference's `serve-dist.mjs`) or `npx serve out -l $PORT` if `serve` is
already a dependency.

## Scripts and `factory.yml`
```json
"check": "tsc --noEmit",
"test": "vitest run",
"test:e2e": "playwright test"
```
```yaml
install: "npm ci && npx playwright install chromium"
check: "npm run check"
test: "npm run check && npm test && npm run test:e2e"
start: "npm run build && npx next start -p 3000"
port: 3000
ready_path: "/"
```
If `next build` needs env vars, put **non-secret placeholders** in `.env.test` or the
script, never real values. If the app needs a database, say so in the PR. A test
container or mock layer is a separate decision for a human.
