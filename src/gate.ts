import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyze, ivl, perItemScores, pct, type RunAnalysis } from "./report.js";
import { readMeta, readTrials, runDirFor } from "./runner.js";
import { comparePaired, mean, type PairedComparison } from "./stats.js";
import type { Config } from "./types.js";

export interface Baseline {
  schemaVersion: 1;
  suite: string;
  runId: string;
  label?: string;
  createdAt: string;
  datasetHash: string;
  /** Per-item pass rate (mean over PASS/FAIL trials). */
  items: Record<string, number>;
  mean: number;
}

export const EXIT = { PASS: 0, FAIL: 1, INFRA: 2 } as const;

export function baselinePath(config: Config, suite: string, name = "main"): string {
  return join(config.root, "baselines", suite, `${name}.json`);
}

/** Run ids of a suite, newest first. */
export function listRunIds(config: Config, suite: string): string[] {
  const dir = join(config.runsDir, suite);
  if (!existsSync(dir)) return [];
  const runs = readdirSync(dir).filter((d) => existsSync(join(dir, d, "meta.json")));
  runs.sort((a, b) => statSync(join(dir, b, "meta.json")).mtimeMs - statSync(join(dir, a, "meta.json")).mtimeMs);
  return runs;
}

export function latestRunId(config: Config, suite: string): string | undefined {
  return listRunIds(config, suite)[0];
}

/** Load a run; "id1,id2" pools several runs of the same suite into one (e.g. 5 + 10 trials). */
export function loadRun(
  config: Config,
  suite: string,
  runId?: string,
): { runId: string; analysis: RunAnalysis; items: Map<string, number>; graderHashes: Map<string, string> } {
  const id = runId ?? latestRunId(config, suite);
  if (!id) throw new Error(`No runs found for suite "${suite}" in ${config.runsDir}. Run \`trialbench run ${suite}\` first.`);
  const ids = id.split(",").map((s) => s.trim()).filter(Boolean);
  const records = ids.flatMap((rid, k) => {
    const dir = runDirFor(config, suite, rid);
    if (!existsSync(join(dir, "meta.json"))) throw new Error(`Run ${rid} not found in ${dir}`);
    // Keep trials distinct when pooling: trial numbers continue across runs.
    return readTrials(dir).map((r) => ({ ...r, trial: r.trial + k * 1000 }));
  });
  const meta = readMeta(runDirFor(config, suite, ids[0]!));
  const analysis = analyze(ids.length > 1 ? { ...meta, runId: ids.join("+"), label: `${ids.length} runs pooled` } : meta, records);
  const items = new Map<string, number>();
  for (const [caseId, it] of perItemScores(records)) if (it.scores.length) items.set(caseId, mean(it.scores));
  const graderHashes = new Map(records.map((r) => [r.caseId, r.hashes.graders]));
  return { runId: id, analysis, items, graderHashes };
}

export function saveBaseline(config: Config, suite: string, runId: string | undefined, name = "main"): { path: string; baseline: Baseline } {
  const run = loadRun(config, suite, runId);
  const baseline: Baseline = {
    schemaVersion: 1,
    suite,
    runId: run.runId,
    ...(run.analysis.label ? { label: run.analysis.label } : {}),
    createdAt: new Date().toISOString(),
    datasetHash: run.analysis.datasetHash,
    items: Object.fromEntries([...run.items.entries()].sort()),
    mean: run.analysis.summary.mean,
  };
  const path = baselinePath(config, suite, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
  return { path, baseline };
}

export function loadBaseline(config: Config, suite: string, name = "main"): Baseline | undefined {
  const p = baselinePath(config, suite, name);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Baseline) : undefined;
}

export interface GateOptions {
  runId?: string;
  baseline?: string;
  /** Require the lower 95% CI bound of the pass rate to be at least this (0..1). */
  minPass?: number;
  /** Significance level for "significant regression vs baseline". */
  alpha?: number;
  /** Fail on any item that got worse vs the baseline, significant or not (for small regression suites). */
  strict?: boolean;
  /** Fail with exit 2 if more than this share of trials are infra errors. */
  maxInfraErrorRate?: number;
}

export interface GateResult {
  exitCode: 0 | 1 | 2;
  lines: string[];
  comparison?: PairedComparison;
}

/**
 * CI gate. Rules (Miller 2024; Yan, "Product evals"; Husain & Shankar, evals FAQ):
 *  - absolute bar: gate on the CI lower bound, not the point estimate;
 *  - regression: fail only on a statistically significant paired drop vs the baseline;
 *  - infra noise: too many infra errors is exit 2, not a quality failure.
 */
export function gate(config: Config, suite: string, opts: GateOptions = {}): GateResult {
  const run = loadRun(config, suite, opts.runId);
  const a = run.analysis;
  const lines: string[] = [];
  let exitCode: 0 | 1 | 2 = EXIT.PASS;
  const alpha = opts.alpha ?? 0.05;

  const totalTrials = a.verdicts.PASS + a.verdicts.FAIL + a.verdicts.UNKNOWN + a.verdicts.ERROR;
  const infraRate = totalTrials ? a.terminations.infra_error / totalTrials : 0;
  if (infraRate > (opts.maxInfraErrorRate ?? 0.1)) {
    lines.push(`✗ infra   ${pct(infraRate)} of trials hit infrastructure errors (limit ${pct(opts.maxInfraErrorRate ?? 0.1)}): results are not trustworthy`);
    exitCode = EXIT.INFRA;
  }

  if (opts.minPass !== undefined) {
    const low = a.summary.ci.low;
    if (low >= opts.minPass) lines.push(`✓ bar     CI lower bound ${pct(low)} ≥ required ${pct(opts.minPass)}`);
    else {
      lines.push(`✗ bar     CI lower bound ${pct(low)} < required ${pct(opts.minPass)} (point estimate ${pct(a.summary.mean)}; more items narrow the CI)`);
      if (exitCode === EXIT.PASS) exitCode = EXIT.FAIL;
    }
  }

  const base = loadBaseline(config, suite, opts.baseline);
  let comparison: PairedComparison | undefined;
  if (!base) {
    lines.push(`· baseline none found (create one with \`trialbench baseline ${suite}\`)`);
  } else {
    comparison = comparePaired(new Map(Object.entries(base.items)), run.items);
    const c = comparison;
    if (base.datasetHash !== a.datasetHash) lines.push(`! dataset changed since baseline ${base.runId}; comparing the ${c.n} shared items only`);
    const sig = c.pValue < alpha;
    const delta = `${c.diff >= 0 ? "+" : ""}${pct(c.diff)} (95% CI ${ivl(c.ci)}, p=${c.pValue.toFixed(3)}, n=${c.n})`;
    if (c.diff < 0 && sig) {
      lines.push(`✗ baseline significant regression vs ${base.runId}: ${delta}`);
      if (exitCode === EXIT.PASS) exitCode = EXIT.FAIL;
    } else if (c.diff > 0 && sig) lines.push(`✓ baseline significant improvement vs ${base.runId}: ${delta}`);
    else lines.push(`✓ baseline no significant change vs ${base.runId}: ${delta}`);
    if (c.regressions.length) {
      lines.push(`  regressed  ${c.regressions.join(", ")}`);
      if (opts.strict) {
        lines.push(`✗ strict  ${c.regressions.length} item(s) got worse than the baseline`);
        if (exitCode === EXIT.PASS) exitCode = EXIT.FAIL;
      }
    }
    if (c.improvements.length) lines.push(`  improved   ${c.improvements.join(", ")}`);
  }
  return { exitCode, lines, ...(comparison ? { comparison } : {}) };
}
