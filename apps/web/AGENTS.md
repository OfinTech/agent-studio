<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Frontend UI policy

Follow the root `AGENTS.md` Mantine policy. Use Mantine components as provided; compose components and documented props first. Customize only for functional requirements, accessibility, or a demonstrated integration limitation, never personal visual preference.

Keep the Mantine provider forced to the dark color scheme, with system typography, colors, and component sizes. Use `md` layout spacing, filled primary buttons, default secondary buttons, and Mantine red for destructive actions. Documented component patterns may use other built-in tokens. Do not introduce custom themes, general-purpose wrappers, custom fonts, competing UI libraries, utility CSS, copied internals, or patches.

The shell uses a 60px header, 240px navigation collapsed below `sm`, and a full-width canvas when no step is selected. Selection opens a 3:1 canvas/settings layout above `md` and a Mantine Drawer below it. The editor fills the remaining dynamic viewport height below the header, notices, and toolbar. The canvas and independently scrolling desktop settings panel share that available height; do not restore fixed pixel heights. Keep the workflow draft authoritative, preserve measured dimensions and workflow-specific canvas state, and use `@mantine/form` for login and dialogs.

Only `components/workflow-canvas.module.css` contains application CSS, limited to registered graph geometry and state/connection differentiation using Mantine colors. Styling escape hatches require exact exceptions in `scripts/ui-policy/exceptions.json`, including the functional reason and why documented Mantine usage is insufficient. Review exception changes as part of the normal PR; they do not require an extra approval workflow. Do not suppress UI-policy lint rules.

Use accessible roles, labels, or explicit test IDs in browser tests. React Flow selectors are allowed for graph interaction. Verify dialogs/drawers with keyboard focus, Escape dismissal, and focus restoration, plus mobile layout and node visibility after save, publish, run inspection, and refresh.

Use concise, factual copy. Show editor controls contextually; keep helper text only when it affects a configuration decision. Avoid tutorial, promotional, reassurance, and repeated-state copy. Use brief status messages for successful actions and preserve actionable errors. Workflow naming is applied to the draft in Workflow settings; saving remains explicit. Keep route navigation and workflow-specific drafts in the persistent authenticated layout.
