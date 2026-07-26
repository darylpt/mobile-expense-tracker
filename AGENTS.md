<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

<!-- BEGIN:delegation-rules -->
# Delegation Enforcement (HARD RULE)

The Builder MUST NOT directly edit source code files (`src/**`, `lib/**`, `components/**`, etc.) for any non-trivial change. The ONLY exceptions where Builder may edit directly:
- `specs/*.yaml`, `specs/*.md` (state files, specs)
- `CLAUDE.md`, `AGENTS.md` (config files)
- Trivially obvious one-liners (typo fixes, version bumps)

For ALL other code changes, the Builder MUST invoke `@coder` via the Task tool for implementation and `@critic` via the Task tool for review. This is the 8-step build-epic cycle per `docs/WORKFLOW-SOP-v2.md`.

VIOLATION: If Builder writes source code directly (outside the exceptions above), the output is considered non-compliant and must be reverted and redone through the proper cycle.
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
