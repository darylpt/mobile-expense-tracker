# Spec: Responsive Desktop Layout Pass

**For:** Architect agent → delegate to Coder / Critic
**Status:** Phase 1 functional spec is complete (all 9 tasks ✓). This is the deferred "task 7" responsive pass, now being scoped since all screens exist.
**Scope:** Layout/CSS only. No data model, schema, or business-logic changes. Touches container widths, grid breakpoints, and component arrangement on the four existing routes: `/` (Summary), `/available-balance`, `/payout`, `/settings`.

---

## 1. Why this spec exists

The app was built mobile-first (correctly — Quick Add/logging is the core day-to-day use case, done on a phone). On desktop, every screen currently renders as a single narrow column centered in the viewport, leaving large empty margins on either side. This is expected/intentional at this stage, not a bug — but now that all Phase 1 screens exist, it's worth one consolidated pass instead of styling each screen ad hoc.

**Principle:** mobile layout is the source of truth and must not regress. Desktop gets *additional* `md:`/`lg:` Tailwind classes layered on top — nothing about the mobile experience changes.

---

## 2. Breakpoint strategy

Use Tailwind's existing breakpoints, no custom values needed:
- **Default (mobile, <768px):** current single-column layout, unchanged.
- **`md:` (≥768px, tablet):** light adjustments only — e.g. side-by-side form fields where they currently stack two-deep.
- **`lg:` (≥1024px, desktop):** the real target for this spec — multi-column grids, wider max-width container.

**Container:** wrap each route's top-level content in a max-width container instead of letting it implicitly cap at a narrow default. Suggested: `max-w-7xl mx-auto px-4 lg:px-8`. Apply once at the layout/page level, not per-component, so all four routes get it consistently.

---

## 3. Per-screen layout changes

### 3.1 Summary (`/`)
Current: Quick Add card → Month nav/stat cards → Accounts table → Income breakdown → Expenses breakdown, all stacked full-width.

**`lg:` target:**
- Quick Add stays full-width at the top (it's the primary action, deserves prominence — don't shrink it into a sidebar).
- Below Quick Add, switch the Month/stat block + Accounts table + Income/Expenses breakdowns from a single stack into a **two-column grid** (`lg:grid lg:grid-cols-3 lg:gap-6`):
  - Left column (2/3 width, `lg:col-span-2`): Accounts table (it's the widest table, give it room).
  - Right column (1/3 width): Month nav + Income/Net/Expenses stat cards stacked, followed by Income breakdown and Expenses breakdown tables stacked beneath.
- Reasoning: Accounts table has 5 numeric columns (Starting/Inflow/Outflow/Ending/+name) and is the thing most likely to feel cramped at narrow widths; the stat cards and category breakdowns are narrower content that tolerate a tighter column fine.

### 3.2 Available Balance (`/available-balance`)
Current: Date Check control → reconciliation table → cash denomination input, stacked.

**`lg:` target:**
- Date Check control stays full-width at top, small (it's a single input, doesn't need grid treatment).
- Reconciliation table and Cash Denomination input become a **two-column grid** (`lg:grid lg:grid-cols-2 lg:gap-6`), side by side, since they're conceptually paired (denomination input directly feeds the Cash row's "Current" value) and roughly similar in height/width.

### 3.3 Payout (`/payout`)
Current: Total amount + split mode toggle → per-person rows → Savings sub-split → output table, stacked.

**`lg:` target:**
- Inputs (total amount, split mode, person rows, Savings sub-split) on the **left** (`lg:col-span-1` of a `lg:grid lg:grid-cols-2 lg:gap-6` or similar — adjust ratio if person rows feel cramped, this screen is lower-traffic so don't over-invest in getting the ratio perfect).
- Output table (computed per-person amounts) on the **right**, so the user can see results update live next to the inputs instead of scrolling down — this is the single highest-value change on this screen, since it turns Payout into a live calculator rather than a fill-then-scroll form.

### 3.4 Settings (`/settings`)
Current: Accounts section → Categories section, stacked.

**`lg:` target:**
- Accounts and Categories become a **two-column grid** (`lg:grid lg:grid-cols-2 lg:gap-6`), side by side — they're independent CRUD tables with no relationship to each other, so there's no ordering/priority concern, just space efficiency.

---

## 4. What NOT to change

- No new components. This is `className` changes on existing layout wrappers only.
- No changes to mobile breakpoint behavior — every change above is additive via `md:`/`lg:` prefixes.
- No changes to the bottom nav / tab structure (Summary/Balances/Payout/Settings) unless Coder finds the current nav genuinely breaks at desktop width (unlikely, but flag if so rather than silently changing nav structure).
- Don't reflow the Quick Add form's internal field grid (Amount/Date, Type/Category, From Account/Description) — it's already a sensible 2-column pairing per the screenshot; leave it as-is at all breakpoints.

---

## 5. File/task breakdown for delegation

Single Coder task, since this is purely CSS/layout and touches a known, bounded set of files:

1. Add shared max-width container at the layout level (likely `app/layout.tsx` or a shared page wrapper).
2. Apply the per-screen grid changes above to the four route components.
3. Manually verify (or screenshot-diff if tooling allows) at 375px (mobile, must be unchanged), 768px (tablet), and 1280px+ (desktop) for all four routes.

Critic review focus:
- Confirm mobile layout is pixel-identical to before the change (regression check is the priority here, more than the desktop result itself).
- Confirm no horizontal scroll/overflow introduced on any breakpoint, especially the Accounts table (5 numeric columns) at `md:` width where it's in a tighter column than before.
- Run the accessibility skill's checklist against any reordered/regrouped sections — confirm focus order still makes sense given the new visual grid (e.g. Payout's left-input/right-output split should still tab in a sensible order, not jump right-then-left).

---

## 6. Open question for the user

The Summary screen's 2/3-1/3 column split (§3.1) and Payout's input/output split (§3.3) are my best guess at priority, not measured. If either feels wrong once built — e.g. Income/Expense breakdowns deserve more width than the Accounts table — that's a quick ratio adjustment, not a rebuild. Flag during review rather than treating the column proportions as fixed.
