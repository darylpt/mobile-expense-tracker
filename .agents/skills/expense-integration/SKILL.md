---
name: expense-integration
description: Implementing or reviewing the planned Household Assistant expense integration in this repo, including the app-owned writer, identity, ledger authorization, idempotency receipts, and sync verification. Use for expense integration/API or operation-receipt requests.
---

# Expense integration

This integration is not implemented. The proposed contract is not approval, and the current app has no expense writer or integration route. Re-read all contracts and code on every run.

Resolve all backtick file paths in this skill from the Expense Tracker repository root, not from this skill's directory or the Household Assistant working directory. In the current workspace, `../../pantry-plan` and `../../household-assistant` are the sibling repository roots.


## Gates

Stop before source, spec, migration, or version changes at the first failed gate. Report the evidence path and missing condition.

1. **Pantry Plan release.** Read `../../pantry-plan/docs/implementation-plan.md` and `../../pantry-plan/docs/acceptance.md`. Require the standalone browser release and recorded release-acceptance evidence. Plans, milestones, or local demos do not clear the gate.
2. **Current contract approval.** After gate 1, revisit `../../household-assistant/docs/integrations.md`, `../../household-assistant/docs/security.md`, `../../household-assistant/docs/implementation-plan.md`, and `../../household-assistant/docs/acceptance.md`. Require written approval of the current target, routes, identity scope, receipt semantics, retry behavior, and allowed expense fields. Stop on missing or conflicting decisions.
3. **OMP build procedure.** Read `AGENTS.md` and the authoritative `DEVELOPMENT_SOP.md`, reached also through `.agents/workflow.md`. Resolve the native default task-agent coder and independent `reviewer` critic through `.omp/config.yml`. Record the applicable implementation and verification criteria in the feature spec. Stop if the required OMP capabilities are unavailable; the obsolete OpenCode SOP and agent aliases are not prerequisites.
4. **Runtime prerequisites.** Confirm `specs/state.yaml` permits implementation in `build`, the configured Supabase project and test ledger exist, and verification can use disposable users/data. The real-user ledger is never a test fixture.

## Procedure

1. Read the repo's `AGENTS.md`, `.agents/workflow.md`, `DEVELOPMENT_SOP.md`, `specs/state.yaml`, `README.md`, `specs/project-spec.md`, and `specs/README.md`. Read the relevant sync, auth, and data-model specs. Confirm the current schema and server/client boundaries from source.
2. Read the installed Next.js guide under `node_modules/next/dist/docs/` before changing app code. Record the guide and version-specific constraints in the feature spec.
3. Create or update the feature spec first. New integration work needs purpose, data model, decisions, file map, and acceptance criteria derived from the approved contract. Keep the index and project spec consistent.
4. Implement only the approved app-owned server interface. Never reuse the stock portfolio server as the expense writer or expose service-role credentials to a browser. Resolve the principal from the server-side credential and scope every service-role query to that `user_id`.
5. Preserve the ledger's actual expense semantics. Validate account and category ownership in the writer; write through the existing ledger model. Do not mutate budget targets or add unsupported currency, merchant, or receipt-line fields.
6. Use the current approved contract as the sole source for request fields, errors, idempotency fingerprints, receipt lookup order, replay, conflicts, and retry behavior. Keep the expense and successful receipt atomic. Do not deduplicate separate operations by matching business fields.
7. Follow `DEVELOPMENT_SOP.md`. Non-trivial source changes use OMP's default task agent for implementation and a separate `reviewer` for the read-only critic. Omit per-call model overrides; `.omp/config.yml` routes the coder to DeepSeek and the critic to Luna through Go. Update the feature spec, `specs/README.md`, and `specs/project-spec.md`. When source or specs change, bump `package.json`, `src/lib/version.ts`, and `specs/state.yaml` together; a patch-only version script is not sufficient for a new feature.
8. Run the application verification gates in `DEVELOPMENT_SOP.md` using its prescribed commands. Add the applicable existing browser suite when the changed UI/sync contract requires it. Do not report completion on test output alone.

## Verify the real integration

Use disposable test ledgers and exercise the running writer over HTTP. Prove the current contract's identity and cross-user isolation, expense validation, atomic receipt, replay/conflict and operation lookup behavior. Observe persisted expense and receipt records. For device visibility, sync a separate PWA client and report cloud commit separately from what that client displayed. Never run write scenarios against a real ledger.

**Done when:** the approved behavior works through the public writer, each required acceptance case has observed evidence, the repository's build and documentation gates pass, and the report does not claim visibility before an observed sync.

## Boundaries

- Stop when a gate fails; do not add placeholder routes or a temporary browser writer.
- Work only in the Expense Tracker repository. Bot credentials, confirmation, and recovery belong to Household Assistant.
- If code or the approved contract disagrees with this skill, trust the current source-of-truth documents and update the skill only in a separate authorized task.
