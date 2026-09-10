# Outcome branching verification

Verified locally on 2026-09-10 using synthetic fixtures. The preview was rebuilt and restarted at <http://localhost:3001> using the existing `agent-platform-mantine-smoke` Compose project, retaining its database and attachment volumes.

| Check                          | Result                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `pnpm lint`                    | Passed: ESLint and exact UI-policy exceptions                                             |
| `pnpm typecheck`               | Passed: backend and frontend                                                              |
| `pnpm exec drizzle-kit check`  | Passed: migration metadata                                                                |
| `pnpm test`                    | 71 passed; integration suite deliberately skipped in this command                         |
| `pnpm test:integration`        | 29 passed against an isolated PostgreSQL database                                         |
| `pnpm test:e2e`                | 14 passed using Chromium, real local API/queue/worker, and synthetic MCP endpoint         |
| `pnpm build`                   | Passed: production Next.js build                                                          |
| Docker Compose rebuild/restart | Passed; web on 3001, worker and mock API running, PostgreSQL healthy                      |
| `pnpm test:smoke`              | Passed: published receipt workflow, durable queue execution, MCP call, receipt API result |

Contract coverage includes stable state connections after renaming/reordering, atomic state/edge removal, custom states, typed references, graph/reference rejection, reserved completion names, and legacy workflow parsing. Provider fixtures cover Gemini signatures, OpenAI reasoning/output items, Claude signature blocks, call/result IDs, local PDF/JPEG/PNG hydration, refusals, truncation, and transient versus configuration errors.

PostgreSQL coverage includes Success, Failure and Review selection, terminal states, nested agents, per-node conversations/tool scopes, completion correction without action dispatch, ten-turn exhaustion, provider failures, interruption before and after outcome acceptance, terminal cursor recovery, completed-action ledger recovery, independent identities for identical actions in separate nodes, retry idempotency keys, uncertain writes, legacy checkpoints, and an actual killed-worker recovery test.

Browser coverage includes adding Outcome from agent settings and Add step, source selection and successor rerouting, generated instructions, state renaming/reordering/removal, Tool action input configuration, Save/Publish/refresh, existing draft navigation/restoration, inspector reports, keyboard interactions, desktop/mobile canvas sizing, and focus restoration. The new tests exposed and fixed overlapping new-node placement and the asynchronous Test run trigger's focus restoration.

## Screenshots

- [Desktop editor](../test-results/desktop-outcome-editor.png)
- [Desktop Outcome settings](../test-results/desktop-outcome-settings.png)
- [Desktop inspector](../test-results/desktop-outcome-inspector.png)
- [Mobile editor](../test-results/mobile-outcome-editor.png)
- [Mobile Outcome settings](../test-results/mobile-outcome-settings.png)
- [Mobile inspector](../test-results/mobile-outcome-inspector.png)

Screenshots are generated artifacts in the ignored `test-results` directory; CI uploads that directory. Desktop editor/settings and mobile settings/inspector images were visually inspected locally.

## Live checks: not run

`pnpm test:live` and `pnpm test:live:outcomes` were invoked without their opt-in flags and correctly made no live calls. These are not live-provider passes.

None of `LIVE_GEMINI_CREDENTIAL_ID`, `LIVE_GEMINI_MODEL`, `LIVE_CLAUDE_CREDENTIAL_ID`, `LIVE_CLAUDE_MODEL`, `LIVE_OPENAI_CREDENTIAL_ID`, or `LIVE_OPENAI_MODEL` is configured in this environment. The real inbound check also lacks `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`, and requires a configured receiving domain/public webhook and a real incoming receipt.

The new opt-in outcome script runs three synthetic tasks per configured real provider (Success, Failure, custom Review), against a controlled local HTTP action endpoint, and verifies only the selected branch executes. Missing provider configuration is explicitly reported as skipped with a nonzero exit when opted in. Setup commands and provider documentation are in the [README](../README.md#provider-setup).
