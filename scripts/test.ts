/**
 * Interactive `npm test` driver.
 *
 * Lists every test section under `test/` as a numbered choice and runs
 * `hardhat test` against the matching glob(s). Behaviour:
 *
 *   - Interactive (TTY): prints the menu, reads one line, dispatches.
 *   - Non-interactive (CI / piped stdin): silently runs the "default"
 *     suite (math + periphery + security) — same as the historic
 *     `npm test` glob — so unattended runs never hang.
 *   - Argument shortcut: `npm test -- security`, `npm test -- 5`, or
 *     `npm test -- all` skip the prompt entirely.
 *
 * The hardhat invocation always carries `--show-stack-traces --typecheck`
 * to match the old script.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

interface Section {
  name: string;
  globs: string[];
  description: string;
  notes?: string;
}

const REPO_ROOT = path.resolve(__dirname, "..");

// Order matters: index 0 is the default, "all" is the catch-all at the bottom.
const SECTIONS: Section[] = [
  {
    name: "default",
    globs: ["test/math/*.test.ts", "test/periphery/*.test.ts", "test/security/*.test.ts"],
    description: "math + periphery + security  (the historic npm test glob)",
  },
  {
    name: "liquidity",
    globs: ["test/liquidity/*.test.ts"],
    description: "mint / burn — genesis seeding, proportional, permit, ALast",
  },
  {
    name: "math",
    globs: ["test/math/*.test.ts"],
    description: "library-level math regressions (kernel, EMA, …)",
  },
  {
    name: "periphery",
    globs: ["test/periphery/*.test.ts"],
    description: "router integration: factory, multicall, multi-hop, WETH9",
  },
  {
    name: "security",
    globs: ["test/security/*.test.ts"],
    description: "pool-level invariants and dynamic-fee guarantees",
  },
  {
    name: "integration",
    globs: ["test/integration/*.test.ts"],
    description: "end-to-end smoke tests",
  },
  {
    name: "simparity",
    globs: ["test/simparity/*.test.ts"],
    description: "bit-exact parity vs the Rust simulator",
    notes: "requires cargo (Rust ≥ 1.74)",
  },
  {
    name: "all",
    globs: [
      "test/integration/*.test.ts",
      "test/liquidity/*.test.ts",
      "test/math/*.test.ts",
      "test/periphery/*.test.ts",
      "test/security/*.test.ts",
      "test/simparity/*.test.ts",
    ],
    description: "everything in test/ (incl. integration + liquidity + simparity)",
    notes: "requires cargo for simparity",
  },
];

// The globs we use are all `test/<dir>/*.test.ts` — expand them locally so
// we can hand concrete file paths to hardhat (spawn() does not invoke a
// shell, so glob characters are not expanded for us).
function expandGlobs(globs: string[]): string[] {
  const files: string[] = [];
  for (const glob of globs) {
    const dir = path.resolve(REPO_ROOT, path.dirname(glob));
    if (!fs.existsSync(dir)) continue;
    const matches = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".test.ts"))
      .sort()
      .map((f) => path.join(path.dirname(glob), f));
    files.push(...matches);
  }
  return files;
}

function countTestFiles(globs: string[]): number {
  return expandGlobs(globs).length;
}

function printMenu(): void {
  const nameWidth = Math.max(...SECTIONS.map((s) => s.name.length));
  console.log("Pick a test suite to run:\n");
  SECTIONS.forEach((section, idx) => {
    const num = (idx + 1).toString().padStart(2);
    const name = section.name.padEnd(nameWidth);
    const fileCount = countTestFiles(section.globs);
    const plural = fileCount === 1 ? "" : "s";
    const filesTag = fileCount > 0 ? ` [${fileCount} file${plural}]` : "";
    const note = section.notes ? `  ‹${section.notes}›` : "";
    console.log(`  ${num}) ${name}  ${section.description}${filesTag}${note}`);
  });
  console.log();
}

function resolveSelection(input: string): Section | null {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return SECTIONS[0];
  const numeric = Number.parseInt(trimmed, 10);
  if (Number.isFinite(numeric) && String(numeric) === trimmed && numeric >= 1 && numeric <= SECTIONS.length) {
    return SECTIONS[numeric - 1];
  }
  return SECTIONS.find((s) => s.name === trimmed) ?? null;
}

async function promptForSection(): Promise<Section> {
  if (!process.stdin.isTTY) {
    console.log("[test] non-interactive stdin; running 'default' suite");
    return SECTIONS[0];
  }
  printMenu();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    while (true) {
      const answer = await new Promise<string>((resolve) => rl.question("Enter choice [1]: ", resolve));
      const section = resolveSelection(answer);
      if (section !== null) return section;
      console.log(`Unknown choice: ${answer.trim()}. Try a number 1-${SECTIONS.length} or a section name.\n`);
    }
  } finally {
    rl.close();
  }
}

function runHardhat(files: string[]): Promise<number> {
  const args = ["hardhat", "test", "--show-stack-traces", "--typecheck", ...files];
  console.log(`\n$ npx ${args.join(" ")}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, { stdio: "inherit", cwd: REPO_ROOT });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const positional = process.argv.slice(2).find((a) => !a.startsWith("-"));

  let section: Section | null;
  if (positional === undefined) {
    section = await promptForSection();
  } else {
    section = resolveSelection(positional);
    if (section === null) {
      console.error(`Unknown section: ${positional}`);
      console.error(`Valid: ${SECTIONS.map((s) => s.name).join(", ")} or 1..${SECTIONS.length}`);
      process.exit(2);
    }
  }

  const files = expandGlobs(section.globs);
  if (files.length === 0) {
    console.error(`No test files matched section '${section.name}'.`);
    process.exit(2);
  }

  const noteSuffix = section.notes ? ` (${section.notes})` : "";
  console.log(`→ '${section.name}' — ${files.length} test file(s)${noteSuffix}`);
  process.exit(await runHardhat(files));
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
