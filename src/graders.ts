import { resolve } from "node:path";
import { z } from "zod";
import type { Judge } from "./judge.js";
import type { Case, Config, GradeResult, GraderSpec, Rubric, TargetResult, Verdict } from "./types.js";
import { asText, getPath, runCommand, stableStringify } from "./util.js";

export interface GradeContext {
  case: Case;
  result: TargetResult;
  config: Config;
  suiteDir: string;
  judge?: Judge;
  loadRubric: (id: string) => Rubric;
}

/** Deterministic graders are free; judges cost money. Run cheap ones first. */
export const isDeterministic = (g: GraderSpec) => g.type !== "judge";

export function graderId(g: GraderSpec, index: number): string {
  if (g.id) return g.id;
  switch (g.type) {
    case "judge":
      return `judge:${g.rubric}`;
    case "tool_used":
    case "tool_not_used":
      return `${g.type}:${g.name}`;
    default:
      return "path" in g && g.path ? `${g.type}:${g.path}` : `${g.type}#${index}`;
  }
}

const binary = (pass: boolean, evidence: string): { verdict: Verdict; score: number; evidence: string } => ({
  verdict: pass ? "PASS" : "FAIL",
  score: pass ? 1 : 0,
  evidence,
});

const clip = (s: string, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);

export async function grade(spec: GraderSpec, index: number, ctx: GradeContext): Promise<GradeResult> {
  const base = {
    graderId: graderId(spec, index),
    type: spec.type,
    weight: spec.weight ?? 1,
    gate: spec.gate ?? true,
  };
  try {
    return { ...base, ...(await gradeInner(spec, ctx)) };
  } catch (err) {
    return { ...base, verdict: "ERROR", evidence: `grader error: ${(err as Error).message}` };
  }
}

async function gradeInner(spec: GraderSpec, ctx: GradeContext): Promise<Omit<GradeResult, "graderId" | "type" | "weight" | "gate">> {
  const out = ctx.result.output;
  const value = (path?: string) => getPath(out, path);
  const calls = ctx.result.toolCalls ?? [];

  switch (spec.type) {
    case "equals": {
      const v = value(spec.path);
      return binary(stableStringify(v) === stableStringify(spec.value), `got ${clip(asText(v))}`);
    }
    case "contains": {
      const text = asText(value(spec.path));
      const hay = spec.ignoreCase ? text.toLowerCase() : text;
      const found = spec.values.filter((s) => hay.includes(spec.ignoreCase ? s.toLowerCase() : s));
      const pass = spec.all ? found.length === spec.values.length : found.length > 0;
      const missing = spec.values.filter((s) => !found.includes(s));
      return binary(pass, pass ? `found ${found.join(", ")}` : `missing ${missing.join(", ")}`);
    }
    case "not_contains": {
      const text = asText(value(spec.path));
      const hay = spec.ignoreCase ? text.toLowerCase() : text;
      const found = spec.values.filter((s) => hay.includes(spec.ignoreCase ? s.toLowerCase() : s));
      return binary(found.length === 0, found.length ? `found forbidden ${found.join(", ")}` : "none found");
    }
    case "regex": {
      const text = asText(value(spec.path));
      // Accept a leading Python/PCRE-style inline flag group like (?i) or (?is).
      const inline = /^\(\?([imsu]+)\)/.exec(spec.pattern);
      const pattern = inline ? spec.pattern.slice(inline[0].length) : spec.pattern;
      const flags = [...new Set([...(spec.flags ?? ""), ...(inline?.[1] ?? "")])].join("");
      const m = new RegExp(pattern, flags).exec(text);
      return binary(m !== null, m ? `matched "${clip(m[0], 80)}"` : `no match for /${spec.pattern}/`);
    }
    case "max_length": {
      const len = asText(value(spec.path)).length;
      return binary(len <= spec.chars, `${len} chars (max ${spec.chars})`);
    }
    case "json_schema": {
      let v = value(spec.path);
      if (typeof v === "string") {
        try {
          v = JSON.parse(v);
        } catch {
          return binary(false, "output is not valid JSON");
        }
      }
      const parsed = z.fromJSONSchema(spec.schema as Parameters<typeof z.fromJSONSchema>[0]).safeParse(v);
      return binary(
        parsed.success,
        parsed.success ? "valid" : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      );
    }
    case "tool_used": {
      const n = calls.filter((c) => c.name === spec.name).length;
      const min = spec.min ?? 1;
      const pass = n >= min && (spec.max === undefined || n <= spec.max);
      return binary(pass, `${spec.name} called ${n}x (want ${min}..${spec.max ?? "∞"})`);
    }
    case "tool_not_used": {
      const n = calls.filter((c) => c.name === spec.name).length;
      return binary(n === 0, `${spec.name} called ${n}x`);
    }
    case "command": {
      // The command gets the case and the result as JSON on stdin; exit code 0 = PASS.
      const res = await runCommand(spec.cmd, {
        cwd: spec.cwd ? resolve(ctx.suiteDir, spec.cwd) : ctx.suiteDir,
        input: JSON.stringify({ case: ctx.case, result: ctx.result }),
        timeoutMs: spec.timeoutMs ?? 60_000,
      });
      if (res.timedOut) return { verdict: "ERROR", evidence: "command timed out" };
      return binary(res.code === 0, clip((res.stdout + res.stderr).trim() || `exit ${res.code}`, 500));
    }
    case "judge": {
      if (!ctx.judge) return { verdict: "ERROR", evidence: "no judge configured" };
      const rubric = ctx.loadRubric(spec.rubric);
      const o = await ctx.judge.evaluate(
        rubric,
        { input: ctx.case.input, output: value(spec.path), ...(ctx.case.reference !== undefined ? { reference: ctx.case.reference } : {}) },
        spec.model,
      );
      return {
        verdict: o.verdict,
        ...(o.verdict === "PASS" ? { score: 1 } : o.verdict === "FAIL" ? { score: 0 } : {}),
        evidence: o.error ? `judge error: ${o.error}` : clip(`${o.reasoning} ${o.evidence.length ? `Evidence: ${o.evidence.map((e) => `"${e}"`).join(" ")}` : ""}`.trim(), 1500),
        judge: {
          model: o.model,
          provider: o.provider,
          promptHash: o.promptHash,
          rubricVersion: rubric.version,
          cached: o.cached,
          ...(o.costUsd !== undefined ? { costUsd: o.costUsd } : {}),
        },
      };
    }
  }
}

/**
 * Combine grades into one trial verdict.
 * - Without a threshold: PASS only if every gating grader passed.
 * - With a threshold: PASS if the weighted score of gating graders >= threshold.
 * Otherwise FAIL beats ERROR beats UNKNOWN: we never guess a PASS from incomplete grades.
 */
export function combine(all: GradeResult[], threshold?: number): { verdict: Verdict; score?: number } {
  const grades = all.filter((g) => g.verdict !== "SKIPPED");
  const scored = grades.filter((g) => g.score !== undefined);
  const totalW = scored.reduce((s, g) => s + g.weight, 0);
  const score = totalW > 0 ? scored.reduce((s, g) => s + g.weight * g.score!, 0) / totalW : undefined;
  const withScore = (verdict: Verdict) => ({ verdict, ...(score !== undefined ? { score } : {}) });
  const gating = grades.filter((g) => g.gate);
  if (gating.length === 0) return withScore("UNKNOWN");
  if (threshold !== undefined) {
    const gs = gating.filter((g) => g.score !== undefined);
    const w = gs.reduce((s, g) => s + g.weight, 0);
    if (w === 0) return withScore(gating.some((g) => g.verdict === "ERROR") ? "ERROR" : "UNKNOWN");
    const gScore = gs.reduce((s, g) => s + g.weight * g.score!, 0) / w;
    return { verdict: gScore >= threshold ? "PASS" : "FAIL", score: gScore };
  }
  // A definite FAIL wins over uncertainty: the trial failed no matter what an erroring grader would say.
  if (gating.some((g) => g.verdict === "FAIL")) return withScore("FAIL");
  if (gating.some((g) => g.verdict === "ERROR")) return withScore("ERROR");
  if (gating.some((g) => g.verdict === "UNKNOWN")) return withScore("UNKNOWN");
  return withScore("PASS");
}
