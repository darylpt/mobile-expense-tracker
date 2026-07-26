# Portfolio API Server

A local Express API that reads your portfolio data from Supabase and serves
it as JSON. Designed for AI assistants (Hermes Agent, Claude Code, etc.) to
fetch your latest holdings without browser access.

## Prerequisites

- Node.js 20+
- Supabase project with stock data synced (via the app's cloud sync)

## Setup

1. Get your Supabase credentials from the [Supabase Dashboard](https://supabase.com/dashboard):
   - **Project URL** → Settings → API → Project URL
   - **Service Role Key** → Settings → API → Project API keys → `service_role` key
   - **Auth User UUID** → Authentication → Users → find your email → copy the UUID

2. Add them to `.env.local` in the project root:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=sbp_your_service_role_key
PORTFOLIO_USER_ID=your-auth-uuid-here
```

> **Why service_role?** The stock tables use RLS with `auth.uid() = user_id`.
> A server-side query with the anon key returns zero rows (no JWT). The
> `service_role` key bypasses RLS, so we filter by `user_id` manually —
> safe because the server only listens on localhost.

## Usage

```bash
npm run server
# → http://localhost:4000
```

Custom port:

```bash
PORT=4001 npm run server
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/holdings` | Computed portfolio — per-ticker breakdown + summary |
| `GET /api/transactions` | Raw buy/sell log, newest first |
| `GET /api/dividends` | Dividend records, newest first |
| `GET /api/portfolio` | Everything bundled (holdings + raw data) |
| `GET /` | Serves the static PWA (`out/` if built) |

### Response example: `GET /api/holdings`

```json
{
  "asOf": "2026-07-26T12:00:00.000Z",
  "holdings": [
    {
      "ticker": "BDO",
      "name": "BDO Unibank Inc.",
      "type": "stock",
      "shares": 100,
      "avgCostPerShare": 145.50,
      "totalCost": 14550.00,
      "currentPrice": 152.00,
      "marketValue": 15200.00,
      "unrealizedGainLoss": 650.00,
      "unrealizedGainLossPct": 4.47
    }
  ],
  "summary": {
    "totalInvested": 14550.00,
    "totalMarketValue": 15200.00,
    "totalUnrealizedGL": 650.00,
    "totalUnrealizedGLPct": 4.47,
    "totalRealizedGL": 1200.00,
    "totalDividends": 850.00
  }
}
```

## From Hermes Agent (Docker sandbox)

```bash
curl http://host.docker.internal:4000/api/holdings
```

## Fallback (no server needed)

Open the app in your browser → **Stocks** tab → click **📋 Copy Summary**.
Paste the formatted text block directly into your AI assistant.
