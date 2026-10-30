// Minimal static file server for the Next.js export in `out/`.
// Next's client router fetches `/route/index.txt` for RSC payloads, so every
// file under `out/` is served as-is; directories resolve to `index.html`.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../out/', import.meta.url)));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 4173);

try {
  await stat(root);
} catch {
  console.error(`Missing static export at ${root}. Run \`npm run build\` first.`);
  process.exit(1);
}

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
]);

async function resolveTarget(pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }

  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root + sep)) return null;

  let info;
  try {
    info = await stat(target);
  } catch {
    return null;
  }

  if (info.isDirectory()) {
    const index = resolve(target, 'index.html');
    try {
      if ((await stat(index)).isFile()) return index;
    } catch {
      return null;
    }
    return null;
  }

  return info.isFile() ? target : null;
}

async function send(response, status, file, method) {
  let body;
  try {
    body = await readFile(file);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(status, {
    'Content-Type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  response.end(method === 'HEAD' ? undefined : body);
}

const server = createServer(async (request, response) => {
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
  const file = await resolveTarget(url.pathname);

  if (file) {
    await send(response, 200, file, method);
    return;
  }

  await send(response, 404, resolve(root, '404.html'), method);
});

server.listen(port, host, () => {
  console.log(`Static export serving ${root} at http://${host}:${port}`);
});
