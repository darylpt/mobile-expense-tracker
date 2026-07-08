# Spec: Expected CSV Import Output

**Status:** ✅ Verified (committed)

These are the exact expected results of importing the two CSV files in this directory. Import is considered **correct** when every value below matches.

---

## 2026-Tracker - Transactions.csv

### Categories by Type

**income**
| Category | Rows |
|---|---|
| Cashback/Rewards | 137 |
| From Da | 13 |
| Interest | 223 |
| Other income | 5 |
| Receivable | 23 |
| Salary | 11 |

**expense**
| Category | Rows |
|---|---|
| Adjustments | 16 |
| Food | 130 |
| Grab Food | 75 |
| Grocery | 20 |
| Healthcare | 31 |
| Household | 23 |
| Leisure | 26 |
| Mame | 18 |
| Other expenses | 76 |
| Payables | 6 |
| Personal | 35 |
| Pets | 13 |
| Rent | 6 |
| Subsciption | 20 |
| Transportation | 49 |
| Utilities | 19 |

**transaction**
| Category | Rows |
|---|---|
| Credit card bill | 7 |
| Savings | 22 |
| Transfer | 78 |
| Withrawal | 16 |

### Account Starting Balances

| Account | Balance |
|---|---|
| BPI 1145 | ₱462,559.18 |
| BPI 8172 | ₱17,790.29 |
| BPI Credit Card | ₱64,787.17 |
| BanKo | ₱16,972.89 |
| Cash | ₱8,720.00 |
| Dade | ₱90,000.00 |
| For Doggos | ₱0.00 |
| For Rescues | ₱0.00 |
| GCash | ₱589.83 |
| GoTyme | ₱68,876.00 |
| MariBank | ₱6,740.75 |
| Maya | ₱11.71 |

### Summary Counts

| Metric | Value |
|---|---|
| Total CSV rows | 1,177 |
| Valid transactions | 1,099 |
| Errors | 0 |
| Income count | 421 |
| Expense count | 555 |
| Transfer count | 123 |
| Accounts created | 12 |
| Categories created | 26 |

---

## 2026-Budget Tracker - Transactions (3).csv

### Categories by Type

**income**
| Category | Rows |
|---|---|
| Cashback | 9 |
| Dividends | 1 |
| Interest | 2 |
| Other | 2 |
| Paycheck | 3 |

**expense**
| Category | Rows |
|---|---|
| Adjustments | 3 |
| Food | 11 |
| Health | 2 |
| Home | 11 |
| Motor - Gas | 8 |
| Motor - Maintenance | 2 |
| Personal | 12 |

**transaction**
| Category | Rows |
|---|---|
| Cash In | 5 |
| Cash Out | 2 |
| Savings Transfer | 6 |

### Account Starting Balances

| Account | Balance |
|---|---|
| BPI BanKo | ₱0.00 |
| Cash | ₱34.00 |
| DragonFi | ₱0.00 |
| Gcash | ₱911.65 |
| GoTyme | ₱20,567.79 |
| GoTyme(Sona) | ₱5,270.21 |
| Landbank | ₱600.68 |
| Seabank | ₱4,524.72 |

### Summary Counts

| Metric | Value |
|---|---|
| Total CSV rows | 528 |
| Valid transactions | 483 |
| Errors | 0 |
| Income count | 90 |
| Expense count | 267 |
| Transfer count | 126 |
| Accounts created | 8 |
| Categories created | 15 |

---

## Verification

Re-run checks with:

```bash
npx tsx -e "
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const { parseCsv } = await import(join(__dirname, '../src/lib/csv-import'));
const files = [
  'specs/data/2026-Tracker - Transactions.csv',
  'specs/data/2026-Budget Tracker - Transactions (3).csv',
];
for (const f of files) {
  const r = parseCsv(readFileSync(f, 'utf-8'));
  console.log(f, '→', r.validRows, 'rows,', r.errors.length, 'errors');
  console.log('  accounts:', r.accounts.length, 'categories:', r.categories.length);
  console.log('  income:', r.incomeCount, 'expense:', r.expenseCount, 'transfer:', r.transferCount);
}
"
```
