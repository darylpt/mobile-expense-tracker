# Expense Tracker PWA — Project Context

> A local-first personal finance PWA with optional Supabase cloud sync.
> Actively used since June 2026.

## Quick Reference

| | |
|---|---|
| **Run dev server** | `npm run dev` (→ localhost:3000) |
| **Run tests** | `npm test` (Jest) or `npm run test:e2e` (Playwright) |
| **Typecheck** | `npx tsc --noEmit` |
| **Lint** | `npm run lint` |
| **Portfolio API** | `npm run server` (→ localhost:4000) |
| **DB version** | 13 (IndexedDB) |

## Rules & Workflow

This project has strict rules defined in the following files (read in order):

1. **`AGENTS.md`** — Hard rules: delegation enforcement, documentation completeness, version bumping
2. **`.agents/workflow.md`** — Workflow instructions: task execution, quality gates, project structure
3. **`specs/README.md`** — Full specs index with status of all features

## Navigation

| Route | Screen |
|---|---|
| `/` | Summary / Dashboard |
| `/stocks` | Stock Portfolio Tracker |
| `/transactions` | Full transaction list with filters |
| `/available-balance` | Cash reconciliation |
| `/payout` | Payout split calculator |
| `/settings` | Accounts, Categories, Tab Visibility, Cloud Sync, Backup |
| `/login` | Magic-link sign-in (when Supabase configured) |

## Key Architecture Decisions

- **`'use client'` everywhere** — No server components, API routes, or server actions
- **IndexedDB is source of truth** — Supabase is a sync target, not primary storage
- **Outbox sync pattern** — Local writes are atomic with sync queue entries
- **Service_role key** used only for Portfolio API Server (localhost only, never in browser)
- **Phisix API** for Philippine stock prices (not Yahoo Finance — CORS issues)

## Data Stores (IndexedDB, 10 stores)

transactions, accounts, categories, cashDenominations, payouts, budgetTargets,
balanceSnapshots, stocks, stockTransactions, dividends, syncQueue
