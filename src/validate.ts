// Self-validation of a suite (Agentic Benchmark Checklist; tau-bench's trivial-agent lesson):
//   - oracle run: each case's reference solution must PASS, otherwise the task or its graders are broken;
//   - null run:   doing nothing must FAIL, otherwise the task is trivially passable.
// A suite with broken or trivial cases produces confident, wrong numbers. Run this whenever you add tasks.

import { runSuite } from "./runner.js";
import type { Config, Suite } from "./types.js";

export interface CaseValidation {
  caseId: string;
  oracle?: "PASS" | "FAIL" | "ERROR" | "UNKNOWN" | "no-reference";
  null: "PASS" | "FAIL" | "ERROR" | "UNKNOWN";
  status: "ok" | "broken" | "trivial" | "unverified";
  detail?: string;
}

export async function validateSuite(suite: Suite, config: Config, opts: { caseIds?: string[]; concurrency?: number } = {}): Promise<CaseValidation[]> {
  const cases = suite.cases.filter((c) => !opts.caseIds?.length || opts.caseIds.includes(c.id));
  const withOracle = cases.filter((c) => typeof c.metadata?.oracle === "string");

  const base = { ...suite, cases, trials: 1 };
  const nullRun = await runSuite({ ...base, suite: `${suite.suite}.validate-null`, target: { type: "noop" } }, config, { noJudge: true, trials: 1, ...(opts.concurrency ? { concurrency: opts.concurrency } : {}) });
  const oracleRun = withOracle.length
    ? await runSuite(
        {
          ...base,
          suite: `${suite.suite}.validate-oracle`,
          cases: withOracle.map((c) => ({ ...c, target: { type: "patch" as const, patch: c.metadata!.oracle as string } })),
        },
        config,
        { noJudge: true, trials: 1, ...(opts.concurrency ? { concurrency: opts.concurrency } : {}) },
      )
    : undefined;

  return cases.map((c) => {
    const n = nullRun.records.find((r) => r.caseId === c.id)!;
    const o = oracleRun?.records.find((r) => r.caseId === c.id);
    const failing = (r: typeof n) => r.grades.filter((g) => g.verdict === "FAIL" || g.verdict === "ERROR").map((g) => `${g.graderId}: ${(g.evidence ?? "").slice(0, 160)}`).join("; ") || r.error;
    let status: CaseValidation["status"];
    let detail: string | undefined;
    if (o && o.verdict !== "PASS") {
      status = "broken";
      detail = `reference solution does not pass: ${failing(o)}`;
    } else if (n.verdict === "PASS") {
      status = "trivial";
      detail = "doing nothing already passes: the graders don't check the task";
    } else if (!o) {
      status = "unverified";
      detail = "no reference solution (metadata.oracle) to prove the task is solvable";
    } else status = "ok";
    return { caseId: c.id, oracle: o ? o.verdict : "no-reference", null: n.verdict, status, ...(detail ? { detail } : {}) };
  });
}
