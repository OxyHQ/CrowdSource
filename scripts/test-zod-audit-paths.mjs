import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectZodLock } from './zod-audit-paths.mjs';

const lock = Bun.JSONC.parse(readFileSync(new URL('../bun.lock', import.meta.url), 'utf8'));
assert.deepEqual(inspectZodLock(lock), []);
function rejects(name, mutate, expected) {
  const changed = structuredClone(lock);
  mutate(changed);
  assert.ok(
    inspectZodLock(changed).some((error) => expected.test(error)),
    name,
  );
}
for (const directory of ['packages/backend', 'packages/core']) {
  rejects(
    `${directory} cannot import the CLI`,
    (copy) => {
      copy.workspaces[directory].dependencies['@expo/cli'] = '58.1.13';
    },
    /Unreviewed Expo CLI parent/,
  );
}
rejects(
  'another transitive parent cannot import CLI',
  (copy) => {
    copy.packages.unreviewed = [
      'unreviewed@1.0.0',
      '',
      { dependencies: { '@expo/cli': '58.1.13' } },
    ];
  },
  /Unreviewed Expo CLI parent/,
);
rejects(
  'a direct alias cannot share residual Zod',
  (copy) => {
    copy.workspaces['packages/core'].dependencies['@expo/cli/zod'] = '3.25.76';
  },
  /Vulnerable Zod outside Expo build CLI/,
);
rejects(
  'runtime Zod cannot regress',
  (copy) => {
    copy.packages.zod = ['zod@3.25.76', '', {}];
  },
  /Unreviewed vulnerable Zod/,
);
rejects(
  'artifact changes require review',
  (copy) => {
    copy.packages['@expo/cli'][3] = 'sha512-unreviewed';
  },
  /Reviewed Expo build artifact changed/,
);
rejects(
  'a new vulnerable version cannot inherit the exception',
  (copy) => {
    copy.packages['@expo/cli/zod'][0] = 'zod@4.6.6';
  },
  /Reviewed Expo build artifact changed/,
);
rejects(
  'a CLI alias requires review',
  (copy) => {
    copy.packages['cli-alias'] = copy.packages['@expo/cli'];
  },
  /Unreviewed Expo CLI alias/,
);
console.log('Zod residual path policy: baseline and eight negative mutations passed.');
