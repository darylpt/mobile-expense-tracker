// ============================================================
// supabase.ts — Supabase client wrapper
//
// Strictly client-side. No server components, no SSR.
// Provide the public URL and anon key via environment variables.
// ============================================================

'use client';

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';

function createSupabaseClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    // No-op stub — app works fully offline without Supabase configured.
    // ponytail: silent fallback. If sync is critical for the user, add a
    // toast/banner in TransactionContext when supabase is missing.
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
    },
  });
}

/** Singleton Supabase client. null if env vars are not set. */
export const supabase = createSupabaseClient();
