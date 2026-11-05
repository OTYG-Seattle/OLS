#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { Command } from 'commander';
import { packPackage, runSelfTests, SchemaRegistry, validateDocument, validatePackage, verifyPackage } from '@openliturgy/sdk';
import type { ValidationReport } from '@openliturgy/sdk';

function printReport(report: ValidationReport, format: string): void {
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  for (const item of report.diagnostics) process.stdout.write(`${item.severity.toUpperCase()} ${item.code} ${item.source}${item.jsonPointer}: ${item.message}\n`);
  process.stdout.write(report.valid ? 'OLS validation passed.\n' : 'OLS validation failed.\n');
}

const program = new Command().name('ols').description('OpenLiturgy Standard SDK').version('1.0.0');
program.command('validate').argument('<path>').option('--layer <layer>').option('--format <format>', 'text or json', 'text').option('--self-test').action(async (path, options) => {
  try {
    const absolute = resolve(path);
    const pathStat = await stat(absolute);
    let report = options.selfTest ? await runSelfTests(absolute) : pathStat.isDirectory() ? await validatePackage(absolute) : await validateDocument(absolute);
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
  .argument('<path>', 'package directory').option('--format <format>', 'text or json', 'text').action(async (path, options) => {
    try {
      const report = await verifyPackage(resolve(path));
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
program.command('schemas').command('refresh').option('--cache <path>', 'schema cache directory', resolve(homedir(), '.cache', 'ols', 'schemas')).action(async (options) => {
  try { const registry = await SchemaRegistry.bundled(); await registry.refresh(options.cache); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
});
await program.parseAsync();
