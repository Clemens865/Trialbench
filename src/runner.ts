import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRequest, callTarget } from "./adapters.js";
import { loadRubric } from "./config.js";
import { combine, grade, graderId, isDeterministic } from "./graders.js";
import { Judge } from "./judge.js";
import type { Case, Config, GradeResult, GraderSpec, Rubric, RunMeta, Suite, TargetResult, TrialRecord } from "./types.js";
import { mapLimit, runCommand, sha256, shortHash, TargetError } from "./util.js";
import { cleanupWorkspace, finishWorkspace, prepareWorkspace, workspaceEnv, type PreparedWorkspace } from "./workspace.js";

export const HARNESS_VERSION: string = (() => {
  try {
    const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return JSON.parse(readFileSync(pkg, "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
})();

export interface RunOptions {
  trials?: number;
  concurrency?: number;
  label?: string;
  /** Continue an interrupted run: completed trials are kept, the rest are run. */
  resumeRunId?: string;
  /** Only run cases with at least one of these tags. */
  tags?: string[];
  /** Only run these case ids. */
  caseIds?: string[];
  /** Skip LLM judges (their grades are recorded as SKIPPED). */
  noJudge?: boolean;
  /** Bypass the judge cache. */
  noCache?: boolean;
  /** Keep every trial's workspace on disk (paths are in the trial records). */
  keepWorkspaces?: boolean;
  onTrial?: (record: TrialRecord, done: number, total: number) => void;
}

export interface RunResult {
  runId: string;
  runDir: string;
  meta: RunMeta;
  records: TrialRecord[];
}

export function runDirFor(config: Config, suite: string, runId: string): string {
  return join(config.runsDir, suite, runId);
}

export function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${ts}-${shortHash(Math.random()).slice(0, 6)}`;
}

async function gitCommit(cwd: string): Promise<string | undefined> {
  try {
    const r = await runCommand("git rev-parse --short HEAD && git status --porcelain | head -1", { cwd, timeoutMs: 5000 });
    if (r.code !== 0) return undefined;
    const [commit, dirty] = r.stdout.split("\n");
    return commit ? `${commit}${dirty ? "-dirty" : ""}` : undefined;
  } catch {
    return undefined;
  }
}

export function readTrials(runDir: string): TrialRecord[] {
  const file = join(runDir, "trials.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as TrialRecord);
}

export function readMeta(runDir: string): RunMeta {
  return JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8")) as RunMeta;
}

export async function runSuite(suite: Suite, config: Config, opts: RunOptions = {}): Promise<RunResult> {
  const suiteDir = dirname(suite.file);
  const trials = opts.trials ?? suite.trials ?? config.defaults.trials;
  const concurrency = opts.concurrency ?? suite.concurrency ?? config.defaults.concurrency;
  const retries = suite.retries ?? config.defaults.retries;
  const timeoutMs = suite.timeoutMs ?? config.defaults.timeoutMs;

  const runId = opts.resumeRunId ?? newRunId();
  const runDir = runDirFor(config, suite.suite, runId);
  mkdirSync(runDir, { recursive: true });
  const trialsFile = join(runDir, "trials.jsonl");

  const previous = opts.resumeRunId ? readTrials(runDir).filter((r) => r.termination !== "infra_error") : [];
  const done = new Set(previous.map((r) => `${r.caseId}\u0000${r.trial}`));
  if (opts.resumeRunId) {
    // Rewrite without the infra-error lines we're about to retry, so each (case, trial) appears once.
    writeFileSync(trialsFile, previous.map((r) => JSON.stringify(r) + "\n").join(""));
  }

  const meta: RunMeta = opts.resumeRunId
    ? readMeta(runDir)
    : {
        schemaVersion: 1,
        runId,
        suite: suite.suite,
        suiteFile: suite.file,
        startedAt: new Date().toISOString(),
        harnessVersion: HARNESS_VERSION,
        trials,
        judge: config.judge,
        ...(opts.label ? { label: opts.label } : {}),
      };
  if (!opts.resumeRunId) {
    const commit = await gitCommit(suiteDir);
    if (commit) meta.gitCommit = commit;
    writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  }

  const cases = suite.cases.filter(
    (c) => (!opts.tags?.length || c.tags?.some((t) => opts.tags!.includes(t))) && (!opts.caseIds?.length || opts.caseIds.includes(c.id)),
  );
  const jobs: { c: Case; trial: number }[] = [];
  for (const c of cases) for (let t = 1; t <= trials; t++) if (!done.has(`${c.id}\u0000${t}`)) jobs.push({ c, trial: t });

  const judge = opts.noJudge ? undefined : new Judge(config.judge, opts.noCache ? undefined : config.cacheDir);
  const rubricCache = new Map<string, Rubric>();
  const getRubric = (id: string) => {
    if (!rubricCache.has(id)) rubricCache.set(id, loadRubric(id, config));
    return rubricCache.get(id)!;
  };
  // Fail fast on missing rubrics instead of discovering them mid-run.
  for (const c of cases) for (const g of [...(suite.graders ?? []), ...(c.graders ?? [])]) if (g.type === "judge") getRubric(g.rubric);

  const targetHash = shortHash(suite.target);
  const total = jobs.length + previous.length;
  let completed = previous.length;
  const records: TrialRecord[] = [...previous];

  await mapLimit(jobs, concurrency, async ({ c, trial }) => {
    // A case grader with the same id replaces the suite-wide one (e.g. a looser length limit for one case).
    const caseIds = new Set((c.graders ?? []).map((g) => g.id).filter(Boolean));
    const graders: GraderSpec[] = [...(suite.graders ?? []).filter((g) => !g.id || !caseIds.has(g.id)), ...(c.graders ?? [])];
    const startedAt = new Date();
    let attempts = 0;
    let result: TargetResult | undefined;
    let termination: TrialRecord["termination"] = "completed";
    let error: string | undefined;

    const wsSpec = suite.workspace || c.workspace ? { ...suite.workspace, ...c.workspace } : undefined;
    let ws: PreparedWorkspace | undefined;
    const attemptErrors: string[] = [];
    for (;;) {
      attempts++;
      try {
        if (wsSpec) ws = await prepareWorkspace(wsSpec, config.root, c.id);
        result = await callTarget(c.target ?? suite.target, buildRequest(c, trial, ws?.dir, workspaceEnv(wsSpec)), config.root, timeoutMs);
        if (ws && wsSpec) result.workspace = await finishWorkspace(ws, wsSpec, config.root);
        break;
      } catch (err) {
        if (err instanceof TargetError) {
          termination = "target_error";
          error = err.message;
          // Even a failed agent may have changed files worth seeing.
          if (ws && wsSpec) {
            try {
              result = { output: "", workspace: await finishWorkspace(ws, wsSpec, config.root) };
            } catch {
              /* best effort */
            }
          }
          break;
        }
        if (ws && !(wsSpec?.keep || opts.keepWorkspaces)) cleanupWorkspace(ws.dir);
        ws = undefined;
        attemptErrors.push(`attempt ${attempts}: ${(err as Error).message}`.slice(0, 500));
        if (attempts > retries) {
          termination = "infra_error";
          error = (err as Error).message;
          break;
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** (attempts - 1)));
      }
    }
    const targetMs = Date.now() - startedAt.getTime();

    let grades: GradeResult[] = [];
    let verdict: TrialRecord["verdict"];
    let score: number | undefined;
    if (termination === "completed" && result) {
      const ctx = { case: c, result, config, suiteDir: config.root, durationMs: targetMs, env: workspaceEnv(wsSpec), ...(judge ? { judge } : {}), loadRubric: getRubric };
      const indexed = graders.map((g, i) => ({ g, i }));
      const cheap = indexed.filter(({ g }) => isDeterministic(g));
      const costly = indexed.filter(({ g }) => !isDeterministic(g));
      const cheapGrades = await Promise.all(cheap.map(({ g, i }) => grade(g, i, ctx)));
      const failedGate = suite.threshold === undefined && cheapGrades.some((g) => g.gate && g.verdict === "FAIL");
      const costlyGrades = await Promise.all(
        costly.map(({ g, i }) =>
          failedGate || !judge
            ? Promise.resolve<GradeResult>({
                graderId: graderId(g, i),
                type: g.type,
                weight: g.weight ?? 1,
                gate: g.gate ?? true,
                verdict: "SKIPPED",
                evidence: failedGate ? "skipped: a deterministic gate already failed" : "skipped: judges disabled",
              })
            : grade(g, i, ctx),
        ),
      );
      // Keep the suite's grader order in the record.
      const byIndex = new Map<number, GradeResult>();
      cheap.forEach(({ i }, k) => byIndex.set(i, cheapGrades[k]!));
      costly.forEach(({ i }, k) => byIndex.set(i, costlyGrades[k]!));
      grades = indexed.map(({ i }) => byIndex.get(i)!);
      if (wsSpec?.protect?.length && result.workspace) {
        const t = result.workspace.tampered;
        grades.unshift({
          graderId: "tamper",
          type: "tamper",
          verdict: t.length ? "FAIL" : "PASS",
          score: t.length ? 0 : 1,
          weight: 1,
          gate: true,
          evidence: t.length ? `agent modified protected files: ${t.join(", ")}` : "protected files untouched",
        });
      }
      ({ verdict, score } = combine(grades, suite.threshold));
    } else if (termination === "target_error") {
      verdict = "FAIL";
      score = 0;
    } else {
      verdict = "ERROR";
    }

    const record: TrialRecord = {
      schemaVersion: 1,
      runId,
      suite: suite.suite,
      caseId: c.id,
      trial,
      ...(c.cluster ? { cluster: c.cluster } : {}),
      ...(c.tags ? { tags: c.tags } : {}),
      hashes: {
        case: shortHash({ input: c.input, reference: c.reference ?? null }),
        target: targetHash,
        graders: shortHash(graders),
        harness: HARNESS_VERSION,
      },
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
      termination,
      attempts,
      ...(error ? { error } : {}),
      ...(attemptErrors.length && termination !== "infra_error" ? { attemptErrors } : termination === "infra_error" && attemptErrors.length > 1 ? { attemptErrors: attemptErrors.slice(0, -1) } : {}),
      ...(result ? { result } : {}),
      grades,
      ...(score !== undefined ? { score } : {}),
      verdict,
    };
    if (ws && !(wsSpec?.keep || opts.keepWorkspaces)) cleanupWorkspace(ws.dir);
    appendFileSync(trialsFile, JSON.stringify(record) + "\n");
    records.push(record);
    completed++;
    opts.onTrial?.(record, completed, total);
  });

  meta.finishedAt = new Date().toISOString();
  writeFileSync(join(runDir, "meta.json"), JSON.stringify(meta, null, 2));
  records.sort((a, b) => (a.caseId === b.caseId ? a.trial - b.trial : a.caseId < b.caseId ? -1 : 1));
  return { runId, runDir, meta, records };
}

/** Hash that identifies a suite's cases; compare runs only when it matches. */
export function datasetHash(records: readonly TrialRecord[]): string {
  const perCase = [...new Map(records.map((r) => [r.caseId, r.hashes.case])).entries()].sort();
  return sha256(perCase).slice(0, 12);
}

