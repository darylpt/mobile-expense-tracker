// ============================================================
// csv-import.ts — CSV parser for Google Sheets expense tracker export
//
// Parses a CSV with columns:
//   Date,Amount,Description,Type,Category,From Account,To Account
//
// Returns extracted accounts (with starting balances from carry-overs),
// categories (with inferred types), transactions, and any parse errors.
// ============================================================

import type { Account, Category, Transaction } from '@/types';

// ── Types ────────────────────────────────────────────────────

export interface CsvRow {
  date: string;
  amount: number;
  description: string;
  type: string;
  category: string;
  fromAccount: string;
  toAccount: string;
  /** The original 1-based row number in the CSV (header excluded) */
  rowNum: number;
}

export interface CsvError {
  row: number;
  message: string;
}

export interface CsvSummary {
  totalRows: number;
  validRows: number;
  errorRows: number;
  accountCount: number;
  categoryCount: number;
  incomeCount: number;
  expenseCount: number;
  transferCount: number;
  carryOverCount: number;
  totalAmount: number;
}

export interface ParsedCsv {
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  errors: CsvError[];
  summary: CsvSummary;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Parse a single CSV line into columns, handling quoted fields.
 *
 * Handles:
 * - Double-quoted fields containing commas (e.g. "₱4,524.72")
 * - Escaped quotes inside fields (e.g. "say ""hello""")
 * - Unquoted fields (simple split by comma)
 */
function parseCsvLine(line: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        // Escaped quote inside field
        current += '"';
        i++; // skip next quote
      } else if (ch === '"') {
        // End of quoted field
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        // Start of quoted field
        inQuotes = true;
      } else if (ch === ',') {
        // End of column
        cols.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  // Last column
  cols.push(current);
  return cols;
}

/** Parse M/D/YYYY → YYYY-MM-DD. Returns null on invalid input. */
function parseDate(raw: string): string | null {
  const trimmed = raw.trim();
  const parts = trimmed.split('/');
  if (parts.length !== 3) return null;
  const month = parseInt(parts[0], 10);
  const day = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (isNaN(month) || isNaN(day) || isNaN(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Parse amount: strip ₱,$,,, spaces, parse float. Returns NaN on failure. */
function parseAmount(raw: string): number {
  const cleaned = raw.replace(/[₱$,\s]/g, '');
  return parseFloat(cleaned);
}

// ── Parser ───────────────────────────────────────────────────

const MAX_ROWS = 2000;

export function parseCsv(text: string): ParsedCsv {
  // 1. Strip UTF-8 BOM
  let cleaned = text;
  if (cleaned.charCodeAt(0) === 0xFEFF) {
    cleaned = cleaned.slice(1);
  }

  // 2. Split into lines, trim per row
  const rawLines = cleaned.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (trimmed) lines.push(trimmed);
  }

  // 3. Detect & skip header
  let startIdx = 0;
  if (lines.length > 0) {
    const header = lines[0].toLowerCase().replace(/"/g, '');
    // Check if this looks like a header row (has the key column names)
    if (header.includes('date') && header.includes('amount') && header.includes('description')) {
      startIdx = 1;
    }
  }

  const dataLines = lines.slice(startIdx);

  // 4. Cap at MAX_ROWS
  const rowsToParse = dataLines.slice(0, MAX_ROWS);
  if (dataLines.length > MAX_ROWS) {
    // ponytail: hard cap to keep UI responsive. User splits large CSVs.
  }

  const carryOverEntries = new Map<string, { amount: number; month: number }>(); // account → {amount, month}
  const accountNames = new Set<string>();
  const categoryRows = new Map<string, CsvRow[]>(); // category name → rows for type inference
  const transactions: Transaction[] = [];
  const errors: CsvError[] = [];
  const now = Date.now();

  let incomeCount = 0;
  let expenseCount = 0;
  let transferCount = 0;
  let carryOverCount = 0;
  let totalAmount = 0;
  let firstCarryOverMonth: number | null = null;

  for (let i = 0; i < rowsToParse.length; i++) {
    const line = rowsToParse[i];
    const rowNum = startIdx + i + 1; // 1-based, original CSV row

    const cols = parseCsvLine(line);
    if (cols.length < 7) {
      errors.push({ row: rowNum, message: `Expected 7 columns, got ${cols.length}: "${line}"` });
      continue;
    }

    const rawDate = cols[0].trim();
    const rawAmount = cols[1].trim();
    const description = cols[2].trim();
    const rawType = cols[3].trim();
    const category = cols[4].trim();
    const fromAccount = cols[5].trim();
    const toAccount = cols[6].trim();

    // Parse date
    const date = parseDate(rawDate);
    if (!date) {
      errors.push({ row: rowNum, message: `Invalid date: "${rawDate}"` });
      continue;
    }

    // Parse amount
    const amount = parseAmount(rawAmount);
    if (isNaN(amount) || amount <= 0) {
      errors.push({ row: rowNum, message: `Invalid amount: "${rawAmount}"` });
      continue;
    }

    if (!category) {
      // ponytail: no category = skip. Real CSVs always have it.
      errors.push({ row: rowNum, message: 'Missing category' });
      continue;
    }

    // Extract month from parsed date for carry-over filtering
    const coMonth = parseInt(date.split('-')[1], 10);

    // ── Carry Over handling ──
    if (category.toLowerCase() === 'carry over') {
      if (firstCarryOverMonth === null) {
        firstCarryOverMonth = coMonth;
      }
      const targetAccount = toAccount || fromAccount;
      if (targetAccount) {
        accountNames.add(targetAccount);
        // Only record the first carry-over per account, AND only from the
        // first month that has carry-over rows. Later months' carry-overs
        // represent accumulated running balances, not opening balances.
        if (!carryOverEntries.has(targetAccount) && coMonth === firstCarryOverMonth) {
          carryOverEntries.set(targetAccount, { amount, month: coMonth });
        }
        // ponytail: subsequent carry-overs for same account are silently skipped
      }
      carryOverCount++;
      totalAmount += amount;
      continue; // no transaction created
    }

    // ── Regular row ──
    const hasFrom = !!fromAccount;
    const hasTo = !!toAccount;

    if (!hasFrom && !hasTo) {
      errors.push({ row: rowNum, message: 'Both From Account and To Account are empty' });
      continue;
    }

    // Account collection
    if (hasFrom) accountNames.add(fromAccount);
    if (hasTo) accountNames.add(toAccount);

    // Infer transaction type
    let txType: Transaction['type'];
    if (hasTo && !hasFrom) {
      txType = 'income';
      incomeCount++;
    } else if (hasFrom && !hasTo) {
      txType = 'expense';
      expenseCount++;
    } else {
      txType = 'transaction';
      transferCount++;
    }

    totalAmount += amount;

    // Store row for category type inference
    const catRows = categoryRows.get(category) || [];
    catRows.push({ date, amount, description, type: rawType, category, fromAccount, toAccount, rowNum });
    categoryRows.set(category, catRows);

    // Create transaction (id generated in importFromCsv for atomic batch, but we need placeholder for count)
    transactions.push({
      id: '', // placeholder, reassigned during import
      amount,
      date,
      type: txType,
      category,
      fromAccount: fromAccount || null,
      toAccount: toAccount || null,
      description: description || undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ── Generate UUIDs for all accounts and categories ──
  // Map from lowercase name for case-insensitive matching
  const accountUuid = new Map<string, string>();
  for (const name of accountNames) {
    accountUuid.set(name.toLowerCase(), crypto.randomUUID());
  }
  const categoryUuid = new Map<string, string>();
  for (const [catName] of categoryRows) {
    if (catName.toLowerCase() !== 'carry over') {
      categoryUuid.set(catName.toLowerCase(), crypto.randomUUID());
    }
  }

  // ── Build accounts ──
  const accounts: Account[] = [];
  let acctSortOrder = 0;
  for (const name of accountNames) {
    const entry = carryOverEntries.get(name);
    const startingBalance = entry ? entry.amount : 0;
    accounts.push({
      id: accountUuid.get(name.toLowerCase())!,
      name,
      startingBalance,
      sortOrder: acctSortOrder,
    });
    acctSortOrder += 1000;
  }

  // ── Build categories (excluding Carry Over) ──
  const categories: Category[] = [];
  let catSortOrder = 0;
  for (const [catName, rows] of categoryRows) {
    if (catName.toLowerCase() === 'carry over') continue; // not a real category
    const categoryType = inferCategoryType(rows);
    categories.push({
      id: categoryUuid.get(catName.toLowerCase())!,
      name: catName,
      type: categoryType,
      sortOrder: catSortOrder,
    });
    catSortOrder += 1000;
  }

  // ── Remap transaction references from names → UUIDs ──
  for (const t of transactions) {
    if (t.fromAccount) {
      t.fromAccount = accountUuid.get(t.fromAccount.toLowerCase()) ?? t.fromAccount;
    }
    if (t.toAccount) {
      t.toAccount = accountUuid.get(t.toAccount.toLowerCase()) ?? t.toAccount;
    }
  }

  // ── Summary ──
  const summary: CsvSummary = {
    totalRows: rowsToParse.length,
    validRows: transactions.length,
    errorRows: errors.length,
    accountCount: accounts.length,
    categoryCount: categories.length,
    incomeCount,
    expenseCount,
    transferCount,
    carryOverCount,
    totalAmount,
  };

  return { accounts, categories, transactions, errors, summary };
}

/**
 * Infer a category's TransactionType from the CSV rows for that category.
 *
 * Uses the CSV's `Type` column as the primary signal (it already says Income,
 * Expense, or Transfer on every row). Falls back to account-pattern heuristic
 * only when a category has mixed Type values (e.g., "Adjustments").
 */
export function inferCategoryType(rows: CsvRow[]): Transaction['type'] {
  const types = new Set(rows.map((r) => r.type.toLowerCase()));

  // If all rows agree, use their Type column value directly
  if (types.size === 1) {
    const t = [...types][0];
    if (t === 'income') return 'income';
    if (t === 'expense') return 'expense';
    if (t === 'transfer') return 'transaction';
  }

  // Mixed types — fall back to account-pattern heuristic
  let hasIncome = false;
  let hasExpense = false;
  let hasTransfer = false;
  for (const row of rows) {
    if (!!row.toAccount && !row.fromAccount) hasIncome = true;
    if (!!row.fromAccount && !row.toAccount) hasExpense = true;
    if (!!row.fromAccount && !!row.toAccount) hasTransfer = true;
  }
  if (hasTransfer && !hasIncome && !hasExpense) return 'transaction';
  if (hasIncome && !hasExpense) return 'income';
  return 'expense';
}
