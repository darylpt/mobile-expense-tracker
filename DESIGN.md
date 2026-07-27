# Expense Tracker — Design Decisions

## Visual Design
- **Colors:** Zinc/gray base with blue-600 primary actions (dark mode variant: blue-400)
- **Layout:** Max-width `max-w-7xl` centered, responsive breakpoints: `<768px` (mobile single-column), `768px+` (tablet), `1024px+` (desktop multi-column)
- **Cards:** Rounded-xl with subtle shadow, `border-zinc-200` on light, `border-zinc-700` on dark
- **Tables:** Clean header rows with uppercase muted labels, tabular-nums for financial data
- **Mobile:** Fixed bottom tab bar (z-20, safe-area-inset-bottom), card-style layouts, collapsible forms

## UX Decisions
- **Quick Add sticky defaults:** Type/category/account/description persist after submit — only amount clears. Reduces taps for recurring entries.
- **Quick Add collapsed on mobile:** Taps to expand, auto-collapses on submit. Desktop always shows expanded.
- **Sub-split toggle (layers icon):** Available on every account in Available Balance. Shows computed total from label+amount rows. Icon turns blue when active.
- **Copy Summary button:** One-click portfolio text copy for AI assistant handoff. No server needed.
- **Settings mobile card layout:** Accounts & Categories switch from tables to stacked cards on mobile.

## Data Model Decisions
- **Net dividend calculation:** `qty × rate − fee` instead of gross. Matches brokerage statements. Legacy records keep old `amount` field.
- **Stocks vs. Funds:** `type` field separates PSE-listed stocks (Phisix price) from UITF/mutual funds (manual NAVPU).
- **Balance snapshots:** One per account, keyed by `accountId`. Synced across devices. No per-date history.
- **Category compound-key:** `name|type` dedup prevents same-name categories of different types from being silently dropped.
- **LWW trigger on all synced tables:** `prevent_older_update()` skips stale writes. All `updated_at` values must be newer than existing.

## Architecture Decisions
- **Zero server code in `src/`:** All `'use client'`. No API routes, no server components, no server actions.
- **Outbox sync:** Every local CRUD atomically enqueues a sync entry. Monotonic counter ensures FIFO.
- **Portfolio API Server** (`server/`): Separate Express app using service_role key (bypasses RLS). Localhost-only. For AI assistant integration.
- **Service_role JWT must include `updated_at`:** The LWW trigger on Supabase tables silently skips updates with stale timestamps.
