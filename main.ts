// Token Launch Radar - entrypoint.
//
// Reads the sealed snapshot, builds the ranked board with lib/model.ts,
// refuses to write anything if the board fails its own gate shape, then
// writes board.json and data.js, copies dashboard/ and screenshots/ into
// the output directory, and writes dossier.json LAST with the vendored
// buildDossier. Node 22 standard library only; no network, no clock, no
// randomness - two runs over the same snapshot write identical bytes.

import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boardIssue, buildRadar, dataScript, parseSnapshot } from "./lib/model.ts";
import { buildDossier } from "./vendor/makefun-board.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DOSSIER_CAPS = {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 400, max_bytes: 4194304 },
};

function argValue(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) return null;
  return args[index + 1];
}

function snapshotPathFor(input: string): string {
  const resolved = resolve(input);
  return statSync(resolved).isDirectory() ? join(resolved, "snapshot.json") : resolved;
}

function copyDir(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const input = argValue(args, "--input") ?? "/input";
  const output =
    argValue(args, "--output") ?? process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
  const outDir = resolve(output);

  const snapshot = parseSnapshot(readFileSync(snapshotPathFor(input), "utf8"));
  const radar = buildRadar(snapshot);

  const issue = boardIssue(radar.rows, snapshot);
  if (issue !== null) {
    console.error("board issue: " + issue);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "board.json"),
    JSON.stringify({ rows: radar.rows }, null, 2) + "\n",
  );
  writeFileSync(join(outDir, "data.js"), dataScript(radar));

  copyDir(join(HERE, "dashboard"), join(outDir, "dashboard"));

  const shotsSource = join(HERE, "screenshots");
  const shots = readdirSync(shotsSource).filter((name) => !name.startsWith("."));
  if (shots.length < 3) {
    console.error("screenshots: need at least 3, found " + shots.length);
    process.exit(1);
  }
  for (const name of shots) {
    if (!PLAIN_NAME.test(name)) {
      console.error("screenshots: name is not plain: " + name);
      process.exit(1);
    }
  }
  copyDir(shotsSource, join(outDir, "screenshots"));

  const dossier = buildDossier(outDir, DOSSIER_CAPS);
  writeFileSync(join(outDir, "dossier.json"), dossier);

  const top = radar.rows[0];
  console.log(
    "token launch radar: " +
      radar.rows.length +
      " pre-token of " +
      radar.meta.scanned +
      " scanned; top " +
      top.slug +
      " at $" +
      top.implied_value_usd +
      "; wrote board.json, data.js, dashboard/, screenshots/, dossier.json to " +
      outDir,
  );
}

main();
