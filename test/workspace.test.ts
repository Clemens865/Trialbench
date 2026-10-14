import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseClaudeStream } from "../src/adapters.js";
import { parseConfig } from "../src/config.js";
import { runSuite } from "../src/runner.js";
import type { GraderSpec, Suite } from "../src/types.js";
import { globToRegExp, prepareWorkspace } from "../src/workspace.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function setup(graders: GraderSpec[], input: string, extra: Partial<Suite> = {}) {
  const root = mkdtempSync(join(tmpdir(), "trialbench-ws-"));
  const config = parseConfig({ defaults: { timeoutMs: 20_000, retries: 0 } }, root);
  const suite: Suite = {
    suite: "ws",
    file: join(root, "suites", "ws.yaml"),
    target: { type: "exec", cmd: `node ${join(fixtures, "fake-agent.mjs")}` },
    workspace: {
      template: join(fixtures, "ws-template"),
      hidden: [{ from: join(fixtures, "ws-hidden") }],
      protect: ["RULES.md"],
    },
    cases: [{ id: "task", input, graders }],
    ...extra,
  };
  return { config, suite };
}

const hiddenCheck: GraderSpec = { type: "command", cmd: "node check.mjs", id: "hidden-tests" };

describe("workspaces", () => {
  it("a correct fix passes the hidden test; the diff shows only the agent's change", async () => {
    const { config, suite } = setup([hiddenCheck, { type: "files_changed", allow: ["src/**"], max: 1 }], "fix");
    const [r] = (await runSuite(suite, config)).records;
    expect(r!.verdict).toBe("PASS");
    expect(r!.result!.workspace!.changed).toEqual([{ status: "M", path: "src/math.mjs" }]);
    expect(r!.result!.workspace!.diff).toContain("a + b");
    expect(r!.result!.workspace!.diff).not.toContain("check.mjs"); // hidden files arrive after the diff
    expect(r!.grades.find((g) => g.graderId === "tamper")!.verdict).toBe("PASS");
  });

  it("doing nothing fails the hidden test", async () => {
    const { config, suite } = setup([hiddenCheck], "nothing");
    expect((await runSuite(suite, config)).records[0]!.verdict).toBe("FAIL");
  });

  it("modifying a protected file fails the trial via the automatic tamper grader", async () => {
    const { config, suite } = setup([], "cheat");
    const [r] = (await runSuite(suite, config)).records;
    expect(r!.verdict).toBe("FAIL");
    expect(r!.grades.find((g) => g.graderId === "tamper")!.evidence).toContain("RULES.md");
  });

  it("hidden files are not visible while the agent runs", async () => {
    const { config, suite } = setup([{ type: "equals", value: "no hidden test" }], "peek");
    expect((await runSuite(suite, config)).records[0]!.verdict).toBe("PASS");
  });

  it("every trial gets a fresh workspace, removed afterwards", async () => {
    const { config, suite } = setup([hiddenCheck], "fix");
    const res = await runSuite(suite, config, { trials: 3 });
    const dirs = res.records.map((r) => r.result!.workspace!.dir);
    expect(new Set(dirs).size).toBe(3);
    expect(dirs.some((d) => existsSync(d))).toBe(false);
  });

  it("file graders and tool_sequence", async () => {
    const { config, suite } = setup(
      [
        { type: "file_exists", path: "src/*.mjs" },
        { type: "file_contains", path: "src/math.mjs", values: ["a + b"] },
        { type: "file_contains", path: "**/*.mjs", pattern: "a - b", not: true },
        { type: "tool_sequence", names: ["Read", "Edit"], mode: "exact" },
        { type: "tool_used", name: "Edit" },
        { type: "budget", maxToolCalls: 5 },
      ],
      "fix",
      { workspace: { template: join(fixtures, "ws-template") } },
    );
    const [r] = (await runSuite(suite, config)).records;
    expect(r!.grades.map((g) => `${g.graderId}=${g.verdict}`)).toEqual([
      "file_exists:src/*.mjs=PASS",
      "file_contains:src/math.mjs=PASS",
      "file_contains:**/*.mjs=PASS",
      "tool_sequence:exact=PASS",
      "tool_used:Edit=PASS",
      "budget=PASS",
    ]);
  });

  it("git workspaces check out the ref and drop later history", async () => {
    const repo = mkdtempSync(join(tmpdir(), "trialbench-repo-"));
    const git = (cmd: string) => execSync(`git -c user.email=t@t -c user.name=t ${cmd}`, { cwd: repo, stdio: "pipe" }).toString().trim();
    git("init -q");
    writeFileSync(join(repo, "a.txt"), "v1");
    git("add -A");
    git("commit -qm one");
    const first = git("rev-parse HEAD");
    writeFileSync(join(repo, "a.txt"), "v2 (the answer)");
    git("commit -qam two");
    const ws = await prepareWorkspace({ git: { repo, ref: first } }, repo, "g");
    const log = execSync("git log --all --oneline", { cwd: ws.dir }).toString();
    expect(log.trim().split("\n")).toHaveLength(1);
    expect(execSync("cat a.txt", { cwd: ws.dir }).toString()).toBe("v1");
  });
});

describe("helpers", () => {
  it("globToRegExp", () => {
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/x/a.ts")).toBe(false);
    expect(globToRegExp("src/**/*.ts").test("src/x/y/a.ts")).toBe(true);
    expect(globToRegExp("**/test_*.py").test("test_a.py")).toBe(true);
  });

  it("parseClaudeStream extracts tool calls, results, the answer and cost", () => {
    const lines = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.ts" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "file body" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "rm x" } }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "denied", is_error: true }] } },
      { type: "result", subtype: "success", is_error: false, result: "Fixed it.", total_cost_usd: 0.12, num_turns: 3, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } },
    ].map((l) => JSON.stringify(l));
    const p = parseClaudeStream(lines.join("\n"));
    expect(p.result).toBe("Fixed it.");
    expect(p.toolCalls.map((c) => c.name)).toEqual(["Read", "Bash"]);
    expect(p.toolCalls[0]!.result).toBe("file body");
    expect((p.toolCalls[1] as { error?: boolean }).error).toBe(true);
    expect(p.costUsd).toBe(0.12);
    expect(p.turns).toBe(3);
    expect(p.inputTokens).toBe(100);
  });
});
