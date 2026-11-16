# Vite + React harness

Layers: Vitest (jsdom, Testing Library) for components and logic, Playwright for e2e
against `vite build && vite preview`, `tsc -b` / `tsc --noEmit` for types.

## Survey hints
- `vite.config.*`: plugins, `base`, `server.port` / `preview.port`, proxies (`server.proxy`
  to a backend: e2e can't rely on it unless the backend runs too).
- Router (React Router / TanStack Router), state (Redux/Zustand/Query), data layer
  (fetch, Supabase, Firebase). Note which network calls the UI makes on load.
- `tsconfig.app.json` / `tsconfig.node.json` split (the `npm create vite` default):
  the type-check command is `tsc -b`.
- Existing ESLint flat config (`eslint.config.js`): add `npm run lint` to `check` only if
  it passes today.
- Default dev port 5173, preview 4173.

## Packages
```bash
npm i -D vitest jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event @playwright/test
npx playwright install chromium
```
Match the Vitest major to the repo's Vite major (`npm ls vite`): Vite 5 → Vitest 1–2,
Vite 6 → Vitest 3, Vite 7 → Vitest 3.2+ or 4.

## Vitest config
Add a `test` block to `vite.config.ts` (with `/// <reference types="vitest/config" />`)
or a separate `vitest.config.ts` that `mergeConfig`s it:
```ts
test: {
	environment: "jsdom",
	include: ["src/**/*.test.{ts,tsx}", "tests/unit/**/*.test.{ts,tsx}"],
	setupFiles: ["tests/setup.ts"], // import "@testing-library/jest-dom/vitest";
},
```
Put tests where the repo already does: colocated `*.test.tsx`, or `tests/unit/`.

## Seed tests
- Component: render a real component (wrap in the app's providers/router if it needs
  them, using a `renderWithProviders` helper in `tests/`). Assert by role.
- Unit: a real hook or util.
- E2E: load `/`, assert the main heading and one navigation step.
- Network: mock at the boundary. Use `vi.mock` for the API module in unit tests, and
  `page.route()` in Playwright for calls to external services. Tests must not hit
  production backends.

## `playwright.config.ts`
```ts
const PORT = Number(process.env.E2E_PORT ?? 4174);
webServer: {
	command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
	url: `http://localhost:${PORT}/`,
	reuseExistingServer: false,
},
```
If `base` isn't `/`, use it in `url` and `ready_path`.

## Scripts and `factory.yml`
```json
"check": "tsc -b",
"test": "vitest run",
"test:e2e": "playwright test"
```
```yaml
install: "npm ci && npx playwright install chromium"
check: "npm run check"
test: "npm run check && npm test && npm run test:e2e"
start: "npm run build && npx vite preview --port 4173 --strictPort --host"
port: 4173
ready_path: "/"
```
For a SPA, the verifier needs the client routes listed in `docs/app-navigation.md`.
Deep links work under `vite preview`, which falls back to `index.html`.
