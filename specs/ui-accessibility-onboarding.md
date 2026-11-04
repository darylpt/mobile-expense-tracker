# Spec: UI Accessibility & Empty-State Onboarding

**Status:** ✅ Done
**Version:** 0.19.0

---

## Purpose

Close the accessibility and onboarding findings from the prior UI/UX review of the Expense Tracker PWA. The review reported four user-facing problems:

1. On mobile, the collapsed Quick Add panel stayed in the keyboard and assistive-technology navigation order.
2. Empty states told users to import data and labelled a plain `/settings` link as if it opened Import. Manual setup through Settings was not discoverable.
3. Several text colors failed WCAG AA contrast in the axe audit (version badge, inactive mobile navigation, Settings reorder hints, Transactions inactive filters/chips, and related secondary text).
4. Settings navigation used emoji as icons, which render inconsistently across platforms.

A fifth, structural finding: the Payout screen's `Output` heading was an `h3` under an `h1` page title, skipping `h2`.

The fixes preserve the existing domain data and desktop behavior. No storage schema, shared state, API, or route was added. Transaction filter persistence was extracted into a private hook; its contract is owned by [`transaction-filters.md`](transaction-filters.md).

---

## Data model

No data model changes.

- Quick Add continues to use its existing `collapsed: boolean` local state.
- Empty-state branching continues to derive from existing arrays: `transactions` (dashboard and transaction list) and `accounts` (Available Balance).
- Mobile disclosure semantics derive from `window.matchMedia('(max-width: 767px)')`; the value is read with `useSyncExternalStore`, with `false` as the server snapshot so SSR hydration matches the desktop render.
- Version fields advance from remote release `0.18.3` to `0.19.0` in `package.json`, `src/lib/version.ts`, and `specs/state.yaml`.

---

## Key decisions

| Decision | Rationale |
|---|---|
| Use `inert` on the collapsed panel | Removes the panel from keyboard tab order and the accessibility tree without unmounting the form, so the expand/collapse height animation still runs. |
| Separate mobile disclosure button from the desktop heading | `aria-expanded` is only meaningful on mobile. The desktop heading keeps the previous always-expanded behavior and never announces a false collapsed state. |
| Focus the disclosure after successful submit | Collapsing immediately after submit would otherwise strand focus inside an inert subtree. |
| Name mobile toggle and submit differently while open | Collapsed state exposes only `Add Transaction` (the disclosure). Expanded state shows `Quick Add` (disclosure) and `Add Transaction` (submit), removing the duplicate accessible name. |
| One `Open Settings` CTA on empty states | The CTA points at `/settings`, which is a hub, not an import route. Copy names the exact path (`Settings` → `Data Tools` (`Import / Export Data` on mobile) → `Import from Google Sheets`) without claiming the link opens Import. |
| Inline decorative SVGs for Settings navigation | Native SVG avoids new dependencies, keeps the Zinc/blue palette, and renders consistently. Labels continue to carry the meaning; icons are `aria-hidden`. |
| Raise secondary text to `zinc-600` / `dark:zinc-400` | Meets WCAG AA (4.5:1) for normal text on the surfaces used: white, `zinc-50`, `zinc-100`, `zinc-800`, `zinc-900`, and `zinc-950`. The palette stays Zinc. |

### Contrast targets

| Surface | Before | After |
|---|---|---|
| Header version badge | `zinc-400` on `zinc-100`, `dark:zinc-500` on `zinc-800` | `zinc-600` / `dark:zinc-400` |
| Inactive mobile bottom-nav label | `zinc-400` on white, `dark:zinc-500` on `zinc-900` | `zinc-600` / `dark:zinc-400` |
| Settings reorder hint | `zinc-400` on `zinc-50`, `dark:zinc-500` on `zinc-800` | `zinc-600` / `dark:zinc-400` |
| Transactions inactive type chips / group toggle / count | `zinc-500` on `zinc-100` | `zinc-600` |
| Transactions inactive "All time" toggle | `zinc-400` on white | `zinc-600` / `dark:zinc-400` |
| Stat-card sublabel | `zinc-400` on white, `dark:zinc-500` on `zinc-800` | `zinc-600` / `dark:zinc-400` |
| Available Balance timestamps and peso prefixes | `zinc-400` on white, `dark:zinc-500` | `zinc-500` / `dark:zinc-400` |
| Settings empty accounts and category messages | `zinc-500` on `zinc-800` in dark mode | `zinc-500` / `dark:zinc-400` |
| Input leading/trailing adornments (Quick Add `₱`, Settings and Payout peso prefixes, Payout `%` suffix) | Child spans hardcoded `zinc-500` / `dark:zinc-400`; shared wrapper stayed `zinc-500` with no dark token, so the Quick Add `₱` failed on `zinc-800` | Shared wrapper owns `zinc-500` / `dark:zinc-400`; child spans carry no color and inherit it |
| Stocks empty-state message | `zinc-400` on white, `dark:zinc-500` on `zinc-800` | `zinc-600` / `dark:zinc-400` |
| Payout selected split-mode control | `dark:blue-400` on `zinc-700` | `blue-700` / `dark:blue-300` |
| Payout percent suffix and warning text | `zinc-400` / `amber-700` on white | `zinc-500` (suffix inherits the Input wrapper) / `amber-800` |
| Dashboard and Transactions footer (dark) | `dark:zinc-500` on `zinc-950` | `dark:zinc-400` |

Disabled controls and placeholder text keep their existing styling. Inactive controls are exempt from WCAG text-contrast requirements; placeholder text in enabled inputs is not.

---

## Behavior contract

### Quick Add disclosure (mobile, `<768px`)

- Closed: the disclosure is the only Quick Add control in the tab order. It has `aria-expanded="false"` and `aria-controls="quick-add-panel"`. The panel has the `inert` attribute and its fields reject focus.
- Open: `aria-expanded="true"`, `inert` is removed, and the fields and submit button are usable.
- Submit success: the panel collapses, `aria-expanded` returns to `false`, and focus moves to the disclosure.
- Desktop (`>=768px`): no disclosure button and no collapse. A static `+ Add Transaction` heading is shown and the form stays expanded, matching the previous desktop view.
- The mobile height transition is unchanged.

### Empty states

Dashboard, Transactions, and Available Balance each show `No data yet`, setup guidance for the screen's actual prerequisite, and one `Open Settings` link to `/settings`.

- Dashboard: add accounts and categories in Settings, then use Quick Add; import path is `Settings` → `Data Tools` (labelled `Import / Export Data` on mobile) → `Import from Google Sheets`.
- Transactions: add accounts and categories in Settings, then use Add; same import path.
- Available Balance: add at least one account in Settings; same import path.

No empty-state link is labelled as a direct Import destination.

### Settings navigation

The desktop sidebar and mobile hub use the same six inline decorative SVG icons: credit card (Accounts), tag (Categories), trending up (Stocks), cloud (Preferences & Sync), circle stack (Data Tools), lock (App Lock). No emoji remain in Settings navigation.

### Headings

Payout `Output` is `h2`, matching the `h1` page title and removing the skipped level.

---

## Acceptance criteria

1. At mobile width, a closed Quick Add exposes only its disclosure control. Its fields cannot receive keyboard focus, and `aria-expanded` tracks the panel state. Opening restores usable controls; successful submit collapses the panel and moves focus to the disclosure.
2. Every no-data screen gives accurate, actionable manual setup guidance. The Settings link is labelled `Open Settings` and does not claim to open Import directly. Import guidance still names the in-app path.
3. The color-contrast failures from the review no longer appear in axe on `/`, `/transactions`, `/available-balance`, `/settings`, `/payout`, and `/stocks`, in light and dark mode. This includes the Settings empty-accounts and no-categories messages, Input-owned leading/trailing adornments in Quick Add, Settings, and Payout (peso prefixes and the percent suffix), the Stocks empty-state message in both themes, and the selected Payout split-mode control and warning text.
4. Settings navigation renders with consistent SVG icons and no emoji glyphs.
5. Payout heading order has no skipped level.
6. Documentation and `package.json`, `src/lib/version.ts`, and `specs/state.yaml` all agree on version `0.19.0`.

---

## File map

| File | Change |
|---|---|
| `src/components/forms/QuickAddForm.tsx` | Mobile disclosure button, `aria-controls`, `inert` panel, focus return after submit, static desktop heading |
| `src/components/summary/MonthlySummaryCard.tsx` | Empty-state setup guidance; stat-card sublabel contrast |
| `src/components/summary/TransactionList.tsx` | Empty-state setup guidance; inactive chips, toggles, count, meta, and description contrast |
| `src/app/available-balance/page.tsx` | Empty-state setup guidance; timestamp and peso-prefix contrast |
| `src/app/settings/page.tsx` | SVG navigation icons replacing emoji; reorder-hint and sync-timestamp contrast; dark-mode empty-accounts and no-categories messages; peso adornment spans now inherit color from `Input` |
| `src/app/payout/page.tsx` | `Output` heading `h3` → `h2`; percent suffix and warning contrast; selected split-mode contrast; peso and percent adornment spans now inherit color from `Input` |
| `src/app/stocks/page.tsx` | Loading text contrast |
| `src/components/common/Input.tsx` | Shared `leading`/`trailing` wrappers own `text-zinc-500 dark:text-zinc-400` so every adornment inherits the accessible token |
| `src/components/stocks/ManageTickers.tsx` | Light and dark-mode contrast for the `No stocks yet. Add your first ticker above.` empty-state message |
| `src/components/layout/Header.tsx` | Version badge, sync/email text, inactive mobile nav, failed-sync badge contrast |
| `src/components/summary/CategoryBreakdown.tsx` | Dark-mode contrast for zero-amount and detail text |
| `src/app/page.tsx`, `src/app/transactions/page.tsx` | Footer dark-mode contrast |
| `e2e/fixtures.ts` | `seedIndexedDB` opens `/`, waits for the empty state so the app initializes the current DB version, then opens the existing database without a lower version |
| `e2e/quick-add-summary.spec.ts` | Mobile disclosure regression and empty-state guidance regressions; viewport-aware Quick Add setup; seeded-category and account option waits |
| `package.json`, `src/lib/version.ts`, `specs/state.yaml` | Version `0.19.0` |

---

## Verification

Regression coverage lives in `e2e/quick-add-summary.spec.ts`:

- `Quick Add → Summary sync`: `openDashboard` waits for the seeded `Food` category and `Cash` From Account options, proving the app loaded seeded records rather than matching a hidden `Income` option.
- `Mobile Quick Add disclosure`: asserts `aria-expanded`, `aria-controls`, `inert`, rejected programmatic focus, Tab behavior, restored focusability when opened, and focus returning to the disclosure after submit. Skips viewports at or above `768px`.
- `Empty-state onboarding guidance`: seeds empty stores, then checks `/`, `/transactions`, and `/available-balance` for `No data yet`, route-specific setup copy, the `Data Tools (Import / Export Data on mobile)` path to `Import from Google Sheets`, `Open Settings` pointing at `/settings`, and the absence of an Import-named link.

`seedIndexedDB` initializes the app at `/` and waits for `No data yet` before opening the existing database without a lower version, so the v4→v13 upgrade no longer clears seeded records. Callers keep the same signature and re-navigate to the route under test after seeding.

The parent run executes lint, TypeScript, Jest, and Playwright after integration. Dark-mode contrast for the touched surfaces is rechecked in the review pass; no axe suite is checked in.
