# OMP development procedure

Status: adopted replacement for the legacy OpenCode coder/critic workflow. This existing file is the authoritative procedure; the unavailable older SOP is not a prerequisite and is not claimed to have been recovered.

## Host and routing

Use OMP's native `task` facility. Start from Household Assistant for cross-repository requests, or run `omp` in this repository for local work. This repository's [`.omp/config.yml`](.omp/config.yml) makes direct launches use the same model allocation.

| Responsibility | OMP dispatch | Model route |
| --- | --- | --- |
| Orchestrator | Main session | Luna through ChatGPT-backed `openai-codex` |
| Coder | Default task agent; omit `agent` | DeepSeek V4.1 Flash through OpenCode Go (high effort) |
| Critic | `agent: "reviewer"` inside a `tasks[]` item | Luna through ChatGPT-backed `openai-codex`, in an independent review context |
| Discovery | `agent: "scout"` | DeepSeek V4.1 Flash through OpenCode Go |
| Commit-message and tiny workloads | `commit`, `tiny` | DeepSeek V4.1 Flash through OpenCode Go |
| Advisor selection, disabled by default | `advisor` | Sol through ChatGPT-backed `openai-codex`; passive advising remains off |

The role names coder and critic describe responsibilities, not agent aliases to install. Do not invoke the legacy `@coder` or `@critic`. Omit per-call `model`; native agent overrides resolve it. Project-local model roles take precedence over the global map. A session-only override is not persistent; saving a global role does not override this repository's project-local setting. Project configuration does not switch an already-running or resumed conversation's model; use `omp --model openai-codex/gpt-6-luna:high` for an explicit new high-effort ChatGPT-backed lead. The default, task and slow selectors request high effort; other role selectors have no effort override. Vision, memory, widget and model-kind services remain automatic, and the Sol consultation gate remains in force.

For direct launches in this repository, [the local default task definition](.omp/agents/task.md) limits the coder's built-in tools to file operations and language-server queries, with no shell, Eval or child delegation. Luna owns command execution and integrated checks. This is not a filesystem sandbox; inherited MCP tools remain governed by their host configuration. The built-in tool restriction is project-scoped; when coordinating from Household Assistant, carry the same coder scope in the brief and verify actual actions rather than assuming sibling agent definitions were loaded.


Sol remains an on-demand read-only planner or consultant through Household Assistant. It is not required for routine changes, code review or progress updates. Do not automatically start another feature after completing the requested one.

## Native task dispatch

Invoke OMP's native task tool through Eval's supported session-tool bridge. Earlier direct structured `task` calls with Go-backed Luna filled absent optional fields with `model: ""` or `model: []`; OMP rejected those as forbidden per-call overrides. Retain the bridge to preserve absent fields without changing model permissions. Keep `task.perCallModel: off`; do not enable overrides or suppress dispatch errors.

Example read-only dispatch in a JavaScript Eval cell:

```js
print(await tool.task({
  i: "Checking implementation prerequisites",
  context: "Read-only procedure check. No edits, commands, runtime data or child agents.",
  tasks: [{
    task: "Read DEVELOPMENT_SOP.md and report the applicable implementation and review gates.",
    solutionSpace: "The repository procedure determines the required gates."
  }]
}));
```

For the critic, use the same bridge with `agent: "reviewer"` inside its task item. For the coder, omit `agent`. Omit `model` and `sourceSession` entirely; empty strings, empty arrays and nulls are not substitutes for omission. Wait for each returned result before proceeding. If Eval or native task dispatch is unavailable, stop before source work and report the capability failure.


## Eight-step source-change procedure

1. **Orient and scope.** Read [AGENTS.md](AGENTS.md), [project state](specs/state.yaml), the [specs index](specs/README.md) and the relevant feature contract. Name expected behavior, writable paths, non-goals and acceptance criteria. Existing user changes remain outside the task. Completion means a scoped task with the current phase identified, not permission to expand the backlog.
2. **Resolve prerequisites.** Source implementation requires the recorded `build` phase. In earlier phases, perform only the requested discovery, elaboration or planning work. Before Next.js code, read the relevant installed guide under `node_modules/next/dist/docs/`. Integration/API work must additionally clear the [expense integration skill](.agents/skills/expense-integration/SKILL.md). Missing release evidence or approval remains a stop condition; this workflow repair does not clear those gates.
3. **Brief the coder.** Through the native Eval-to-task bridge above, give the default OMP task agent a standalone brief with relevant instructions, writable files, interfaces, acceptance criteria and verification requirements. Supply constraints explicitly; do not assume it inherits the lead's conversation. Keep one worker active at a time and forbid child delegation. Completion means a bounded implementation assignment, not an agent label in prose.
4. **Implement the requested behavior.** The coder changes only the assigned scope and returns affected files, rationale, risks and remaining checks. Include behavior-level regression coverage where needed; do not add tests that merely inspect source text. Keep tests, builds, lint and formatters out of mid-flight worker edits; the lead runs the integrated checks after workers settle. A worker's completion claim is not verification.
5. **Request an independent critic.** Through the same bridge, dispatch `reviewer` with the acceptance criteria, exact changed files or diff, repository rules and available evidence. Require concrete correctness, security, regression and scope findings with file references. The critic reviews read-only, does not implement fixes and does not delegate. Completion means a returned review, not a queued task.
6. **Resolve findings.** Send confirmed defects back to the coder with explicit scope, then request review of the corrected result. Luna resolves conflicts against authoritative contracts; ask the user only for material scope or product decisions. Do not silently weaken acceptance, change ledger ownership rules or mark an unresolved finding passed.
7. **Verify and document.** Once the workers settle, the lead runs the applicable integrated checks below and exercises the changed public workflow with isolated data. Complete AGENTS.md's feature documentation, acceptance and synchronized version updates whenever source or specs change. Re-review any substantive final changes not covered by the critic. Completion requires observed behavior and resolved findings, not test output alone.
8. **Commit, report and close.** After a completed feature or verified logical checkpoint, the lead makes the scoped local commit under the policy below. Report changed files, critic outcome, commands actually run, observed user behavior, commit SHA/subject and exact blockers. Update phase/story state only for work whose criteria actually passed; do not fabricate metrics or automatically select another feature. Pushing, merging, publishing and deployment still need separate authorization.

For documentation and agent-configuration-only tasks, direct edits are allowed by AGENTS.md. Verify links, native configuration consumption and changed agent behavior instead of claiming application behavior changed. A version bump is required when source or `specs/` changes, not merely because this SOP or OMP configuration changes.

## Application verification gates

For application source changes, run the existing commands from this repository:

- `npm run lint`
- `npx tsc --noEmit`
- `npm test -- --runInBand`
- `npm run build`

Use the relevant existing browser suite, `npm run test:e2e` or `npm run test:e2e:prod`, when required by the affected contract. Exercise the actual UI or public operation with isolated users and records; check cross-user isolation when identity, persistence, backup or sync changes. A real ledger is never a fixture. Record failures as observed and diagnose them rather than rerunning a failing check merely to confirm it.

## Local commits

The user authorizes local commits for future completed features, fixes and independently verified checkpoints. Commit one coherent behavior after review, application verification and required documentation, before starting the next independent behavior. Plan large work as working logical checkpoints, not arbitrary file-count or line-count batches; keep inseparable changes atomic. This does not authorize bundling earlier work or rewriting existing large commits.

Luna owns staging and committing; the file-only coder and critic do not. Inspect the working tree and index, stage only explicit task-owned paths or hunks and check the staged patch. If unrelated staged work or ambiguous mixed edits prevent a safe commit, preserve them and report the blocker. Honor hooks and signing; no blanket staging, hook bypass, history rewrite or automatic push. Apply AGENTS.md's synchronized version bump to every source/spec checkpoint commit. Report each commit's SHA and subject.

For requests coordinated across repositories, follow the shared [commit and checkpoint policy](../../household-assistant/docs/agent-workflow-decision.md#local-commits-and-checkpoints); each repository has its own commit and verification evidence. The present policy-setting task does not commit existing work.


## Usage and activation checks

The first implementation trial is one scoped task, not an unattended feature loop. Record actual model/provider metadata and, when available, provider-reported allowance before and after it. OMP price estimates do not prove subscription quota consumption.

Use `omp config get modelRoles --json` and `omp config get task.agentModelOverrides --json` to inspect effective routing. Inventory entries alone do not prove authenticated access; verify with a read-only task and inspect its resolved model metadata. Automatic advisors, plan startup, prewalk handoffs, completion probes and model fallback are disabled locally. If a model is unavailable, report it instead of silently changing billing paths or skipping review.

Verification evidence, 2026-11-06: a fresh OMP run from this repository used Go-backed Luna, dispatched a read-only default coder on `opencode-go/deepseek-v4.1-flash`, then an independent `reviewer` on `opencode-go/gpt-6-luna`. Session metadata confirmed both routes. The critic found no lost documentation, versioning or integration gates. Direct structured dispatch failed before either child launched; the native Eval-to-task bridge passed without relaxing per-call permissions. Application behavior, source changes and the application check suite were not exercised by this workflow-only smoke.

Final smoke and critic disposition: the file-only local coder and separate Luna critic completed the documented handoff with no command or mutation calls. The final critic retained all required gates. Its prerequisite-path concern was checked: all six sibling contract paths resolve from the Expense Tracker root; the integration skill now states that base explicitly. The skill also defers to this SOP's prescribed application-check commands rather than maintaining a second command list.

The critic separately noted pre-existing state metadata drift: `specs/state.yaml` still points at `ui-accessibility-onboarding`, while the specs index marks it and `summary-accounts-mobile` complete and `last_action` refers to the latter. This workflow-only task leaves story state and version fields unchanged. Use the explicit user task as scope, and reconcile the story pointer against approved work before recording a later feature completion; do not infer a new feature or claim that state metrics are fresh verification.