# Default Workflow for Expense Tracker PWA

## Task Execution
- **Delegate complex tasks to background sub-agents by default.** This prevents lockout and allows parallel work.
- Exceptions: quick lookups (<30s), urgent/blocking issues, or tasks needing live interactive feedback.
- When a background agent finishes, verify the work before reporting done.

## Quality Gates (HARD RULES)

### Documentation Completeness
Every feature, story, or non-trivial change **must** include or update documentation:
- **New feature/epic** → Create `specs/<feature-name>.md` with purpose, data model, key decisions, file map
- **Existing feature change** → Update the relevant spec, `project-spec.md`, and `specs/README.md` index
- **Acceptance criteria** must match what was actually built
- **`specs/project-spec.md`** — keep current (DB version, test counts, store list, schema)
- **Decision records** → Document in feature spec's "Key Decisions" section

Violation: A commit adding/modifying a feature without matching documentation updates is non-compliant.

### Version Bumping
Every commit touching `src/` or `specs/` **must** bump version in:
- `package.json`, `src/lib/version.ts`, `specs/state.yaml`
- Bug fix → patch, new feature/story → minor, breaking change → major

### Code Quality
- 0 ESLint errors, 0 TS errors before committing
- Run `npm test` before marking feature complete
- `npm run build` must pass

## Project Structure

```
expense-tracker/
├── src/                  # Next.js App Router pages + components
│   ├── app/              # Routes: /, /stocks, /transactions, /settings, etc.
│   ├── components/       # Shared UI components
│   ├── hooks/            # React hooks (useTransactions, useStocks, etc.)
│   ├── lib/              # Business logic (idb, sync, utils, holdings, etc.)
│   ├── context/          # React context providers
│   └── types/            # TypeScript interfaces
├── server/               # Portfolio API Server (Express, Hermes Agent bridge)
├── specs/                # Feature documentation (16+ spec files)
├── supabase/             # Supabase migrations
├── e2e/                  # Playwright E2E tests
└── .agents/              # Agent configuration
```

## Technology Stack
- **Framework:** Next.js 16 (App Router, all `'use client'`)
- **UI:** React 19, Tailwind CSS 4
- **Storage:** IndexedDB via `idb` v8
- **Cloud Sync:** Supabase (Postgres + Auth + REST, outbox pattern)
- **Auth:** Supabase Auth (magic link, invite-only)
- **Testing:** Jest 30 (unit) + Playwright 1.61 (E2E)
- **CI:** GitHub Actions (lint, typecheck, test, build)

## Communication
- This project is actively used since June 2026
- App is a local-first personal finance tracker with optional Supabase sync
- Currently at 109+ unit tests, all passing
