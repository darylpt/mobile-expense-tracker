// Standalone script: refresh stock prices from Phisix and write to Supabase
// Uses the server's Supabase client (service_role key bypasses RLS).
// Run: node server/refresh-prices.mjs

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// Load .env.local
const envPath = resolve(process.cwd(), '.env.local');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USER_ID = process.env.PORTFOLIO_USER_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !USER_ID) {
  console.error('Missing env: SUPABASE_URL, SUPABASE_SERVICE_KEY, PORTFOLIO_USER_ID');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function refreshPrices() {
  // 1. Fetch Phisix board
  console.log('Fetching Phisix board...');
  const res = await fetch('https://phisix-api3.appspot.com/stocks.json');
  if (!res.ok) throw new Error(`Phisix HTTP ${res.status}`);
  const data = await res.json();
  const board = new Map();
  for (const s of data.stocks ?? []) {
    board.set(s.symbol.toUpperCase(), s);
  }
  console.log(`Loaded ${board.size} tickers from Phisix`);

  // 2. Get user's stocks from Supabase
  const { data: stocks, error: selErr } = await supabase
    .from('stocks')
    .select('id, ticker, name, current_price')
    .eq('user_id', USER_ID)
    .is('deleted_at', null);

  if (selErr) throw new Error(`SELECT: ${selErr.message}`);
  console.log(`User has ${stocks.length} stocks in Supabase`);

  // 3. Match and update
  let updated = 0;
  for (const stock of stocks) {
    const match = board.get(stock.ticker.toUpperCase());
    if (!match) {
      console.log(`  ${stock.ticker}: not found on PSE (fund?)`);
      continue;
    }
    const price = match.price?.amount;
    if (typeof price !== 'number' || isNaN(price)) {
      console.log(`  ${stock.ticker}: invalid price`);
      continue;
    }

    const now = new Date().toISOString();
    const { error: updErr } = await supabase
      .from('stocks')
      .update({ current_price: price, price_updated_at: now, updated_at: now })
      .eq('id', stock.id);

    if (updErr) {
      console.log(`  ${stock.ticker}: UPDATE ERROR ${updErr.message}`);
    } else {
      console.log(`  ${stock.ticker}: ₱${price} ✓`);
      updated++;
    }
  }

  console.log(`\nDone. ${updated}/${stocks.length} prices updated.`);
}

refreshPrices().catch(e => console.error('Fatal:', e));
