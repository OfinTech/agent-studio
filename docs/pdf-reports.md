# PDF reports

Enable **Generate PDF reports** in an Agent, then select that Agent under **Attach PDF report from** in a downstream Send email step. Save and publish. The feature is off by default; previous published versions are unchanged. Outcome is optional and `finish_task({ state, reason, result })` is unchanged. A Failure or custom Outcome branch can send a text-only explanation by selecting **None** for its attachment.

The Agent calls the internal MCP tool `generate_pdf({ source })`. The backend writes `report.pdf` and commits the current report alongside the Agent's output when it completes. The tool returns a report ID, page count, at most ten 500-character warnings and a 2,000-character text preview. It never returns PDF bytes or filesystem paths. The inspector retains up to 20,000 characters of extracted text and serves downloads through an authenticated, run-scoped endpoint. Compilation and extraction do not establish factual accuracy or visual correctness.

## Supported LaTeX and limits

The renderer profile `tectonic-0.15.0-bundle33-report-v1` uses Tectonic 0.15.0 (architecture-specific checksums in its Dockerfile), a pinned Debian base image and snapshot packages for Poppler. Build-time dependency warming checks article and report classes at 10, 11 and 12 points. The TeX bundle digest is `6ffe055852f8faf66c0acbe1a7fb27f87b869a90bad1204f3bf4d9683f597c7c`. Changing the engine, bundle, dependencies or validation policy requires a new renderer profile and retaining support for any published profile still in use.

Supported packages: `geometry`, `amsmath`, `amssymb`, `array`, `booktabs`, `longtable`, `hyperref`. Standard headings, lists, margins, equations, tables, hyperlinks and bundled fonts are supported. For this original free-form profile: no uploaded assets, custom packages/fonts, runtime downloads or shell escape. The build warms dependencies online; runtime invokes Tectonic with `--untrusted --only-cached`. Tectonic 0.15's `--bundle` accepts a local directory/ZIP, so the service uses its versioned default bundle cache rather than supplying a remote URL to that option. See [Tectonic compilation documentation](https://tectonic-typesetting.github.io/book/latest/v2cli/compile.html).

| Limit                       | Value                                                                      |
| --------------------------- | -------------------------------------------------------------------------- |
| UTF-8 source                | 128 KiB                                                                    |
| Compilation plus validation | 30 seconds per attempt                                                     |
| PDF                         | 1–20 pages, at most 10 MiB, readable, unencrypted, nonempty extracted text |
| Distinct sources            | Three per Agent, including invalid sources                                 |
| Existing execution budget   | Ten turns per Agent, five minutes per run                                  |
| Retention                   | Seven days after terminal execution                                        |

The most recent attempt determines the current report. A failure clears the previous candidate; repeating successful source reuses its immutable file and makes it current again, even after the three-source limit. A duplicate tool-call identity replays its recorded result. Infrastructure interruption resumes the same ledger entry without becoming an ambiguous external API write. Bytes are flushed before the metadata/result transaction acknowledges success. Checkpoints contain references and bounded tool responses, never binary files.

Email preparation validates the selected report's run, Agent, file, size and checksum, then freezes its identity, filename and checksum alongside the existing subject/body. Dispatch revalidates the frozen reference and constructs [Resend's base64 attachment request](https://resend.com/docs/dashboard/emails/attachments) in memory. Retries use the same file and idempotency key. Preview generates a real PDF but makes no sending request. Missing or invalid attachments fail before dispatch. The inspector's **Accepted by Resend** status still means provider acceptance, not delivery.

Maintenance deletes expired files and extracted text (including checkpoint tool previews), retains basic attempt metadata, and sweeps abandoned files. Active runs retain reports through email retries. Workflow deletion removes report records in the same transaction as run history; file deletion follows commit, with orphan cleanup as fallback.

## Local development and deployment

Apply migrations before starting updated workers/web processes:

```sh
pnpm db:migrate
docker compose --profile native up --build -d pdf-compiler pdf-local-worker
pnpm test:pdf
pnpm test:pdf:isolation
```

Native workers use `http://127.0.0.1:8088`; `PDF_COMPILER_URL` can select another trusted deployment endpoint. Container workers use `http://pdf-compiler:8080`. Docker's internal-only network did not publish host ports in local verification, so the optional `native` profile provides a worker-side TCP bridge bound only to loopback. Production has no bridge or published compiler port.

The compiler has no application credentials or storage mount. Compose runs it as UID 10001 with a read-only root, no added capabilities, no privilege escalation, a 64 MiB temporary filesystem, 512 MiB memory, one CPU and 32 processes. It only joins the internal compiler network. Each subprocess also has CPU, file-size and descriptor limits. One compilation runs at a time; busy requests retry through the worker's existing queue. Timeout or client disconnect kills the process group. Job directories are removed on completion and before the service listens after restart.

Roll out migrations and the compiler service first, then the opt-in capability. Keep the compiler's published renderer profiles available until their workflows no longer run. CI builds and starts the hardened compiler, runs real compilation and isolation smoke tests, and tests the editor/API/worker path with synthetic fixtures.

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:pdf
pnpm test:pdf:isolation
pnpm build
pnpm test:e2e
```

Integration tests use a disposable PostgreSQL database and synthetic compiler fixtures for precise interruption points. Real compiler smoke tests cover multi-page and long-table documents, correction, unavailable packages, empty documents, limits, absolute-file access, cancellation and timeout. The isolation check inspects the running Compose service and verifies no egress, no application files/credentials, non-root execution, read-only root, disabled shell escape, output bounds and restart cleanup. Set `PDF_COMPOSE_PROJECT` if testing a named Compose project.

The live observer remains opt-in. For a controlled workflow whose selected reply attaches a PDF:

```sh
RUN_LIVE_EMAIL=1 LIVE_EMAIL_EXPECT_PDF=1 \
LIVE_EMAIL_WORKFLOW_ID=... LIVE_EMAIL_SENDER=you@your-controlled-domain.example \
pnpm test:live:email
```

This adds read-only checks that Resend retained exactly the generated PDF bytes. Confirm attachment delivery, rendering and threading in the controlled inbox separately. Repeat Failure/custom branches with no attachment and `LIVE_EMAIL_EXPECT_PDF` unset. Existing live inbound receipt and all three live-provider Outcome checks remain required; synthetic passes do not count as live-provider verification. No live sending is enabled by the test commands above.

### Local verification results — 2026-09-15

| Check                                                                                                     | Result                          |
| --------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Lint, UI policy, type checks, formatting, migration consistency                                           | Passed                          |
| Unit, contract, storage and provider-adapter tests                                                        | 101 passed                      |
| Isolated PostgreSQL integration tests                                                                     | 58 passed                       |
| Chromium browser suite, including real PDF preview/download and mobile controls                           | 20 passed                       |
| Real compiler smoke, long tables, limits, traversal rejection, serial execution, cancellation and timeout | Passed                          |
| Hardened Compose isolation and restart cleanup                                                            | Passed                          |
| Production Next.js build and production Compose configuration                                             | Passed                          |
| Live receipt, Outcome/provider and PDF email verification                                                 | Not run; opt-in was not enabled |

The local migration was applied additively. The compiler was built and tested on Linux ARM64 under Docker Desktop; CI exercises its pinned Linux AMD64 build. No real emails were sent during verification.

## PDF templates and fixed images

Add a **PDF template** block and choose its **Connected Agent** (or use the graph tool handle). Set a unique MCP tool name, description and complete LaTeX template. `<<title>>` and `<<assessment>>` create required string parameters, with editable descriptions and a displayed tool signature. Repeated markers create one parameter. Empty values are valid. Substitution runs once and inserts raw LaTeX; it does not escape values, expand workflow prompt variables, or interpret markers inside inserted values. Missing/extra parameters fail the attempt.

Upload PNG/JPEG logos or other fixed images and copy their `assets/logo.png` reference into `\includegraphics[width=2cm]{assets/logo.png}`. Include `\usepackage{graphicx}`. Safe filenames are assigned from upload names; duplicate compilation filenames and paths are rejected. Each block permits ten images, 5 MiB per image and 20 MiB total. Images must decode successfully, be single-frame, and contain at most 16 million pixels. Incoming-email assets, uploaded PDFs, custom fonts/packages and supporting TeX files are not supported.

Template blocks use `tectonic-0.15.0-bundle33-template-v2`, with a separate offline package cache warmed and tested for `graphicx`, PNG and JPEG. The original report profile and its cache remain available. The private compiler validates resource bytes, checksums, limits and filenames before writing them beneath the isolated job's `assets/` directory. All job files are removed together.

Workflow-scoped `/api/workflows/:id/resources` uploads and `/api/workflows/:id/resources/:imageId` downloads require administrator authentication; uploads also require the normal same-origin check. Uploads stage immutable bytes. Saving validates workflow ownership and checksums for every image. Publishing freezes the template, tool identity, descriptions, renderer profile and image metadata. Removing/replacing an image in the draft cannot change a published version. Maintenance retains references from all drafts and published versions, removes unreferenced uploads after seven days, and deletes workflow resources when deleting the workflow. Generated-report retention remains seven days after completion.

All PDF tools on an Agent share one ledger and a three-distinct-generation budget. Generation fingerprints include rendered source, sorted image filenames/checksums and renderer profile. Successful reuse can cross template blocks with identical generation inputs; the latest attempt carries the invoking template's attribution. A failed revision clears the Agent's current report. Existing pre-template ledger rows retain reuse and budget semantics during upgrade. Agents with template blocks appear in **Attach PDF report from**. The inspector shows the producing template; email references and `finish_task` are unchanged.

### Template verification and deployment

Local verification on 2026-09-15 passed 116 unit tests, 62 isolated-database integration tests, 21 Chromium browser tests, real PNG/JPEG compiler smoke tests, compiler isolation/restart checks, lint/UI policy, type checks and the production build. Browser tests cover uploads, authenticated downloads, save/publish/refresh, mobile Drawer focus and real Test-run email attachment previews. All provider adapter declarations use synthetic fixtures; opt-in live-provider/receipt/Outcome/email requirements above remain outstanding and are not replaced by these results.

CI stages the tested commit, then runs `scripts/deploy.sh COMMIT STAGED_DIRECTORY` on the server. Manual rollouts use the same script after CI deployment finishes or skips. A shared server lock serializes rollouts. Before replacement it saves the database dump, environment and resolved Compose configuration under `~/agent-platform-backups/`, and tags rollback images. It builds images, starts and checks both compiler profiles, applies additive migrations, and replaces web/worker. Readiness failure restores prior images while retaining additive migrations. `scripts/deployment-pdf-smoke.ts` checks public health/login and a synthetic authenticated upload → publication → compilation → protected download, verifies email preview mode, and deletes the synthetic workflow. It sends no live email. The server records a successful commit in `~/agent-platform/deployed-commit`.
