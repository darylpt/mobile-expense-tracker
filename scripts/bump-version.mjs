// Bump the app version in every file that carries it, then verify the result.
//
// Usage: node scripts/bump-version.mjs [patch|minor|major]   (default: patch)
//
// Deliberately does not stage anything: staging is the caller's decision.

import { readFile, writeFile } from 'node:fs/promises';

const LEVELS = ['patch', 'minor', 'major'];
const level = process.argv[2] ?? 'patch';

if (!LEVELS.includes(level)) {
  console.error(`Unknown bump level "${level}". Use one of: ${LEVELS.join(', ')}.`);
  process.exit(1);
}

const VERSION_FILE = 'src/lib/version.ts';
const APP_NAME = 'temp-expense-tracker';

const read = (path) => readFile(path, 'utf8');

const versionSource = await read(VERSION_FILE);
const current = /APP_VERSION = '(\d+\.\d+\.\d+)'/.exec(versionSource)?.[1];
if (!current) {
  console.error(`Could not read APP_VERSION from ${VERSION_FILE}.`);
  process.exit(1);
}

const [major, minor, patch] = current.split('.').map(Number);
const next =
  level === 'major'
    ? `${major + 1}.0.0`
    : level === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

const replacements = [
  {
    path: VERSION_FILE,
    apply: (text) => text.replace(`APP_VERSION = '${current}'`, `APP_VERSION = '${next}'`),
  },
  {
    path: 'package.json',
    apply: (text) => text.replace(`"version": "${current}"`, `"version": "${next}"`),
  },
  {
    path: 'specs/state.yaml',
    apply: (text) => text.replace(`version: "${current}"`, `version: "${next}"`),
  },
  {
    path: 'package-lock.json',
    // Only the two entries naming this package carry the app version; other
    // dependencies may legitimately share the same number.
    apply: (text) =>
      text
        .replace(
          `"name": "${APP_NAME}",\n  "version": "${current}"`,
          `"name": "${APP_NAME}",\n  "version": "${next}"`,
        )
        .replace(
          `"name": "${APP_NAME}",\n      "version": "${current}"`,
          `"name": "${APP_NAME}",\n      "version": "${next}"`,
        ),
  },
];

for (const { path, apply } of replacements) {
  const before = await read(path);
  const after = apply(before);
  if (after === before) {
    console.error(`No version "${current}" found in ${path}; aborting.`);
    process.exit(1);
  }
  await writeFile(path, after);
}

console.log(`v${current} -> v${next} (${level})`);
