# Default workflow for the Expense Tracker PWA

Authoritative command list and configuration live in `package.json`,
`.github/workflows/ci.yml` and `README.md`; this file records only the unwritten
rules and the traps.

## Task execution

- Edit source directly. Dispatch one read-only review agent over the checkpoint
  diff before committing; the lead owns staging, commits and verification.
- Do not report done from a worker's summary. Re-run the affected check.

## Quality gates (hard rules)

### Documentation completeness

Every feature, story or non-trivial change updates documentation:

- **New feature/epic** → `specs/<feature-name>.md` with purpose, data model, key decisions, file map
- **Existing feature change** → the relevant spec, `project-spec.md`, and the `specs/README.md` index
- **Acceptance criteria** must describe what was actually built
- **Decision records** → the feature spec's "Key Decisions" section

### Version bumping

Every commit touching `src/` or `specs/` bumps the app version. Use
`npm run version:bump`; never hand-edit one version file. `npm run check:version`
fails when the files disagree and CI runs it.

### Verification

- `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` before
  reporting; all four also run in CI.
- Browser journeys: `npx playwright test` against the dev server, or
  `npm run test:e2e:prod` for the static export. The export suite is the closer
  match for what deploys.
- Mobile bottom-navigation journeys belong on the export: under `next dev` the
  overlay (`nextjs-portal`) intercepts pointer events on the bottom bar.
- Isolated data only. Use a synthetic fixture, never the real ledger.

## Integration flow

- `main` advances only through a pull request, and merging a PR to `main`
  deploys production (Vercel). Treat a merge as a release decision, not a
  bookkeeping one.
- CI runs the workflow file from the PR's **head** branch, so a workflow fix
  must reach the branch under test, not just `main`.
- Base-branch retargets count as `edited`; CI is configured to run on them.
- Long-lived branches diverge from `main` (earlier work lands as merged PRs).
  Before assuming prior work is on `main`, check `git log origin/main --oneline`
  and `git cherry origin/main HEAD`; a stale branch can conflict in tens of
  files, including sync internals.
- Stacked PRs: merge in dependency order, then retarget the next one to `main`.
- Production is SSO-gated, so an anonymous request cannot confirm the deployed
  surface. Build `out/` and serve it locally (`node e2e/serve-static.mjs`) to
  verify routing and rendering.
- Export a backup before deploying a change that touches storage or sync:
  Settings → Data Tools → Export All (all 13 stores at DB v15). Keep the file
  until the deployed build has been exercised.

## Sandbox runs

- Authenticated checks need a non-production Supabase project with no real
  records, plus a human able to delete test users in the dashboard. Anonymous
  sign-ins are a per-run switch: enable for the run, disable afterwards.
- Assume a lost browser context loses the session. Note the created user IDs
  before running so cleanup is possible without the session.
- Cross-user checks prove isolation only for the records actually exercised;
  state the coverage (one account row is not transactions and stocks).
