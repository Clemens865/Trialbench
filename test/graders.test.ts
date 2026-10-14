import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { combine, grade, type GradeContext } from "../src/graders.js";
import type { GradeResult, GraderSpec, TargetResult } from "../src/types.js";

const config = parseConfig({}, "/tmp");
const ctx = (result: TargetResult): GradeContext => ({
  case: { id: "c1", input: "in" },
  result,
  config,
  suiteDir: "/tmp",
  loadRubric: () => {
    throw new Error("no rubrics in this test");
  },
});
const run = (spec: GraderSpec, result: TargetResult) => grade(spec, 0, ctx(result));

describe("deterministic graders", () => {
  it("equals with a path", async () => {
    expect((await run({ type: "equals", path: "a.b", value: 3 }, { output: { a: { b: 3 } } })).verdict).toBe("PASS");
    expect((await run({ type: "equals", value: { x: 1, y: 2 } }, { output: { y: 2, x: 1 } })).verdict).toBe("PASS");
    expect((await run({ type: "equals", value: 1 }, { output: 2 })).verdict).toBe("FAIL");
  });

  it("contains: any vs all, case-insensitive", async () => {
    expect((await run({ type: "contains", values: ["foo", "bar"] }, { output: "a FOO b" })).verdict).toBe("FAIL");
    expect((await run({ type: "contains", values: ["foo", "bar"], ignoreCase: true }, { output: "a FOO b" })).verdict).toBe("PASS");
    expect((await run({ type: "contains", values: ["foo", "bar"], all: true, ignoreCase: true }, { output: "a FOO b" })).verdict).toBe("FAIL");
  });

  it("not_contains, max_length", async () => {
    expect((await run({ type: "not_contains", values: ["As an AI"], ignoreCase: true }, { output: "as an ai model" })).verdict).toBe("FAIL");
    expect((await run({ type: "max_length", chars: 5 }, { output: "123456" })).verdict).toBe("FAIL");
  });

  it("regex supports a leading (?i) inline flag", async () => {
    expect((await run({ type: "regex", pattern: "(?i)^hello" }, { output: "HELLO world" })).verdict).toBe("PASS");
  });

  it("json_schema parses string output and validates", async () => {
    const schema = { type: "object", properties: { age: { type: "number", minimum: 0 } }, required: ["age"] };
    expect((await run({ type: "json_schema", schema }, { output: '{"age": 3}' })).verdict).toBe("PASS");
    expect((await run({ type: "json_schema", schema }, { output: '{"age": -1}' })).verdict).toBe("FAIL");
    expect((await run({ type: "json_schema", schema }, { output: "not json" })).verdict).toBe("FAIL");
  });

  it("tool_used counts calls; tool_not_used", async () => {
    const r: TargetResult = { output: "", toolCalls: [{ name: "search" }, { name: "search" }] };
    expect((await run({ type: "tool_used", name: "search", min: 2, max: 2 }, r)).verdict).toBe("PASS");
    expect((await run({ type: "tool_used", name: "search", max: 1 }, r)).verdict).toBe("FAIL");
    expect((await run({ type: "tool_not_used", name: "delete" }, r)).verdict).toBe("PASS");
  });

  it("command grader receives the case and result on stdin", async () => {
    const pass = await run({ type: "command", cmd: `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.exit(JSON.parse(s).result.output==='ok'?0:1))"` }, { output: "ok" });
    expect(pass.verdict).toBe("PASS");
  });

  it("a broken grader is ERROR, not FAIL", async () => {
    expect((await run({ type: "regex", pattern: "(" }, { output: "x" })).verdict).toBe("ERROR");
  });
});

const g = (verdict: GradeResult["verdict"], extra: Partial<GradeResult> = {}): GradeResult => ({
  graderId: "g",
  type: "equals",
  verdict,
  ...(verdict === "PASS" ? { score: 1 } : verdict === "FAIL" ? { score: 0 } : {}),
  weight: 1,
  gate: true,
  ...extra,
});

describe("combine", () => {
  it("FAIL beats ERROR beats UNKNOWN beats PASS", () => {
    expect(combine([g("PASS"), g("FAIL"), g("ERROR")]).verdict).toBe("FAIL");
    expect(combine([g("PASS"), g("ERROR"), g("UNKNOWN")]).verdict).toBe("ERROR");
    expect(combine([g("PASS"), g("UNKNOWN")]).verdict).toBe("UNKNOWN");
    expect(combine([g("PASS"), g("SKIPPED")]).verdict).toBe("PASS");
  });

  it("non-gating graders are reported but don't decide", () => {
    expect(combine([g("PASS"), g("FAIL", { gate: false })]).verdict).toBe("PASS");
  });

  it("threshold mode uses the weighted score", () => {
    const r = combine([g("PASS", { weight: 3 }), g("FAIL", { weight: 1 })], 0.7);
    expect(r.verdict).toBe("PASS");
    expect(r.score).toBeCloseTo(0.75, 10);
  });
});
