// Fail when the app version differs between the files that must agree.
//
// Usage: node scripts/check-version-sync.mjs
//
// Reads the same four sources bump-version.mjs writes, so a hand-edited or
// partially bumped commit is caught by CI instead of by review.

import { readFile } from 'node:fs/promises';

const APP_NAME = 'temp-expense-tracker';

const read = (path) => readFile(path, 'utf8');

const versionSource = await read('src/lib/version.ts');
const appVersion = /APP_VERSION = '(\d+\.\d+\.\d+)'/.exec(versionSource)?.[1];

const packageJson = JSON.parse(await read('package.json'));
const stateYaml = await read('specs/state.yaml');
const lockJson = await read('package-lock.json');

const stateVersion = /^version: "(\d+\.\d+\.\d+)"/m.exec(stateYaml)?.[1];
const lockRoot = new RegExp(
  `"name": "${APP_NAME}",\\n  "version": "(\\d+\\.\\d+\\.\\d+)"`,
).exec(lockJson)?.[1];
const lockEntry = new RegExp(
  `"name": "${APP_NAME}",\\n      "version": "(\\d+\\.\\d+\\.\\d+)"`,
).exec(lockJson)?.[1];

const found = {
  'src/lib/version.ts': appVersion,
  'package.json': packageJson.version,
  'specs/state.yaml': stateVersion,
  'package-lock.json (root)': lockRoot,
  'package-lock.json (packages)': lockEntry,
};

const missing = Object.entries(found)
  .filter(([, value]) => !value)
  .map(([file]) => file);

if (missing.length > 0) {
  console.error(`Could not read the app version from: ${missing.join(', ')}`);
  process.exit(1);
}

const distinct = new Set(Object.values(found));
if (distinct.size > 1) {
  console.error('App version mismatch:');
  for (const [file, value] of Object.entries(found)) {
    console.error(`  ${file}: ${value}`);
  }
  console.error('Run `npm run version:bump` to bring every file to one version.');
  process.exit(1);
}

console.log(`App version ${[...distinct][0]} is consistent across ${Object.keys(found).length} files.`);
