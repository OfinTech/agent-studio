# Repository guidance

Keep backend behavior, shared contracts, API shapes, and immutable published workflow versions stable unless the task requests a behavior change. Read `apps/web/AGENTS.md` before frontend work.

Use Mantine components as provided. Compose components and use documented props first. Change a component’s styling or implementation only when necessary for a functional requirement, accessibility, or a demonstrated integration limitation—not personal visual preference.

Mantine is the sole general-purpose UI library. Prefer direct imports and ordinary feature composition, not a parallel library of button/input wrappers. Do not vendor, patch, copy Mantine internals, add competing component libraries or utility styling frameworks, load custom fonts, or override the default theme. Use built-in tokens and documented props for layout, variants, and semantic state colors. Scope component changes to requested behavior or a verified defect; avoid incidental aesthetic rewrites.

React Flow remains the specialist graph engine. Only necessary graph geometry, handles, selection, and connection differentiation belong in its registered CSS module. Register each functional exception with its exact file/location, rule, source (or stylesheet hash), reason, and why ordinary Mantine usage is insufficient in `scripts/ui-policy/exceptions.json`. No directory exemptions or inline lint suppression. Exception changes receive normal PR review; no separate user-approval step is required.

Run `pnpm lint` (frontend ESLint policy plus repository UI-policy checks), type checks, relevant tests, and a production build. Preserve documented live-provider testing requirements; use synthetic fixtures for local verification.
