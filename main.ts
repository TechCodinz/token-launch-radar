// Deterministic CLI runner for token-launch-radar (Node 22+ standard library only).
// Reads a sealed DefiLlama snapshot, ranks every pre-token protocol via lib/model.ts,
// validates all board invariants, writes board.json and data.js, copies dashboard/ and
// screenshots/ into the output directory, and seals dossier.json last.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { PLAIN_NAME, buildDossier } from './vendor/makefun-board.ts';

const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));

const DOSSIER_CAPS = {
  text_max_bytes: 65_536,
  screenshots: { max: 4, max_bytes: 524_288 },
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
};

function readArg(flag: string, fallback: string): string {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === `--${flag}` && i + 1 < argv.length) {
      return argv[i + 1]!;
    }
    if (token.startsWith(`--${flag}=`)) {
      return token.slice(flag.length + 3);
    }
  }
  return fallback;
}

function resolveSnapshotPath(inputArg: string): string {
  if (inputArg.endsWith('.json')) return inputArg;
  if (existsSync(inputArg) && statSync(inputArg).isFile()) return inputArg;
  return join(inputArg, 'snapshot.json');
}

function copyDirectoryFiles(srcDir: string, dstDir: string): string[] {
  if (!existsSync(srcDir)) return [];
  mkdirSync(dstDir, { recursive: true });
  const entries = readdirSync(srcDir)
    .filter((name) => !name.startsWith('.'))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const copied: string[] = [];
  for (const name of entries) {
    const srcPath = join(srcDir, name);
    if (!statSync(srcPath).isFile()) continue;
    copyFileSync(srcPath, join(dstDir, name));
    copied.push(name);
  }
  return copied;
}

function main(): void {
  const inputArg = readArg('input', '/input');
  const snapshotPath = resolveSnapshotPath(inputArg);
  if (!existsSync(snapshotPath)) {
    process.stderr.write(`token-launch-radar: snapshot not found at ${snapshotPath}\n`);
    process.exit(1);
  }

  const outDir = readArg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

  const snapshotText = readFileSync(snapshotPath, 'utf8');
  const snapshot = parseSnapshot(snapshotText);
  const { board, radar } = buildRadar(snapshot);

  const issue = boardIssue(board, snapshot);
  if (issue !== null) {
    process.stderr.write(`token-launch-radar: board validation failed: ${issue}\n`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`, 'utf8');
  writeFileSync(join(outDir, 'data.js'), dataScript(radar), 'utf8');

  const dashFiles = copyDirectoryFiles(join(ROOT_DIR, 'dashboard'), join(outDir, 'dashboard'));
  if (dashFiles.length === 0) {
    process.stderr.write('token-launch-radar: dashboard/ directory is missing or empty\n');
    process.exit(1);
  }

  const shotFiles = copyDirectoryFiles(join(ROOT_DIR, 'screenshots'), join(outDir, 'screenshots'));
  if (shotFiles.length < 3) {
    process.stderr.write(
      `token-launch-radar: screenshots/ has ${shotFiles.length} file(s); at least 3 are required\n`,
    );
    process.exit(1);
  }
  for (const name of shotFiles) {
    if (!PLAIN_NAME.test(name)) {
      process.stderr.write(
        `token-launch-radar: invalid screenshot filename "${name}" (must match ${PLAIN_NAME})\n`,
      );
      process.exit(1);
    }
  }

  // Write dossier.json strictly last from the assembled output directory.
  const dossierBytes = buildDossier(outDir, DOSSIER_CAPS);
  writeFileSync(join(outDir, 'dossier.json'), dossierBytes);

  const top = board[0];
  process.stdout.write(
    `token-launch-radar: scanned ${radar.meta.scanned} protocols, ranked ${radar.meta.pre_token} pre-token (${radar.meta.watchlist_count} watchlist), #1 ${top?.name ?? 'n/a'} ($${top?.implied_value_usd.toLocaleString('en-US') ?? '0'}), wrote ${outDir} (${dashFiles.length} dashboard files, ${shotFiles.length} screenshots, dossier.json)\n`,
  );
}

main();
