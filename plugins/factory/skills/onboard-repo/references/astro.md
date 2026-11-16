# Astro harness

Tested against Astro 5 (static output, Vercel adapter). Layers: Vitest for
`lib/` code and components (via `experimental_AstroContainer`), Playwright for e2e
against the production build, `astro check` for types.

## Survey hints
- `astro.config.*`: `output` (`static` / `server`), `adapter`, `trailingSlash`,
  `site`, integrations (mdx, sitemap, react…), `vite` plugins, custom dev middleware.
- `src/content.config.ts` (Astro 5) or `src/content/config.ts` (Astro 4): collections
  and Zod schemas. These are what content tickets are tested against.
- `ClientRouter` / `ViewTransitions` in the head component means client scripts must
  re-init on `astro:page-load`. Look for `transition:persist`.
- Pages with `export const prerender = false` are server routes.
- Default dev port 4321.

## Packages
```bash
npm i -D vitest@^3 @playwright/test @astrojs/check typescript
npx playwright install chromium
```
Astro 5 ships Vite 6. Use **Vitest 3** (Vitest 4 expects Vite 7). Check with
`npm ls vite`. For Astro 4, use Vitest 1–2.

## `vitest.config.mjs`
```js
// @ts-check
import { getViteConfig } from "astro/config";

export default getViteConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
	},
});
```
`getViteConfig` loads `astro.config.*`, so `.astro` imports compile the same way as
in the site.

## Component seed test (AstroContainer)
Pick a small component with no `astro:content` import (content collections aren't
loaded in the container).
```ts
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { describe, expect, it } from "vitest";
import PageIntro from "../../src/components/PageIntro.astro";

describe("PageIntro", () => {
	it("renders one H1 with the title", async () => {
		const container = await AstroContainer.create();
		const html = await container.renderToString(PageIntro, { props: { title: "Blog", command: "ls" } });
		expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
		expect(html).toContain(">Blog</h1>");
	});
});
```
Also add one plain unit test of a real function in `src/lib/` or `src/data/`.

## E2E: `playwright.config.mjs`
Run against the **production build**, not `astro dev`.
- If the adapter supports it (`node`, `netlify`, no adapter): the web server command is
  `npm run build && npx astro preview --port $PORT`.
- **`@astrojs/vercel` does not support `astro preview`** ("The @astrojs/vercel adapter
  does not support the preview command"). The static pages are in `dist/client/`.
  Add `scripts/serve-dist.mjs`: a zero-dependency `node:http` server that serves
  `dist/client`, applies the `trailingSlash` rule (redirect `/x` → `/x/` when
  `/x/index.html` exists), serves `404.html` for misses, and sets any headers that
  pages depend on (for example COOP/COEP from `vercel.json`). Add `"serve": "node scripts/serve-dist.mjs"`.
  Server routes aren't served, so say so in `docs/app-navigation.md`.
- Use a port other than the `factory.yml` `port` (for example 4322, overridable with
  `E2E_PORT`), so e2e can run while the app is up.
```js
// @ts-check
import { defineConfig, devices } from "@playwright/test";
const PORT = Number(process.env.E2E_PORT ?? 4322);
export default defineConfig({
	testDir: "tests/e2e",
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
	projects: [
		{ name: "desktop", use: { ...devices["Desktop Chrome"] } },
		{ name: "mobile", use: { ...devices["Pixel 7"] } },
	],
	webServer: {
		command: `npm run build && node scripts/serve-dist.mjs --port ${PORT}`,
		url: `http://localhost:${PORT}/`,
		reuseExistingServer: false,
		timeout: 180_000,
	},
});
```
E2E seed: visit each top-level route and assert status 200, one `h1`, non-empty
`<title>` and meta description, and the trailing-slash redirect if configured.

## Scripts
```json
"check": "astro check",
"test": "vitest run",
"test:e2e": "playwright test"
```
`factory.yml`:
```yaml
install: "npm ci && npx playwright install chromium"
check: "npm run check"
test: "npm run check && npm test && npm run test:e2e"
start: "npm run build && npm run preview -- --port 4321"   # or: npm run serve -- --port 4321
port: 4321
```

## `astro check` on existing code
It often reports errors in a repo that has never run it. Common ones, and fixes that
don't change behaviour:
- `<!-- comment -->` reported as "Identifier expected" / "Unexpected token": usually an
  **unbalanced tag** earlier in the file (a stray `</div>`). The compiler silently drops
  the stray tag, so find it (count opens/closes) and remove **the one the compiler
  dropped**. Diff the built HTML before and after to prove the output is unchanged.
- `Property 'dataset' does not exist on type 'Element'`: `querySelector<HTMLElement>(…)`.
- `'x' is possibly 'undefined'` on `entry.body`: `(entry.body ?? "")`.
- Untyped CDN `import("https://…")`: `// @ts-ignore` with a reason.
- `<Image src={stringOrMetadata}>` overload errors: cast to the variant that matches the props.
Snapshot `dist/` before, rebuild after, and diff (normalize hashed `_astro/*` names).
Commit these fixes separately (`fix: clear astro check errors without changing output`).
If you can't get to 0 errors safely, keep `check` out of `test` and say why in the PR.

## Content-ticket mode (if the repo has content collections)
The red test is a Playwright spec for `/<collection>/<slug>/` asserting: 200; one H1
equal to the frontmatter title; `<title>` and meta description from the frontmatter;
SEO length limits the repo uses; hero/image alt rules; the entry is linked from its
index page. Frontmatter schema errors fail `astro build`, which the e2e web server runs.
