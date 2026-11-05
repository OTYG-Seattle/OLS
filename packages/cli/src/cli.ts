#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { generateSigningKey, lockPackage, packPackage, signApproval, signPackage, runSelfTests, SchemaRegistry, validateDocument, validatePackage, verifyPackage } from '@openliturgy/sdk';
import type { Keyring, ValidationReport } from '@openliturgy/sdk';

const readKeyring = async (path?: string): Promise<Keyring | undefined> => (path ? JSON.parse(await readFile(resolve(path), 'utf8')) as Keyring : undefined);

function printReport(report: ValidationReport, format: string): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const item of report.diagnostics) process.stdout.write(`${item.severity.toUpperCase()} ${item.code} ${item.source}${item.jsonPointer}: ${item.message}\n`);
  process.stdout.write(report.valid ? 'OLS validation passed.\n' : 'OLS validation failed.\n');
}

const program = new Command().name('ols').description('OpenLiturgy Standard SDK').version('1.0.0');
program.command('validate').argument('<path>').option('--layer <layer>').option('--format <format>', 'text or json', 'text').option('--self-test').option('--keyring <file>', 'trusted signing keys (keyring JSON)').action(async (path, options) => {
  try {
    const absolute = resolve(path);
    const pathStat = await stat(absolute);
    let report = options.selfTest ? await runSelfTests(absolute) : pathStat.isDirectory() ? await validatePackage(absolute, undefined, { keyring: await readKeyring(options.keyring) }) : await validateDocument(absolute);
    if (options.layer) {
      const order = ['parse', 'schema-selection', 'structural', 'consistency', 'references', 'semantic'];
      const last = order.indexOf(options.layer);
      if (last < 0) throw new Error(`Unknown layer ${options.layer}`);
      report.diagnostics = report.diagnostics.filter((item) => order.indexOf(item.layer) <= last);
      report.valid = !report.diagnostics.some((item) => item.severity === 'error');
    }
    printReport(report, options.format);
    process.exitCode = report.valid ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
});
program.command('verify').description('Check that every document, local asset, and the package itself are pinned by digest and unchanged')
  .argument('<path>', 'package directory').option('--format <format>', 'text or json', 'text').option('--keyring <file>', 'require a trusted package signature and attested approvals').action(async (path, options) => {
    try {
      const report = await verifyPackage(resolve(path), { keyring: await readKeyring(options.keyring) });
      printReport(report, options.format);
      process.exitCode = report.valid ? 0 : 1;
    } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  });
program.command('pack').description('Pin every package document by digest in manifest.ols.json and recompute the package digest')
  .argument('<path>', 'package directory').option('--stdout', 'print the packed manifest instead of writing it').action(async (path, options) => {
    try {
      const manifest = await packPackage(resolve(path), { write: !options.stdout });
      process.stdout.write(options.stdout ? `${JSON.stringify(manifest, null, 2)}\n` : `${String(manifest.digest)}\n`);
    } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  });
program.command('lock').description('Pin every declared dependency (found under ols_packages/<name>) to its version and package digest in ols.lock.json')
  .argument('<path>', 'package directory').option('--packages-dir <dir>', 'directory holding resolved dependencies', 'ols_packages').option('--stdout', 'print the lockfile instead of writing it')
  .action(async (path, options) => {
    try {
      const { lock, manifestUpdated } = await lockPackage(resolve(path), { packagesDirectory: options.packagesDir, write: !options.stdout });
      if (options.stdout) process.stdout.write(`${JSON.stringify(lock, null, 2)}\n`);
      else process.stdout.write(`Locked ${Object.keys(lock.packages as object).length} dependencies.${manifestUpdated ? ' Added ols.lock.json to manifest files; run `ols pack` to re-pin.' : ''}\n`);
    } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  });
program.command('keygen').description('Generate an Ed25519 signing key (PKCS#8 PEM) and print its public key')
  .requiredOption('--out <file>', 'where to write the private key').action(async (options) => {
    try {
      const { privateKeyPem, publicKey } = generateSigningKey();
      await writeFile(resolve(options.out), privateKeyPem, { mode: 0o600, flag: 'wx' });
      process.stdout.write(`${publicKey}\n`);
    } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  });
program.command('sign').description('Sign a packed package (directory) or an approval document (file)')
  .argument('<path>').requiredOption('--key <file>', 'Ed25519 private key (PEM)').option('--signer <id>', 'person or organization ID of the signer')
  .action(async (path, options) => {
    try {
      const target = resolve(path);
      const privateKeyPem = await readFile(resolve(options.key), 'utf8');
      const entry = (await stat(target)).isDirectory() ? await signPackage(target, privateKeyPem, { signer: options.signer }) : await signApproval(target, privateKeyPem, { signer: options.signer });
      process.stdout.write(`Signed with ${entry.key}\n`);
    } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  });
program.command('schemas').command('refresh').option('--cache <path>', 'schema cache directory', resolve(homedir(), '.cache', 'ols', 'schemas')).action(async (options) => {
  try { const registry = await SchemaRegistry.bundled(); await registry.refresh(options.cache); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
});
await program.parseAsync();
