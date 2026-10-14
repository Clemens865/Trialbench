// Coding tasks from git history (SWE-bench style).
//
// A commit that added a feature together with its tests becomes a task:
//   - the workspace starts at the commit's PARENT (the feature doesn't exist yet),
//   - the agent gets an instruction (the commit message plus the public API the tests use),
//   - the commit's test files are HIDDEN: copied in only after the agent stops,
//   - grading runs those tests; the commit itself (minus tests) is the reference solution.
// `trialbench validate` then checks each task: the reference must pass and doing nothing must fail.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { runCommand } from "./util.js";

export interface TaskFromCommitOptions {
  repo: string;
  commit: string;
  /** Where evals live (the folder with trialbench.config.yaml). */
  root: string;
  id?: string;
  /** Which of the commit's files are the hidden tests. Default: files that look like tests. */
  tests?: string[];
  /** Command that runs the hidden tests in the workspace. Default: guessed for cargo / npm projects. */
  testCmd?: string;
}

export interface TaskFromCommitResult {
  id: string;
  dir: string;
  testFiles: string[];
  testCmd: string;
  caseYaml: string;
  instruction: string;
}

const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.(rs|go|py)$|(^|\/)test_[^/]+\.py$/;

async function git(repo: string, args: string): Promise<string> {
  const r = await runCommand(`git ${args}`, { cwd: repo, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Best-effort default test command from the test files' locations. */
export function guessTestCmd(testFiles: string[], repo: string): string | undefined {
  const rust = testFiles.filter((f) => f.endsWith(".rs"));
  if (rust.length && existsSync(join(repo, "Cargo.toml"))) {
    const parts = rust
      .map((f) => /^(?:crates\/)?([^/]+)\/tests\/([^/]+)\.rs$/.exec(f) ?? /^tests\/([^/]+)\.rs$/.exec(f))
      .filter((m): m is RegExpExecArray => Boolean(m));
    if (parts.length) {
      const byCrate = new Map<string, string[]>();
      for (const m of parts) {
        const [crate, test] = m.length === 3 ? [m[1]!, m[2]!] : ["", m[1]!];
        byCrate.set(crate, [...(byCrate.get(crate) ?? []), test]);
      }
      return [...byCrate.entries()]
        .map(([crate, tests]) => `cargo test -q ${crate ? `-p ${crate} ` : ""}${tests.map((t) => `--test ${t}`).join(" ")}`)
        .join(" && ");
    }
  }
  const js = testFiles.filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
  if (js.length && existsSync(join(repo, "package.json"))) return `npx vitest run ${js.join(" ")}`;
  const py = testFiles.filter((f) => f.endsWith(".py"));
  if (py.length) return `python -m pytest -q ${py.join(" ")}`;
  return undefined;
}

/** The import lines of the test files: the public API the agent must provide, without revealing the tests. */
function apiLines(source: string): string[] {
  return source
    .split("\n")
    .filter((l) => /^\s*(use\s+[\w:{}, *]+;|import\s.+from\s|from\s+\S+\s+import\s)/.test(l))
    .map((l) => l.trim());
}

export async function taskFromCommit(opts: TaskFromCommitOptions): Promise<TaskFromCommitResult> {
  const repo = resolve(opts.repo);
  const commit = (await git(repo, `rev-parse --short ${opts.commit}`)).trim();
  const parent = (await git(repo, `rev-parse --short ${commit}^`)).trim();
  const subject = (await git(repo, `log -1 --format=%s ${commit}`)).trim();
  const body = (await git(repo, `log -1 --format=%b ${commit}`)).trim();
  const changed = (await git(repo, `diff --name-only ${parent} ${commit}`)).split("\n").filter(Boolean);
  const testFiles = opts.tests?.length ? changed.filter((f) => opts.tests!.some((t) => f === t || f.startsWith(t))) : changed.filter((f) => TEST_RE.test(f));
  if (!testFiles.length) throw new Error(`No test files found in ${commit}. Pass --tests <paths>.`);
  const testCmd = opts.testCmd ?? guessTestCmd(testFiles, repo);
  if (!testCmd) throw new Error("Could not guess how to run the tests. Pass --test-cmd.");

  const id = opts.id ?? `${commit}-${subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}`;
  const dir = join(opts.root, "tasks", id);
  mkdirSync(join(dir, "hidden"), { recursive: true });

  const apis = new Set<string>();
  const existedBefore: string[] = [];
  for (const f of testFiles) {
    const content = await git(repo, `show ${commit}:${f}`).catch(() => undefined);
    if (content === undefined) continue; // deleted by the commit
    const out = join(dir, "hidden", f);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, content);
    apiLines(content).forEach((l) => apis.add(l));
    if ((await runCommand(`git cat-file -e ${parent}:${f}`, { cwd: repo })).code === 0) existedBefore.push(f);
  }
  // Non-code files among the hidden tests (JSON, CSV, snapshots …) are fixtures the tests read.
  const fixtures = testFiles.filter((f) => !/\.(rs|ts|tsx|js|mjs|cjs|py|go|java|kt|rb|php|cs|swift)$/.test(f));
  const exclude = testFiles.map((f) => `':(exclude)${f}'`).join(" ");
  writeFileSync(join(dir, "oracle.patch"), await git(repo, `diff --binary ${parent} ${commit} -- . ${exclude}`));

  const instruction = [
    subject.endsWith(".") ? subject : `${subject}.`,
    body ? `\n${body}` : "",
    "\nImplement this in the repository. Hidden tests will check the behaviour afterwards.",
    apis.size ? `\nThe tests use this public API (it must exist and behave as described above):\n${[...apis].map((l) => `    ${l}`).join("\n")}` : "",
    `\nThe tests will be run with: ${testCmd}`,
    fixtures.length ? `Test fixtures the tests read are provided with the tests and will be in place when they run (${fixtures.join(", ")}); you don't need to create or regenerate them.` : "",
    existedBefore.length ? `\nDo not modify these existing test files: ${existedBefore.join(", ")}.` : "",
    "Run the build and the existing tests yourself before you finish.",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(join(dir, "task.md"), instruction + "\n");

  const relDir = relative(opts.root, dir);
  const caseObj = {
    id,
    tags: ["from-commit"],
    input: `file://../${relDir}/task.md`,
    metadata: { commit, parent, oracle: `${relDir}/oracle.patch` },
    workspace: {
      git: { repo: relative(opts.root, repo) || ".", ref: parent },
      hidden: [{ from: `${relDir}/hidden` }],
      ...(existedBefore.length ? { protect: existedBefore } : {}),
    },
    graders: [{ id: "hidden-tests", type: "command", cmd: testCmd }],
  };
  return { id, dir, testFiles, testCmd, caseYaml: YAML.stringify([caseObj]), instruction };
}
