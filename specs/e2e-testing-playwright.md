# Spec: E2E Testing with Playwright

**For:** Architect agent → delegate to Coder / Critic
**Status:** Implemented; coverage lives in [`e2e/`](../e2e/), with browser and viewport projects in [`playwright.config.ts`](../playwright.config.ts) and the static-export filter run in [`playwright.prod.config.ts`](../playwright.prod.config.ts).
**Scope:** Add Playwright for end-to-end coverage of cross-screen, stateful flows that Jest unit tests don't catch. This is additive — existing Jest unit tests stay as-is for pure functions/component logic. Playwright is not a replacement for Jest, it covers a different failure class (integration across IndexedDB write → context refresh → render).

---

## 1. Why this spec exists

Jest catches bugs in isolated functions (`computeAccountBalances`, validation logic). It does not catch bugs in the actual user-facing flow — e.g. adding a transaction via Quick Add and the Summary cards not updating, or deleting a category that's still referenced by a transaction and the block not actually firing. These are real bugs that have already surfaced (see the dashboard screenshot showing Income/Expenses/Net — confirming these stay correct after a write is exactly the kind of thing E2E should guard).

**Principle:** Playwright tests are reserved for the 1-2 most important interactions per screen — not blanket coverage. E2E tests are slower and more brittle than unit tests; over-applying them creates maintenance burden without proportional value.

---

## 2. Test scope (prioritized)

### 2.1 Quick Add → Summary sync (highest priority)
- Add an income transaction via Quick Add, assert the Income card amount and entry count update correctly on Summary.
- Add an expense transaction, assert the Expenses card and Accounts table's affected account row update correctly.
- Add a transfer (`type = transaction`), assert both `fromAccount` and `toAccount` rows update in the Accounts table.

### 2.2 Settings delete-blocked-if-in-use (high priority)
- Attempt to delete an account referenced by an existing transaction, assert the warning appears and the account is not actually removed.
- Attempt to delete a category referenced by an existing transaction, assert the same blocking behavior.
- Delete an account/category with no references, assert it succeeds.

### 2.3 Payout calculator (medium priority)
- Enter a total amount and per-person splits that don't sum to 100%/total, assert the amber warning appears.
- Correct the splits to sum correctly, assert the warning clears and the computed output table shows correct per-person amounts.
- Save, assert the Payout record persists (reload, confirm it's still retrievable — exact assertion depends on whether Payout has a history/list view; if not, this may just confirm the IndexedDB write succeeded via a direct DB check rather than a UI re-check).

### 2.4 Responsive layout regression check (tie-in to responsive-layout-pass.md)
- Run the Quick Add → Summary sync test (§2.1) at three viewport widths: 375px (mobile), 768px (tablet), 1280px (desktop). This doubles as the "mobile layout must not regress" check called for in the layout spec's Critic review section — instead of a separate manual check, it becomes an automated, repeatable one.

### 2.5 Budget target persistence (tie-in to budget-target-persistence.md)
- Set a budget target via the Summary inline editor, reload the page, assert the value is still shown. This is the exact acceptance criterion from that spec's §4 — write this test first if that spec's task is picked up after this one lands (test-first for this specific pure-acceptance-check makes sense per the earlier TDD discussion).
### 2.6 Transaction filter persistence (implemented)
- Select a type filter in the UI and verify the URL and localStorage mirror.
- Navigate Settings → Transactions and confirm the selected controls restore.
- Verify direct-URL clearing, removing the last search pill, and tab return with view-only parameters excluded; Jest covers explicit URL precedence against a saved mirror.


---

## 3. What NOT to cover with Playwright

- Don't write Playwright tests for individual form field validation (e.g. "amount field rejects negative numbers") — that belongs in Jest/component tests, it doesn't need a real browser.
- Don't write a Playwright test per CRUD operation on Settings beyond the delete-blocked case above — basic add/edit are low-risk, well-covered by existing manual use, and adding exhaustive E2E coverage here is the over-coverage this spec explicitly wants to avoid.
- Don't test visual styling/pixel-level layout with Playwright — viewport-width behavioral checks (§2.4) are in scope, but "does this look right" is a visual review, not an automated assertion.

---

## 4. Setup

- Add `@playwright/test` as a dev dependency.
- Tests run against a real browser context (IndexedDB cannot run in Node/jsdom the way Jest does). `npm run test:e2e` uses `next dev`; `npm run test:e2e:prod` builds the static export, serves `out/` with `e2e/serve-static.mjs`, and runs the filter suite in Chromium via `playwright.prod.config.ts`.
- Suggested location: `e2e/` at project root, separate from `__tests__`/Jest tests, so the two test runners don't get confused by each other's config.
- Add a script (`npm run test:e2e`) distinct from the existing Jest script.

---

## 5. File/task breakdown for delegation

1. Playwright setup + config (browser projects, base URL, IndexedDB-aware test fixtures if needed for seeding/clearing state between tests).
2. §2.1 Quick Add → Summary sync tests.
3. §2.2 Settings delete-blocked tests.
4. §2.3 Payout calculator tests.
5. §2.4 Viewport-width variants of the §2.1 test (reuse, don't duplicate — parameterize the existing test across the three widths rather than writing three separate test files).
6. §2.5 Budget target persistence test — only relevant once that spec is implemented; can be added as part of that task instead of this one if sequencing makes more sense that way.
7. Transaction filter persistence suite — UI selection, tab return, direct-URL clearing, and last-pill removal against `next dev` and the static export.


Critic review focus:
- Tests should clear/reset IndexedDB state between runs (via a fixture or `beforeEach`) so tests don't depend on execution order or leak state into each other.
- Confirm tests actually fail when the bug they're meant to catch is reintroduced (e.g. temporarily break the context refresh, confirm the Quick Add → Summary sync test fails) — a test that can't fail is worthless.

---

## 6. Open question for the user

Should Playwright run in the existing CI pipeline, which currently validates lint, TypeScript, Jest, and build but does not install browsers, or remain a local pre-release gate? The transaction-filter static-export suite is now available through `npm run test:e2e:prod`.
