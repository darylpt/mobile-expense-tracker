// Readiness probe for the hosted Supabase schema.
//
// Usage: node --env-file=.env.local scripts/check-supabase-schema.mjs
//
// Uses only the public anon key: it proves what the deployed client can see, not
// what an admin could. Every check here has a matching migration; a missing
// object means the client will fail that path at runtime.
//
// Exits 1 when a required object is absent.

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or an anon/publishable key.');
  process.exit(2);
}

const headers = { apikey: key, Authorization: `Bearer ${key}` };
let failures = 0;

async function checkTable(label, table, migration) {
  const response = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
  const missing = response.status === 404;
  console.log(
    `${missing ? 'MISSING' : 'ok     '}  table ${label} (${table})${missing ? `  — apply ${migration}` : ''}`,
  );
  if (missing) failures += 1;
}

async function checkRpc(label, fn, body, migration) {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // 404/400 with PGRST202 means "no such function"; any other status means the
  // function exists (and rejected our arguments or the row).
  const text = await response.text();
  const absent = response.status === 404 || text.includes('PGRST202');
  console.log(
    `${absent ? 'MISSING' : 'ok     '}  rpc   ${label} (${fn})${absent ? `  — apply ${migration}` : ''}`,
  );
  if (absent) failures += 1;
}

await checkTable('accounts', 'accounts', '001_schema.sql');
await checkTable('dataset generations', 'dataset_generations', '007_dataset_generation.sql');

await checkRpc(
  'managed write',
  'apply_managed_write',
  {
    p_generation: 0,
    p_store: 'accounts',
    p_operation: 'delete',
    p_record_id: '00000000-0000-0000-0000-000000000000',
    p_record: null,
  },
  '007_dataset_generation.sql',
);

// Phase 3B groundwork — informational until a client adopts revisions.
for (const [label, fn] of [
  ['replace dataset', 'replace_dataset'],
]) {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  const text = await response.text();
  const absent = response.status === 404 || text.includes('PGRST202');
  console.log(`${absent ? 'absent ' : 'ok     '}  rpc   ${label} (${fn})${absent ? '  — apply 007_dataset_generation.sql' : ''}`);
}

console.log(
  failures === 0
    ? '\nRequired schema present. Managed sync can reach the server.'
    : `\n${failures} required object(s) missing: managed writes will queue and never leave the device.`,
);
process.exit(failures === 0 ? 0 : 1);
