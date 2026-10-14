import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { gate, saveBaseline } from "../src/gate.js";
import { analyze } from "../src/report.js";
import { readTrials, runSuite } from "../src/runner.js";
import type { Suite } from "../src/types.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function setup(overrides: Partial<Suite> = {}) {
  const root = mkdtempSync(join(tmpdir(), "trialbench-"));
  const config = parseConfig({ defaults: { timeoutMs: 1000, retries: 1, concurrency: 4 } }, root);
  const suite: Suite = {
    suite: "t",
    file: join(root, "suites", "t.yaml"),
    target: { type: "function", module: join(fixtures, "fn-target.mjs") },
    graders: [],
    cases: [
      { id: "upper", input: "abc", graders: [{ type: "equals", value: "ABC" }] },
      { id: "wrong", input: "abc", graders: [{ type: "equals", value: "nope" }] },
    ],
    ...overrides,
  };
  return { root, config, suite };
}

describe("runSuite", () => {
  it("runs K trials per case and writes one JSONL record per trial", async () => {
    const { config, suite } = setup();
    const res = await runSuite(suite, config, { trials: 3 });
    expect(res.records).toHaveLength(6);
    expect(readTrials(res.runDir)).toHaveLength(6);
    const a = analyze(res.meta, res.records);
    expect(a.summary.mean).toBeCloseTo(0.5, 10);
    expect(a.summary.passAtK?.k).toBe(3);
    expect(a.failingCases.map((f) => f.caseId)).toEqual(["wrong"]);
    expect(a.cost.targetUsd).toBeCloseTo(0.006, 10);
  });

  it("scores a crashing target as FAIL and never retries it", async () => {
    const { config, suite } = setup({ cases: [{ id: "crash", input: "crash", graders: [{ type: "equals", value: "x" }] }] });
    const [r] = (await runSuite(suite, config)).records;
    expect(r!.termination).toBe("target_error");
    expect(r!.verdict).toBe("FAIL");
    expect(r!.attempts).toBe(1);
  });

  it("retries infra errors (timeouts) and excludes them when retries run out", async () => {
    const { config, suite } = setup({
      cases: [
        { id: "flaky", input: "flaky", graders: [{ type: "equals", value: "FLAKY" }] },
        { id: "slow", input: "slow", graders: [{ type: "equals", value: "SLOW" }] },
      ],
    });
    const res = await runSuite(suite, config, { concurrency: 1 });
    const flaky = res.records.find((r) => r.caseId === "flaky")!;
    const slow = res.records.find((r) => r.caseId === "slow")!;
    expect(flaky.verdict).toBe("PASS");
    expect(flaky.attempts).toBe(2);
    expect(slow.termination).toBe("infra_error");
    expect(slow.verdict).toBe("ERROR");
    const a = analyze(res.meta, res.records);
    expect(a.summary.nItems).toBe(1); // the infra-error item is excluded, not counted as a failure
    expect(a.excludedTrials).toBe(1);
  }, 20_000);

  it("works with exec targets, including plain-text stdout and non-zero exits", async () => {
    const { config, suite } = setup({
      target: { type: "exec", cmd: `node ${join(fixtures, "exec-target.mjs")}` },
      cases: [
        { id: "json", input: "hi", graders: [{ type: "equals", value: "echo:hi" }] },
        { id: "plain", input: "plain", graders: [{ type: "contains", values: ["plain text"] }] },
        { id: "exit1", input: "exit1", graders: [{ type: "equals", value: "x" }] },
      ],
    });
    const res = await runSuite(suite, config);
    const by = Object.fromEntries(res.records.map((r) => [r.caseId, r]));
    expect(by.json!.verdict).toBe("PASS");
    expect(by.plain!.verdict).toBe("PASS");
    expect(by.exit1!.termination).toBe("target_error");
    expect(by.exit1!.error).toContain("Error: invalid input");
  });

  it("skips judges when a deterministic gate already failed, and with --no-judge", async () => {
    const { config, suite } = setup({
      cases: [{ id: "c", input: "abc", graders: [{ type: "equals", value: "nope" }, { type: "judge", rubric: "r" }] }],
    });
    // A rubric is required to exist; write one.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(config.rubricsDir, { recursive: true });
    writeFileSync(join(config.rubricsDir, "r.yaml"), "id: r\nversion: 1\nname: n\npass: p\nfail: f\n");
    const [r] = (await runSuite(suite, config)).records;
    expect(r!.grades.find((x) => x.type === "judge")!.verdict).toBe("SKIPPED");
    expect(r!.verdict).toBe("FAIL");
  });

  it("fails fast when a rubric is missing", async () => {
    const { config, suite } = setup({ cases: [{ id: "c", input: "a", graders: [{ type: "judge", rubric: "missing" }] }] });
    await expect(runSuite(suite, config)).rejects.toThrow(/Rubric "missing" not found/);
  });

  it("resumes an interrupted run without redoing completed trials", async () => {
    const { config, suite } = setup();
    const first = await runSuite(suite, config, { trials: 2, caseIds: ["upper"] });
    const resumed = await runSuite(suite, config, { trials: 2, resumeRunId: first.runId });
    expect(resumed.records).toHaveLength(4);
    const lines = readFileSync(join(first.runDir, "trials.jsonl"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(new Set(lines.map((l) => { const r = JSON.parse(l); return `${r.caseId}#${r.trial}`; })).size).toBe(4);
  });
});

describe("gate", () => {
  it("passes against its own baseline and fails --strict on a regression", async () => {
    const { config, suite } = setup();
    await runSuite(suite, config, { trials: 1 });
    saveBaseline(config, "t", undefined);
    expect(gate(config, "t").exitCode).toBe(0);

    const broken: Suite = { ...suite, cases: suite.cases.map((c) => (c.id === "upper" ? { ...c, graders: [{ type: "equals", value: "x" }] } : c)) };
    await new Promise((r) => setTimeout(r, 20)); // distinct mtime for "latest run"
    await runSuite(broken, config, { trials: 1 });
    const loose = gate(config, "t");
    expect(loose.exitCode).toBe(0); // 1 of 2 items: not statistically significant
    expect(loose.comparison?.regressions).toEqual(["upper"]);
    expect(gate(config, "t", { strict: true }).exitCode).toBe(1);
  });

  it("gates on the CI lower bound, not the point estimate", async () => {
    const { config, suite } = setup({ cases: Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, input: "a", graders: [{ type: "equals" as const, value: "A" }] })) });
    await runSuite(suite, config);
    // 10/10 passes: point estimate 100%, but the Wilson lower bound is ~72%.
    expect(gate(config, "t", { minPass: 0.7 }).exitCode).toBe(0);
    expect(gate(config, "t", { minPass: 0.9 }).exitCode).toBe(1);
  });
});
