import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/compare.js";
import { parseConfig } from "../src/config.js";
import { buildFeedback, failureModes } from "../src/feedback.js";
import { loadRun } from "../src/gate.js";
import { collectItems } from "../src/labels.js";
import { splitOf } from "../src/judgecheck.js";
import { runSuite } from "../src/runner.js";
import { taskFromCommit } from "../src/tasks.js";
import type { Suite, TrialRecord } from "../src/types.js";
import { validateSuite } from "../src/validate.js";

const rec = (caseId: string, trial: number, verdict: "PASS" | "FAIL", graderId = "equals:x", evidence = "got y"): TrialRecord => ({
  schemaVersion: 1,
  runId: "r",
  suite: "s",
  caseId,
  trial,
  hashes: { case: caseId, target: "t", graders: "g", harness: "0" },
  startedAt: new Date().toISOString(),
  durationMs: 1,
  termination: "completed",
  attempts: 1,
  result: { output: "out" },
  grades: [{ graderId, type: "equals", verdict, score: verdict === "PASS" ? 1 : 0, weight: 1, gate: true, evidence }],
  verdict,
});

describe("feedback", () => {
  it("groups failures by the grader that decided them and flags flaky cases", () => {
    const records = [rec("a", 1, "FAIL"), rec("a", 2, "PASS"), rec("b", 1, "FAIL"), rec("c", 1, "FAIL", "judge:tone"), rec("d", 1, "PASS")];
    const modes = failureModes(records);
    expect(modes.map((m) => [m.graderId, m.cases.size])).toEqual([["equals:x", 2], ["judge:tone", 1]]);
    const config = parseConfig({}, mkdtempSync(join(tmpdir(), "tb-fb-")));
    const md = buildFeedback(config, { schemaVersion: 1, runId: "r", suite: "s", suiteFile: "", startedAt: new Date().toISOString(), harnessVersion: "0", trials: 2, judge: config.judge }, records, undefined);
    expect(md).toContain("### 1. `equals:x`: 2 case(s)");
    expect(md).toContain("fail only sometimes (flaky): `a`");
    expect(md).toContain("Do **not** make the evals pass");
  });
});

describe("compare", () => {
  it("pairs two runs and reports flips", async () => {
    const root = mkdtempSync(join(tmpdir(), "tb-cmp-"));
    const config = parseConfig({}, root);
    const mk = (ok: string[]): Suite => ({
      suite: "c",
      file: join(root, "c.yaml"),
      target: { type: "noop" },
      cases: ["a", "b", "c"].map((id) => ({ id, input: id, graders: [{ type: "equals" as const, value: ok.includes(id) ? "" : "nope" }] })),
    });
    const a = await runSuite(mk(["a", "b"]), config);
    const b = await runSuite(mk(["a", "c"]), config);
    const c = compareRuns(loadRun(config, "c", a.runId), loadRun(config, "c", b.runId));
    expect(c.paired.regressions).toEqual(["b"]);
    expect(c.paired.improvements).toEqual(["c"]);
    expect(c.paired.diff).toBe(0);
  });
});

describe("labels and judge splits", () => {
  it("splits label ids deterministically, roughly 15/45/40", () => {
    const counts = { train: 0, dev: 0, test: 0 };
    for (let i = 0; i < 2000; i++) counts[splitOf(((i * 2654435761) >>> 0).toString(16).padStart(8, "0"))]++;
    expect(counts.train / 2000).toBeGreaterThan(0.1);
    expect(counts.dev / 2000).toBeGreaterThan(0.38);
    expect(counts.test / 2000).toBeGreaterThan(0.33);
    expect(splitOf("abcdef01")).toBe(splitOf("abcdef01"));
  });

  it("collects what the judge actually saw, once per distinct output", () => {
    const r = rec("a", 1, "PASS");
    r.grades = [{ graderId: "custom", type: "judge", verdict: "PASS", score: 1, weight: 1, gate: true, judge: { model: "m", provider: "p", promptHash: "h", rubric: "tone", rubricVersion: "1", cached: false, subject: "the summary" } }];
    const r2 = { ...r, trial: 2 };
    const items = collectItems([r, r2], "tone", new Map([["a", { input: "in" }]]));
    expect(items).toHaveLength(1);
    expect(items[0]!.output).toBe("the summary");
  });
});

describe("tasks from git + validate", () => {
  it("builds a task from a commit; the reference passes and doing nothing fails", async () => {
    const repo = mkdtempSync(join(tmpdir(), "tb-task-repo-"));
    const git = (c: string) => execSync(`git -c user.email=t@t -c user.name=t ${c}`, { cwd: repo, stdio: "pipe" });
    git("init -q");
    writeFileSync(join(repo, "math.mjs"), "export const add = (a, b) => a + b;\n");
    git("add -A");
    git("commit -qm base");
    writeFileSync(join(repo, "math.mjs"), "export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n");
    mkdirSync(join(repo, "tests"));
    writeFileSync(join(repo, "tests", "mul.test.mjs"), 'import { mul } from "../math.mjs";\nprocess.exit(mul(3, 4) === 12 ? 0 : 1);\n');
    git("add -A");
    git("commit -qm 'Add mul'");

    const root = mkdtempSync(join(tmpdir(), "tb-task-evals-"));
    const t = await taskFromCommit({ repo, commit: "HEAD", root, id: "mul", testCmd: "node tests/mul.test.mjs" });
    expect(t.testFiles).toEqual(["tests/mul.test.mjs"]);
    expect(t.instruction).toContain("Add mul.");
    expect(t.instruction).toContain('import { mul } from "../math.mjs";');

    const config = parseConfig({ defaults: { retries: 0 } }, root);
    const suite: Suite = {
      suite: "tasks",
      file: join(root, "suites", "tasks.yaml"),
      target: { type: "noop" },
      cases: [
        {
          id: "mul",
          input: t.instruction,
          metadata: { oracle: "tasks/mul/oracle.patch" },
          workspace: { git: { repo, ref: "HEAD~1" }, hidden: [{ from: "tasks/mul/hidden" }] },
          graders: [{ type: "command", cmd: "node tests/mul.test.mjs" }],
        },
      ],
    };
    const [v] = await validateSuite(suite, config);
    expect(v!.oracle).toBe("PASS");
    expect(v!.null).toBe("FAIL");
    expect(v!.status).toBe("ok");
  });
});
