import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { asText, getPath, runCommand, stableStringify } from "./util.js";
import { globToRegExp, listFiles, matchesAny } from "./workspace.js";
/** Deterministic graders are free; judges cost money. Run cheap ones first. */
export const isDeterministic = (g) => g.type !== "judge";
export function graderId(g, index) {
    if (g.id)
        return g.id;
    switch (g.type) {
        case "judge":
            return g.file ? `judge:${g.rubric}@${g.file}` : `judge:${g.rubric}`;
        case "tool_used":
        case "tool_not_used":
            return `${g.type}:${g.name}`;
        case "file_exists":
        case "file_contains":
            return `${g.type}:${g.path}`;
        case "tool_sequence":
            return `tool_sequence:${g.mode ?? "in_order"}`;
        case "files_changed":
        case "budget":
            return g.type;
        default:
            return "path" in g && g.path ? `${g.type}:${g.path}` : `${g.type}#${index}`;
    }
}
const binary = (pass, evidence) => ({
    verdict: pass ? "PASS" : "FAIL",
    score: pass ? 1 : 0,
    evidence,
});
/** RegExp that also accepts a leading Python/PCRE-style inline flag group like (?i) or (?is). */
export function compileRegex(pattern, flags = "") {
    const inline = /^\(\?([imsu]+)\)/.exec(pattern);
    const body = inline ? pattern.slice(inline[0].length) : pattern;
    return new RegExp(body, [...new Set([...flags, ...(inline?.[1] ?? "")])].join(""));
}
function needWorkspace(ctx) {
    if (!ctx.result.workspace)
        throw new Error("this grader needs a workspace: add `workspace:` to the suite");
    return ctx.result.workspace;
}
const clip = (s, n = 200) => (s.length > n ? `${s.slice(0, n)}…` : s);
export async function grade(spec, index, ctx) {
    const base = {
        graderId: graderId(spec, index),
        type: spec.type,
        weight: spec.weight ?? 1,
        gate: spec.gate ?? true,
    };
    try {
        return { ...base, ...(await gradeInner(spec, ctx)) };
    }
    catch (err) {
        return { ...base, verdict: "ERROR", evidence: `grader error: ${err.message}` };
    }
}
async function gradeInner(spec, ctx) {
    const out = ctx.result.output;
    const value = (path) => getPath(out, path);
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
            const m = compileRegex(spec.pattern, spec.flags).exec(text);
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
                }
                catch {
                    return binary(false, "output is not valid JSON");
                }
            }
            const parsed = z.fromJSONSchema(spec.schema).safeParse(v);
            return binary(parsed.success, parsed.success ? "valid" : parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
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
            // With a workspace it runs there (that's where hidden tests live); `cwd` is relative to it.
            const ws = ctx.result.workspace?.dir;
            const res = await runCommand(spec.cmd, {
                cwd: spec.cwd ? resolve(ws ?? ctx.suiteDir, spec.cwd) : (ws ?? ctx.suiteDir),
                env: { ...ctx.env, ...(ws ? { TRIALBENCH_WORKSPACE: ws } : {}) },
                input: JSON.stringify({ case: ctx.case, result: ctx.result }),
                timeoutMs: spec.timeoutMs ?? 60_000,
            });
            if (res.timedOut)
                return { verdict: "ERROR", evidence: "command timed out" };
            return binary(res.code === 0, clip((res.stdout + res.stderr).trim() || `exit ${res.code}`, 500));
        }
        case "file_exists": {
            const ws = needWorkspace(ctx);
            const hits = listFiles(ws.dir).filter((f) => globToRegExp(spec.path).test(f));
            const min = spec.min ?? 1;
            const pass = hits.length >= min && (spec.max === undefined || hits.length <= spec.max);
            return binary(pass, `${hits.length} file(s) match ${spec.path}${hits.length ? `: ${hits.slice(0, 5).join(", ")}` : ""}`);
        }
        case "file_contains": {
            const ws = needWorkspace(ctx);
            const hits = listFiles(ws.dir).filter((f) => globToRegExp(spec.path).test(f));
            if (!hits.length)
                return binary(Boolean(spec.not), `no file matches ${spec.path}`);
            const re = spec.pattern ? compileRegex(spec.pattern, spec.ignoreCase ? "i" : "") : undefined;
            const check = (text) => {
                const hay = spec.ignoreCase ? text.toLowerCase() : text;
                const vals = (spec.values ?? []).map((v) => (spec.ignoreCase ? v.toLowerCase() : v));
                const found = vals.filter((v) => hay.includes(v));
                const valuesOk = !vals.length || (spec.all ? found.length === vals.length : found.length > 0);
                return valuesOk && (!re || re.test(text));
            };
            // Positive: some matching file satisfies it. Negative (`not`): no matching file does.
            const matching = hits.filter((f) => check(readFileSync(join(ws.dir, f), "utf8")));
            const pass = spec.not ? matching.length === 0 : matching.length > 0;
            return binary(pass, spec.not ? (matching.length ? `found in ${matching.join(", ")}` : "not found") : matching.length ? `found in ${matching.join(", ")}` : `not found in ${hits.slice(0, 5).join(", ")}`);
        }
        case "files_changed": {
            const ws = needWorkspace(ctx);
            const paths = ws.changed.map((c) => c.path);
            const forbidden = spec.forbid?.length ? paths.filter((p) => matchesAny(p, spec.forbid)) : [];
            const outside = spec.allow?.length ? paths.filter((p) => !matchesAny(p, spec.allow)) : [];
            const n = paths.length;
            const countOk = n >= (spec.min ?? 0) && (spec.max === undefined || n <= spec.max);
            const problems = [
                forbidden.length && `changed forbidden ${forbidden.join(", ")}`,
                outside.length && `changed outside allowed paths: ${outside.join(", ")}`,
                !countOk && `${n} files changed (want ${spec.min ?? 0}..${spec.max ?? "∞"})`,
            ].filter(Boolean);
            return binary(problems.length === 0, problems.length ? problems.join("; ") : `${n} file(s) changed: ${paths.slice(0, 8).join(", ")}`);
        }
        case "tool_sequence": {
            const names = calls.map((c) => c.name);
            const want = spec.names;
            const mode = spec.mode ?? "in_order";
            let pass;
            if (mode === "exact")
                pass = names.length === want.length && names.every((n, i) => n === want[i]);
            else if (mode === "any_order")
                pass = want.every((w) => names.includes(w));
            else {
                let i = 0;
                for (const n of names)
                    if (n === want[i])
                        i++;
                pass = i === want.length;
            }
            return binary(pass, `called: ${names.join(" → ") || "(no tools)"}`);
        }
        case "budget": {
            const u = ctx.result.usage ?? {};
            const over = [
                spec.maxToolCalls !== undefined && calls.length > spec.maxToolCalls && `${calls.length} tool calls > ${spec.maxToolCalls}`,
                spec.maxTurns !== undefined && (u.turns ?? 0) > spec.maxTurns && `${u.turns} turns > ${spec.maxTurns}`,
                spec.maxCostUsd !== undefined && (u.costUsd ?? 0) > spec.maxCostUsd && `$${(u.costUsd ?? 0).toFixed(3)} > $${spec.maxCostUsd}`,
                spec.maxDurationMs !== undefined && (ctx.durationMs ?? 0) > spec.maxDurationMs && `${ctx.durationMs}ms > ${spec.maxDurationMs}ms`,
            ].filter(Boolean);
            return binary(over.length === 0, over.length ? over.join("; ") : `${calls.length} tool calls, ${u.turns ?? "?"} turns, $${(u.costUsd ?? 0).toFixed(3)}`);
        }
        case "judge": {
            if (!ctx.judge)
                return { verdict: "ERROR", evidence: "no judge configured" };
            const rubric = ctx.loadRubric(spec.rubric);
            let judged = value(spec.path);
            if (spec.file) {
                const ws = needWorkspace(ctx);
                const hit = listFiles(ws.dir).find((f) => globToRegExp(spec.file).test(f));
                if (!hit)
                    return { verdict: "FAIL", score: 0, evidence: `no file matches ${spec.file} to judge` };
                judged = `File ${hit}:\n${readFileSync(join(ws.dir, hit), "utf8").slice(0, 60_000)}`;
            }
            const o = await ctx.judge.evaluate(rubric, { input: ctx.case.input, output: judged, ...(ctx.case.reference !== undefined ? { reference: ctx.case.reference } : {}) }, spec.model);
            return {
                verdict: o.verdict,
                ...(o.verdict === "PASS" ? { score: 1 } : o.verdict === "FAIL" ? { score: 0 } : {}),
                evidence: o.error ? `judge error: ${o.error}` : clip(`${o.reasoning} ${o.evidence.length ? `Evidence: ${o.evidence.map((e) => `"${e}"`).join(" ")}` : ""}`.trim(), 1500),
                judge: {
                    model: o.model,
                    provider: o.provider,
                    promptHash: o.promptHash,
                    rubric: rubric.id,
                    rubricVersion: rubric.version,
                    subject: asText(judged).slice(0, 20_000),
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
export function combine(all, threshold) {
    const grades = all.filter((g) => g.verdict !== "SKIPPED");
    const scored = grades.filter((g) => g.score !== undefined);
    const totalW = scored.reduce((s, g) => s + g.weight, 0);
    const score = totalW > 0 ? scored.reduce((s, g) => s + g.weight * g.score, 0) / totalW : undefined;
    const withScore = (verdict) => ({ verdict, ...(score !== undefined ? { score } : {}) });
    const gating = grades.filter((g) => g.gate);
    if (gating.length === 0)
        return withScore("UNKNOWN");
    if (threshold !== undefined) {
        const gs = gating.filter((g) => g.score !== undefined);
        const w = gs.reduce((s, g) => s + g.weight, 0);
        if (w === 0)
            return withScore(gating.some((g) => g.verdict === "ERROR") ? "ERROR" : "UNKNOWN");
        const gScore = gs.reduce((s, g) => s + g.weight * g.score, 0) / w;
        return { verdict: gScore >= threshold ? "PASS" : "FAIL", score: gScore };
    }
    // A definite FAIL wins over uncertainty: the trial failed no matter what an erroring grader would say.
    if (gating.some((g) => g.verdict === "FAIL"))
        return withScore("FAIL");
    if (gating.some((g) => g.verdict === "ERROR"))
        return withScore("ERROR");
    if (gating.some((g) => g.verdict === "UNKNOWN"))
        return withScore("UNKNOWN");
    return withScore("PASS");
}
