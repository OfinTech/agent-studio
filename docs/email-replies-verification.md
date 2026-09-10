# Terminal email replies verification

Verified with synthetic fixtures on 2026-09-10. No real emails were sent during local verification.

| Check                          | Result                                                                                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`                    | Passed: ESLint and exact UI-policy exceptions; no CSS additions                                                                                            |
| `pnpm typecheck`               | Passed: backend and frontend                                                                                                                               |
| `pnpm exec drizzle-kit check`  | Passed                                                                                                                                                     |
| `pnpm test`                    | 85 unit/contract/provider/policy tests passed                                                                                                              |
| `pnpm test:integration`        | 43 PostgreSQL tests passed in an isolated database                                                                                                         |
| `pnpm test:e2e`                | 17 Chromium browser tests passed against the local API, queue and worker                                                                                   |
| `pnpm build`                   | Passed: production Next.js build                                                                                                                           |
| Docker receipt and email smoke | Passed: receipt submission, rendered email preview, durable completion with no sending attempt                                                             |
| Preview                        | Rebuilt and restarted at http://localhost:3001 using the existing `agent-platform-mantine-smoke` Compose project; database and attachment volumes retained |

Coverage includes terminal connections, branch-specific references, required and malformed templates, subject defaults/customization, display-name addresses, header injection, original message IDs and legacy emails, bounded Resend requests, safe provider errors, stable idempotency keys, the deduplication expiry guard, and zero-dispatch Test previews. Runtime tests exercise Success, Failure and custom Review branches; action data references; empty resolved bodies; crashes before dispatch, after acceptance, and after completion; frozen retry payloads; acceptance reuse; and both execution and maintenance deadlines. A PostgreSQL trigger forces checkpoint failure to verify acceptance, step success and cursor updates roll back together. Existing killed-worker and legacy-checkpoint checks remain passing.

Browser coverage includes keyboard Add step, terminal handles, fixed sender/recipient, subject/body reference insertion, downstream connection settings, Save/Publish/refresh, rendered preview inspection and focus restoration, independently scrolling desktop settings, mobile Drawer scrolling, removal and refresh. Screenshots were visually inspected:

- `test-results/desktop-email-preview.png`
- `test-results/mobile-email-settings.png`

An upgrade check exposed a generated migration timestamp older than the previous migration. The new journal entry now follows existing entries; the new regression check prevents silent skipping on upgrades. The additive migration was applied to the existing local database without modifying earlier migrations or published versions.

## Live verification unavailable

`pnpm test:live:email` makes no live calls without opt-in. Invoking it with `RUN_LIVE_EMAIL=1` reports the missing `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `LIVE_EMAIL_WORKFLOW_ID`, and `LIVE_EMAIL_SENDER` and exits nonzero. Real provider credential IDs are also absent. These are missing-configuration results, not live-provider passes.

The new live observer waits for a real email from the configured controlled sender, verifies threaded Resend acceptance and exactly one selected email branch, and requires unselected email nodes to remain unexecuted. Use a verified outbound trigger domain and repeat with tasks selecting each branch. Confirm inbox delivery/threading separately. Existing receipt and real-provider Outcome verification requirements remain documented in the README.
