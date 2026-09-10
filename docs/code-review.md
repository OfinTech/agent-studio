# Initial publication review

Reviewed the whole repository before its first push to `origin/main`. The review covered the editor, workflow contracts, runtime, persistence and migrations, provider adapters, network and credential boundaries, tests, documentation, and CI. Live-provider verification was deferred at the owner's request.

## Resolved findings

- **Recovery could turn committed success into failure.** Execution and maintenance now recognize a committed terminal checkpoint even after the run deadline. MCP transport cleanup errors no longer invalidate a committed step. PostgreSQL regression tests cover both recovery paths and cleanup failure.
- **Run locks could leak pooled connections.** Lock ownership now has a dedicated lifetime helper that releases connections on acquisition or execution failure and discards a connection if unlock fails. Unit tests exercise contention and both failure boundaries.
- **Durable execution mixed unrelated responsibilities.** Checkpoint persistence, email dispatch, tool dispatch, and run failure handling now have separate modules. The executor retains orchestration and agent execution. Checkpoint writes update memory only after commit, with named completion details instead of positional outcome/email flags.
- **Persistence boundaries were loosely typed.** Checkpoint decoding validates the stored structure while retaining opaque provider continuation blocks and legacy decoding. Runtime records and MCP results have explicit types. Shared outbound message contracts no longer depend on the connector package from the persistence schema.
- **Validation rules could diverge.** Connection type rules are shared by editor checks and publication. Outcome settings use the same connection validation and no longer duplicate the current target. Action references accept known envelope fields and dynamic `data` paths; nonexistent envelope fields fail publication.
- **Expected publication errors could become HTTP 500s.** Domain configuration failures now have a dedicated error class, preserving the existing JSON error envelope and returning HTTP 400 without matching exception message prefixes.
- **Large settings components obscured behavior.** Agent and Outcome settings are separate feature components using the existing Mantine composition. Canvas geometry, styling, scrolling and workflow draft ownership remain unchanged.
- **Publication hygiene needed repeatable checks.** Formatting is enforced in CI. Next.js generated declarations are ignored and regenerated before type checking, following the installed Next.js documentation. Environment files, attachments, screenshots and build output remain excluded from Git.
- **The first CI run exposed browser fixture and startup assumptions.** CI now tests the production build instead of compiling routes during assertions. Navigation selectors identify the sidebar, and management screenshots create their own credential, workflow and completed run. Diagnostic uploads are best-effort with seven-day retention because the account's artifact storage quota prevented uploads; verification failures still fail CI.

The changes preserve published snapshots, migration history, checkpoint version 2 and legacy decoding, agent completion rules, and the editor/API contract. No new database migration or dependency was required for the cleanup.

## Verification

- Formatting, lint/UI policy, backend/frontend type checks, and migration metadata checks passed.
- 93 unit/contract/provider/policy tests and 46 PostgreSQL integration tests passed.
- 18 browser tests passed, including publication error handling, Outcome target uniqueness, terminal email previews, keyboard interaction and desktop/mobile scrolling.
- Production Next.js build passed.
- `pnpm audit --prod --audit-level high` reported no known vulnerabilities.
- The initial commit candidates were checked for credential patterns and excluded local data and generated files. This check is not a substitute for deployment security review.

The Docker preview was rebuilt on port 3001. Its health check and receipt/email preview smoke tests passed against the actual API, queue and worker, including durable terminal completion without a sending attempt. Live-provider results remain separate from local verification.
