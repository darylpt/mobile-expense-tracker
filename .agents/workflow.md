# Expense Tracker agent workflow

Before source work, follow [the OMP development procedure](../DEVELOPMENT_SOP.md). It is authoritative for lifecycle gates, native coder/critic dispatch, verification and closure. This file is an entry point, not a second build procedure.

- [AGENTS.md](../AGENTS.md) owns the source-delegation exceptions, feature documentation, synchronized versioning and frontend requirements.
- [Project state](../specs/state.yaml) records the current phase and story; recorded metrics are not a fresh test run.
- [The specs index](../specs/README.md) routes feature-specific contracts.
- For Household Assistant expense integration or API work, read [the integration skill](skills/expense-integration/SKILL.md) before source changes. Its standalone-release and approved-contract gates remain in force.
- [Native OMP configuration](../.omp/config.yml) routes the coder to DeepSeek and the independent critic to Luna, both through OpenCode Go. Follow the SOP's [Eval-to-task dispatch](../DEVELOPMENT_SOP.md#native-task-dispatch) so Go-backed Luna preserves absent optional task fields.

Use [README.md](../README.md) and the owning feature specs for current architecture and commands. Legacy OpenCode files do not define the OMP implementation procedure.
