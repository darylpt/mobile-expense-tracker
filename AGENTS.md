<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:delegation-rules -->
# OMP Delegation and Review (HARD RULE)

Before source work, read [DEVELOPMENT_SOP.md](DEVELOPMENT_SOP.md), the authoritative OMP build procedure. It replaces the unavailable legacy OpenCode SOP; do not reconstruct or claim to follow that old procedure.

For non-trivial application source changes (`src/**`, `lib/**`, `components/**`, server code or migrations), the orchestrator delegates implementation through OMP's default `task` agent and independent review through `reviewer`. Use the SOP's [native Eval-to-task dispatch](DEVELOPMENT_SOP.md#native-task-dispatch) for Go-backed Luna; direct structured calls currently fill absent optional fields incorrectly. Native model routing is in [`.omp/config.yml`](.omp/config.yml).

The orchestrator may directly edit specs, documentation and agent configuration, and make trivially obvious source one-liners such as typo fixes or version bumps. These exceptions do not waive the documentation, versioning or verification rules below.

If required OMP delegation or review is unavailable, stop before non-trivial source edits and report the missing capability. Missing review leaves the task incomplete; do not reset or discard unrelated user work.
<!-- END:delegation-rules -->

<!-- BEGIN:documentation-rules -->
# Documentation Completeness (HARD RULE)

Every feature, story, or non-trivial change MUST include or update documentation. No code-only commits.

Requirements:
- **New feature / epic** → create a spec file at `specs/<feature-name>.md` covering: purpose, data model, key decisions, file map
- **Existing feature change** → update the relevant spec, the `project-spec.md` unified doc, and the specs index
- **Acceptance criteria** in the spec must match what was actually built — update when implementation diverges
- **`specs/README.md` index** must be kept in sync (add new entries, mark status, update stale notes)
- **`specs/project-spec.md`** must reflect current reality (DB version, test counts, store list, schema)
- **Decision records**: significant architectural choices (API changes, data model changes, migration strategies) should be documented either in the feature spec's "Key Decisions" section or in `specs/adr/`

VIOLATION: A commit that adds or modifies a feature without a matching documentation update is non-compliant and must be amended before closing.
<!-- END:documentation-rules -->

<!-- BEGIN:versioning-rules -->
# Version Bumping (HARD RULE)

Every commit that changes source code (`src/**`, `lib/**`, `components/**`, etc.) or `specs/` MUST include a version bump. No exceptions.

Files to keep in sync:
- `package.json` — `version` field
- `src/lib/version.ts` — `APP_VERSION` constant
- `specs/state.yaml` — `version` field

Bump rules:
- **Bug fix** → patch (`0.x.Y` → `0.x.Y+1`)
- **New feature / story complete** → minor (`0.X.y` → `0.X+1.0`)
- **Breaking change** → major (`X.y.z` → `X+1.0.0`)

VIOLATION: Any commit touching source or specs without a matching version bump in all three files is non-compliant and must be amended.
<!-- END:versioning-rules -->

## Local feature commits

After a future feature or fix passes its gates, the lead makes the task-owned local commit under [the SOP's local commit policy](DEVELOPMENT_SOP.md#local-commits). Large changes use verified logical checkpoints. Preserve unrelated work, apply the version rules above to every source/spec commit, and keep remote operations separately authorized.


## UI / Frontend Task Execution Pipeline

When executing `/poteto-mode` for UI tasks:

1. **Pass 1 (UX Architecture):** 
   - Skill: `ui-ux-pro-max-skill`
   - Focus: Component layout, state handling, copywriting, WCAG compliance.

2. **Pass 2 (Aesthetic & Visual Identity):** 
   - Skill: `frontend-design`
   - Focus: Color palette, typography scale, visual hierarchy. 
   - Guardrails: No generic purple gradients, no tracked-out ALL-CAPS headers, no generic card overload.

3. **Pass 3 (Senior Engineering & Verification):** 
   - Skill: `senior-frontend`
   - Focus: Production-grade React, TypeScript, Tailwind CSS, clean modular structure, zero console logs.
   - Verification: Run linting/type-check steps before final delivery.
