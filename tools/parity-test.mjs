import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
const exec = promisify(execFile);

const pythonExecutable = process.platform === 'win32' ? resolve('.venv/Scripts/python.exe') : resolve('.venv/bin/python');

const normalize = (text) => {
  const report = JSON.parse(text);
  return {
    valid: report.valid,
    diagnostics: report.diagnostics.map(({ layer, jsonPointer, code, severity }) => ({ layer, jsonPointer, code, severity })),
    schemaVersions: report.schemaVersions,
    skippedLayers: report.skippedLayers,
  };
};

// The CLIs exit 1 when a report is invalid; that is still a comparable report.
const run = async (file, args) => {
  try { return await exec(file, args); } catch (error) { if (error.code === 1 && error.stdout) return error; throw error; }
};

async function compare(label, args) {
  const node = await run(process.execPath, ['packages/cli/dist/cli.js', ...args]);
  const python = await run(pythonExecutable, ['-m', 'openliturgy.cli', ...args]);
  const left = JSON.stringify(normalize(node.stdout));
  const right = JSON.stringify(normalize(python.stdout));
  if (left !== right) throw new Error(`SDK parity mismatch (${label})\nTypeScript: ${left}\nPython: ${right}`);
  console.log(`Parity OK: ${label}`);
}

// Document-level validation of the manifest.
await compare('manifest document validation', ['validate', resolve('fixtures/complete-minimal/manifest.ols.json'), '--format', 'json']);
// Package-level validation (directory input) of the shared corpus package.
await compare('package validation', ['validate', resolve('fixtures/complete-minimal'), '--format', 'json']);
// Cross-package references: own-package qualified IDs and URNs, declared and undeclared dependencies.
await compare('cross-package references', ['validate', resolve('fixtures/cross-package'), '--format', 'json']);
// Self-test suite covers valid/invalid document fixtures, including translation variants.
await compare('self-test fixtures', ['validate', resolve('fixtures/complete-minimal'), '--self-test', '--format', 'json']);

// Dependencies: lockfile resolution, cross-package and alias references.
await compare('package with locked dependency', ['validate', resolve('fixtures/with-dependency'), '--format', 'json']);
{
  const args = ['lock', resolve('fixtures/with-dependency'), '--stdout'];
  const node = await run(process.execPath, ['packages/cli/dist/cli.js', ...args]);
  const python = await run(pythonExecutable, ['-m', 'openliturgy.cli', ...args]);
  if (node.stdout !== python.stdout) throw new Error(`SDK parity mismatch (lock)\nTypeScript: ${node.stdout}\nPython: ${python.stdout}`);
  console.log('Parity OK: lock fixtures/with-dependency');
}

// Integrity: verification reports for pinned, tampered, and unpinned packages.
await compare('verify pinned package', ['verify', resolve('fixtures/integrity'), '--format', 'json']);
await compare('verify tampered package', ['verify', resolve('fixtures/integrity-tampered'), '--format', 'json']);
await compare('verify unpinned package', ['verify', resolve('fixtures/complete-minimal'), '--format', 'json']);

// Trust: signatures and digest-bound approvals, with and without a keyring.
const keyring = resolve('fixtures/keys/demo-keyring.json');
await compare('verify signed package with keyring', ['verify', resolve('fixtures/signed'), '--keyring', keyring, '--format', 'json']);
await compare('verify signed package without keyring', ['verify', resolve('fixtures/signed'), '--format', 'json']);
await compare('verify re-packed tampered signed package', ['verify', resolve('fixtures/signed-tampered'), '--keyring', keyring, '--format', 'json']);
await compare('validate signed package with keyring', ['validate', resolve('fixtures/signed'), '--keyring', keyring, '--format', 'json']);

// Integrity: `ols pack --stdout` must produce byte-identical manifests.
for (const fixture of ['fixtures/complete-minimal', 'fixtures/integrity', 'fixtures/cross-package']) {
  const args = ['pack', resolve(fixture), '--stdout'];
  const node = await run(process.execPath, ['packages/cli/dist/cli.js', ...args]);
  const python = await run(pythonExecutable, ['-m', 'openliturgy.cli', ...args]);
  if (node.stdout !== python.stdout) throw new Error(`SDK parity mismatch (pack ${fixture})\nTypeScript: ${node.stdout}\nPython: ${python.stdout}`);
  console.log(`Parity OK: pack ${fixture}`);
}

// Change exchange: byte-identical stdout; commands that write get their own output directory per SDK.
async function compareRaw(label, makeArgs) {
  const node = await run(process.execPath, ['packages/cli/dist/cli.js', ...makeArgs(await mkdtemp(join(tmpdir(), 'ols-parity-ts-')))]);
  const python = await run(pythonExecutable, ['-m', 'openliturgy.cli', ...makeArgs(await mkdtemp(join(tmpdir(), 'ols-parity-py-')))]);
  if (node.stdout !== python.stdout || (node.code ?? 0) !== (python.code ?? 0)) {
    throw new Error(`SDK parity mismatch (${label})\nTypeScript: ${node.stdout}\nPython: ${python.stdout}`);
  }
  console.log(`Parity OK: ${label}`);
}
const changes = (name) => resolve('fixtures/changes', name);
await compareRaw('diff', () => ['diff', changes('base'), changes('ours')]);
await compareRaw('diff as overlay', () => ['diff', changes('base'), changes('theirs'), '--overlay', 'overlay-demo']);
await compareRaw('merge', (out) => ['merge', changes('base'), changes('ours'), changes('theirs'), '--out', join(out, 'merged')]);
await compareRaw('merge with conflict', (out) => ['merge', changes('base'), changes('ours'), changes('theirs-conflict'), '--out', join(out, 'merged')]);
await compareRaw('apply overlay', (out) => ['apply', resolve('fixtures/with-overlay/overlays/parish-kyrie.ols.json'), '--base', resolve('fixtures/with-overlay/ols_packages/org.openliturgy.dep'), '--out', join(out, 'applied')]);
await compareRaw('migrate (dry run)', () => ['migrate', resolve('fixtures/legacy'), '--dry-run']);
await compare('package with overlay', ['validate', resolve('fixtures/with-overlay'), '--format', 'json']);

console.log('TypeScript and Python reports are equivalent.');
