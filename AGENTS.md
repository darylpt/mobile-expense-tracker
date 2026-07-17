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
