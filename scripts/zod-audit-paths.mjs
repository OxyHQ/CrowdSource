// GHSA-mrhx-c7xc-m3w5: the sole residual is Expo's Node build CLI.
// No application parser or published SDK may inherit this exception.
export const ZOD_ADVISORY = 'GHSA-mrhx-c7xc-m3w5';
const fields = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const reviewed = {
  expo: [
    'expo@58.0.16',
    'sha512-LnWYyk8tYuXkNh4BSEnRhXXDtfPPJBWXOeyVtlnmRskWEyC641eqH3pDvXuX8NF2a6eg0E+rjRbZ94yO3DeM0g==',
  ],
  '@expo/cli': [
    '@expo/cli@58.1.13',
    'sha512-a3FBo818/laj78tmDe8j/oOmxv8XBtA7nYdQQNHjebj1+RbhJjlZNxc2e1SwFXj8pXtruCdrs7fNFQTAFjS6GA==',
  ],
  '@expo/cli/zod': [
    'zod@3.25.76',
    'sha512-gzUt/qt81nXsFGKIFcC3YnfEAx5NkunCfnDlvuBSSFS02bcXu4Lmea0AFIUwbLWxWPx3d9p8S5QoaujKcNQxcQ==',
  ],
};
function metadata(entry) {
  return entry.find((part) => part && typeof part === 'object' && !Array.isArray(part)) ?? {};
}
function lookup(packages, from, name) {
  const parts = from.match(/@[^/]+\/[^/]+|[^/]+/g) ?? [];
  for (let n = parts.length; n >= 0; n--) {
    const key = [...parts.slice(0, n), name].join('/');
    if (Object.hasOwn(packages, key)) return key;
  }
}
function patched(identity) {
  const match = /^zod@(\d+)\.(\d+)\.(\d+)$/.exec(identity);
  return (
    match &&
    (Number(match[1]) > 4 ||
      (Number(match[1]) === 4 &&
        (Number(match[2]) > 6 || (Number(match[2]) === 6 && Number(match[3]) >= 7))))
  );
}
export function inspectZodLock(lock) {
  const errors = [];
  if (!lock?.packages || !lock?.workspaces) return ['Complete Bun lock inventory is required'];
  const { packages, workspaces } = lock;
  for (const [key, entry] of Object.entries(packages)) {
    if (entry[0]?.startsWith('@expo/cli@') && key !== '@expo/cli')
      errors.push(`Unreviewed Expo CLI alias: ${key}`);
  }
  const residuals = Object.entries(packages).filter(
    ([, entry]) => entry[0]?.startsWith('zod@') && !patched(entry[0]),
  );
  for (const [key] of residuals) {
    if (key !== '@expo/cli/zod') errors.push(`Unreviewed vulnerable Zod: ${key}`);
  }
  if (!residuals.length) return errors;
  for (const [key, [identity, integrity]] of Object.entries(reviewed)) {
    if (packages[key]?.[0] !== identity || packages[key]?.at(-1) !== integrity)
      errors.push(`Reviewed Expo build artifact changed: ${key}`);
  }
  // Inspect every incoming edge, not just the first path to a shared package.
  // A direct API/SDK CLI dependency or another transitive parent must fail even
  // when the legitimate Expo path also exists in the same lock.
  function inspect(from, deps, workspace) {
    for (const field of fields) {
      for (const name of Object.keys(deps[field] ?? {})) {
        const key = lookup(packages, from, name);
        if (
          key === '@expo/cli' &&
          (workspace ||
            from !== 'expo' ||
            field !== 'dependencies' ||
            deps.dependencies[name] !== '^58.1.13')
        )
          errors.push(`Unreviewed Expo CLI parent: ${from}:${field} -> ${name}`);
        if (
          key === '@expo/cli/zod' &&
          (workspace || from !== '@expo/cli' || field !== 'dependencies')
        )
          errors.push(`Vulnerable Zod outside Expo build CLI: ${from}:${field} -> ${name}`);
      }
    }
  }
  for (const [key, entry] of Object.entries(packages)) inspect(key, metadata(entry), false);
  for (const [key, entry] of Object.entries(workspaces)) inspect(entry.name ?? key, entry, true);
  return errors;
}
