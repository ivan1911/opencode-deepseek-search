# AGENTS.md

OpenCode **2.x** plugin (`Plugin.define` from `@opencode/plugin`, id `deepseek.search`) that wraps the DeepSeek Search & Fetch API. OpenCode 1.x uses a different loader; compatibility with it is out of scope.

## Code

- The package ships TypeScript source as-is: `exports` points at `src/index.ts`, there is no build step and no `dist/`. Node runs it through native type stripping, so relative imports carry the `.ts` extension and the code sticks to erasable syntax (types, no enums or parameter properties).
- `src/deepseek.ts` is the pure core and imports nothing from OpenCode; tests exercise it with a fake `fetch`. New request/response logic goes here, with a test in `test/deepseek.test.ts`.
- `src/index.ts` is wiring only: the websearch provider, the `deepseek_search` / `deepseek_fetch` tools, API key resolution.
- Runtime dependencies stay at zero; `@opencode/plugin` is an optional peer.
- README tables (plugin options, tool inputs) mirror `Options`, `SearchInput` and `FetchInput` — change them together.

Done means `npm run typecheck` and `npm test` both pass.

## Commits

Conventional prefixes: `feat:`, `fix:`, `ci:`, `chore:`, `docs:`.

## Releases

Tag-driven: `npm version <patch|minor|major>` then `git push origin main --follow-tags`; `.github/workflows/publish.yml` publishes to npm via trusted publishing (OIDC, no token). Read `RELEASING.md` (local, untracked) before changing the publish workflow, the workflow filename, or the release flow.
