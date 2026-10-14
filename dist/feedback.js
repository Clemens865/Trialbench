// FEEDBACK.md: a run turned into something development can act on.
//
// The eval report answers "how good is it?". This answers "what should we fix?":
// failures are grouped by failure mode (not listed case by case), each with concrete examples,
// flaky cases are separated from consistent failures, and changes vs the baseline are explicit.
// It ends with instructions for whoever fixes it, human or coding agent, including the most
// important one from the eval literature: fix root causes, don't make the evals pass.
import { loadBaseline } from "./gate.js";
import { analyze, ivl, perItemScores, pct } from "./report.js";
import { comparePaired, mean } from "./stats.js";
import { asText } from "./util.js";
const clipText = (s, n) => {
    const t = s.replace(/\r/g, "").trim();
    return t.length > n ? `${t.slice(0, n)}\n… (${t.length - n} more chars)` : t;
};
const fence = (s, lang = "") => "```" + lang + "\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";
/** The grade that decided a failed trial: the first gating FAIL, else the first gating ERROR. */
function decidingGrade(r) {
    return r.grades.find((g) => g.gate && g.verdict === "FAIL") ?? r.grades.find((g) => g.gate && g.verdict === "ERROR");
}
export function failureModes(records) {
    const modes = new Map();
    for (const r of records) {
        if (r.verdict !== "FAIL")
            continue;
        const g = decidingGrade(r);
        const key = g ? g.graderId : r.termination === "target_error" ? "crash" : "unknown";
        const m = modes.get(key) ?? { key, graderId: g?.graderId ?? key, type: g?.type ?? r.termination, trials: [], cases: new Set() };
        m.trials.push(r);
        m.cases.add(r.caseId);
        modes.set(key, m);
    }
    return [...modes.values()].sort((a, b) => b.cases.size - a.cases.size || b.trials.length - a.trials.length);
}
function describeMode(m) {
    if (m.key === "crash")
        return "The code under test crashed (non-zero exit, exception or HTTP 4xx).";
    if (m.key === "tamper")
        return "The agent modified files it was told not to touch.";
    switch (m.type) {
        case "judge":
            return `The LLM judge failed the output on rubric \`${m.graderId.replace(/^judge:/, "")}\`.`;
        case "command":
            return `The check \`${m.graderId}\` (a script or hidden test) failed.`;
        case "files_changed":
            return "The agent changed files it should not have, or the wrong number of files.";
        case "tool_sequence":
        case "tool_used":
        case "tool_not_used":
            return "The agent's tool use differed from what the task requires.";
        case "budget":
            return "The run exceeded its budget (tool calls, turns, cost or time).";
        default:
            return `The deterministic check \`${m.graderId}\` failed.`;
    }
}
function inputOf(suite, caseId) {
    return suite?.cases.find((c) => c.id === caseId)?.input;
}
function example(r, g, suite, clip) {
    const lines = [`**\`${r.caseId}\`** · trial ${r.trial}${r.tags?.length ? ` · tags: ${r.tags.join(", ")}` : ""}`, ""];
    const input = inputOf(suite, r.caseId);
    if (input !== undefined)
        lines.push("Input:", fence(clipText(asText(input), clip)));
    if (r.result && r.result.output !== "" && r.result.output !== undefined)
        lines.push("Output:", fence(clipText(asText(r.result.output), clip)));
    if (r.error)
        lines.push(`Error: \`${r.error.slice(0, 300)}\``);
    if (g)
        lines.push(`Why it failed (\`${g.graderId}\`): ${(g.evidence ?? "").replace(/\s+/g, " ").slice(0, 600)}`);
    const calls = r.result?.toolCalls;
    if (calls?.length) {
        const seq = calls.map((c) => c.name + (c.error ? "✗" : "")).join(" → ");
        lines.push(`Tool calls (${calls.length}): ${seq.length > 400 ? `${seq.slice(0, 400)}…` : seq}`);
    }
    const ws = r.result?.workspace;
    if (ws) {
        lines.push(`Changed files: ${ws.changed.length ? ws.changed.map((c) => `${c.status} ${c.path}`).join(", ") : "(none)"}`);
        if (ws.tampered.length)
            lines.push(`Tampered: ${ws.tampered.join(", ")}`);
    }
    const u = r.result?.usage;
    if (u?.costUsd !== undefined || u?.turns !== undefined)
        lines.push(`Cost: $${(u.costUsd ?? 0).toFixed(3)}${u.turns !== undefined ? ` · ${u.turns} turns` : ""}`);
    return lines.join("\n");
}
export function buildFeedback(config, meta, records, suite, opts = {}) {
    const a = analyze(meta, records);
    const nEx = opts.examples ?? 3;
    const clip = opts.clip ?? 800;
    const s = a.summary;
    const out = [
        `# Eval feedback: ${meta.suite}`,
        "",
        `Run \`${meta.runId}\`${meta.label ? ` (${meta.label})` : ""} · ${new Date(meta.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC${meta.gitCommit ? ` · code at \`${meta.gitCommit}\`` : ""}`,
        "",
        "## Summary",
        "",
        `- **Pass rate ${pct(s.mean)}** (95% CI ${ivl(s.ci)}) over ${s.nItems} cases × ${meta.trials} trial(s).`,
    ];
    if (s.passPowK)
        out.push(`- **Reliability:** all ${s.passPowK.k} trials pass for ${pct(s.passPowK.value)} of cases (pass^${s.passPowK.k}).`);
    if (a.excludedTrials)
        out.push(`- **Not scored:** ${a.excludedTrials} trial(s) ended UNKNOWN or ERROR (see the end).`);
    out.push(`- Changes smaller than ±${pct(s.mde)} cannot be distinguished from noise with this suite.`);
    // vs baseline
    const base = loadBaseline(config, meta.suite, opts.baseline);
    const items = new Map();
    for (const [id, it] of perItemScores(records))
        if (it.scores.length)
            items.set(id, mean(it.scores));
    if (base && base.runId === meta.runId) {
        out.push("", "## Compared with the baseline", "", "This run is the current baseline.");
    }
    else if (base) {
        const c = comparePaired(new Map(Object.entries(base.items)), items);
        out.push("", "## Compared with the baseline", "");
        out.push(`Baseline \`${base.runId}\` scored ${pct(c.meanA)} on the ${c.n} shared cases; this run scores ${pct(c.meanB)} (${c.diff >= 0 ? "+" : ""}${pct(c.diff)}, 95% CI ${ivl(c.ci)}, p=${c.pValue.toFixed(3)}). ${c.pValue < 0.05 ? (c.diff < 0 ? "**This is a significant regression.**" : "This is a significant improvement.") : "Not statistically significant."}`);
        if (c.regressions.length)
            out.push("", `**Got worse (${c.regressions.length}):** ${c.regressions.map((id) => `\`${id}\` ${pct(base.items[id], 0)}→${pct(items.get(id), 0)}`).join(", ")}`);
        if (c.improvements.length)
            out.push("", `**Got better (${c.improvements.length}):** ${c.improvements.map((id) => `\`${id}\``).join(", ")}`);
        if (c.onlyInB.length)
            out.push("", `New cases (no baseline yet): ${c.onlyInB.map((id) => `\`${id}\``).join(", ")}`);
    }
    // failure modes
    const modes = failureModes(records);
    const perCase = perItemScores(records);
    out.push("", "## What to fix", "");
    if (!modes.length)
        out.push("No failures in this run. 🎉 Consider adding harder cases: a suite that always passes can't detect regressions.");
    modes.forEach((m, i) => {
        const flaky = [...m.cases].filter((id) => {
            const sc = perCase.get(id)?.scores ?? [];
            return sc.includes(1) && sc.includes(0);
        });
        out.push(`### ${i + 1}. \`${m.graderId}\`: ${m.cases.size} case(s), ${m.trials.length} failed trial(s)`, "", describeMode(m), flaky.length ? `\n${flaky.length} of these case(s) fail only sometimes (flaky): ${flaky.map((id) => `\`${id}\``).join(", ")}. Look for ambiguity in the prompt or non-determinism, not a hard bug.` : "", "", `Affected: ${[...m.cases].map((id) => `\`${id}\``).join(", ")}`, "");
        const shown = new Set();
        for (const r of m.trials) {
            if (shown.size >= nEx)
                break;
            if (shown.has(r.caseId))
                continue; // one example per case: variety beats repetition
            shown.add(r.caseId);
            out.push(example(r, decidingGrade(r), suite, clip), "");
        }
    });
    // non-gating signals
    const softFails = a.graders.filter((g) => g.fail > 0 && !records.some((r) => r.grades.some((x) => x.graderId === g.graderId && x.gate)));
    if (softFails.length) {
        out.push("## Report-only checks that failed", "", "These don't decide pass/fail (`gate: false`) but are worth a look:", "");
        for (const g of softFails) {
            out.push(`- \`${g.graderId}\`: ${g.fail} of ${g.pass + g.fail} failed`);
            const ex = records.find((r) => r.grades.some((x) => x.graderId === g.graderId && x.verdict === "FAIL"));
            const gr = ex?.grades.find((x) => x.graderId === g.graderId && x.verdict === "FAIL");
            if (ex && gr)
                out.push(`  - e.g. \`${ex.caseId}\`: ${(gr.evidence ?? "").replace(/\s+/g, " ").slice(0, 900)}`);
        }
        out.push("");
    }
    // excluded
    const excluded = records.filter((r) => r.verdict === "UNKNOWN" || r.verdict === "ERROR");
    if (excluded.length) {
        out.push("## Not scored", "", "Fix these first if there are many: they hide results.", "");
        for (const r of excluded.slice(0, 10)) {
            const g = r.grades.find((x) => x.verdict === "ERROR" || x.verdict === "UNKNOWN");
            out.push(`- \`${r.caseId}\` #${r.trial}: ${r.verdict}${r.termination === "infra_error" ? " (infrastructure)" : ""}: ${(r.error ?? g?.evidence ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
        }
        out.push("");
    }
    // cost
    if (a.cost.targetUsd > 0) {
        const costly = [...records].filter((r) => r.result?.usage?.costUsd).sort((x, y) => (y.result.usage.costUsd ?? 0) - (x.result.usage.costUsd ?? 0)).slice(0, 3);
        out.push("## Cost", "", `Target $${a.cost.targetUsd.toFixed(2)} · judge $${a.cost.judgeUsd.toFixed(2)} · ${(a.durationMs.total / 1000).toFixed(0)}s. Most expensive trials: ${costly.map((r) => `\`${r.caseId}\` $${r.result.usage.costUsd.toFixed(3)}`).join(", ")}.`, "");
    }
    out.push("## How to use this feedback", "", "If you hand this to a coding agent, include these instructions:", "", "> 1. Work through the failure modes in order: the first affects the most cases.", "> 2. Fix the **root cause** behind each mode, not the individual cases. Read the examples to understand the pattern, then change the prompt, code or tooling so the whole class of failure goes away.", "> 3. Do **not** make the evals pass by special-casing these inputs, editing tests, graders or rubrics, or hard-coding expected outputs. The cases are a sample of real usage; the requirement is the behaviour, not the score.", "> 4. Keep existing behaviour that passes. After your change, re-run the suite and compare: " +
        `\`trialbench run ${meta.suite} -l <your-change>\` then \`trialbench gate ${meta.suite}\`.`, "> 5. If a failure looks like a wrong expectation rather than a bug, say so instead of changing the code: labels can be wrong.", "", opts.trialsPath ? `Full records (every input, output, tool call and grade): \`${opts.trialsPath}\`` : "");
    return out.filter((l, i, arr) => !(l === "" && arr[i - 1] === "")).join("\n") + "\n";
}
