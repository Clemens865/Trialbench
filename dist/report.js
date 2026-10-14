import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { datasetHash } from "./runner.js";
import { correctForJudge, summarize, wilson } from "./stats.js";
/** Item-level pass rates. Only PASS/FAIL trials count; UNKNOWN/ERROR are excluded and reported separately. */
export function perItemScores(records) {
    const items = new Map();
    for (const r of records) {
        const it = items.get(r.caseId) ?? { ...(r.cluster ? { cluster: r.cluster } : {}), ...(r.tags ? { tags: r.tags } : {}), scores: [] };
        if (r.verdict === "PASS" || r.verdict === "FAIL")
            it.scores.push(r.verdict === "PASS" ? 1 : 0);
        items.set(r.caseId, it);
    }
    return items;
}
function percentile(xs, p) {
    if (xs.length === 0)
        return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
export function analyze(meta, records) {
    const items = perItemScores(records);
    const summary = summarize([...items.entries()].map(([id, it]) => ({ id, ...(it.cluster ? { cluster: it.cluster } : {}), scores: it.scores })));
    const verdicts = { PASS: 0, FAIL: 0, UNKNOWN: 0, ERROR: 0 };
    const terminations = { completed: 0, target_error: 0, infra_error: 0 };
    for (const r of records) {
        verdicts[r.verdict]++;
        terminations[r.termination]++;
    }
    const gmap = new Map();
    for (const r of records)
        for (const g of r.grades) {
            const s = gmap.get(g.graderId) ?? { graderId: g.graderId, type: g.type, pass: 0, fail: 0, unknown: 0, error: 0, skipped: 0, passRate: 0, ci: { low: 0, high: 1 } };
            if (g.verdict === "PASS")
                s.pass++;
            else if (g.verdict === "FAIL")
                s.fail++;
            else if (g.verdict === "UNKNOWN")
                s.unknown++;
            else if (g.verdict === "ERROR")
                s.error++;
            else
                s.skipped++;
            gmap.set(g.graderId, s);
        }
    const graders = [...gmap.values()].map((s) => ({ ...s, passRate: s.pass + s.fail ? s.pass / (s.pass + s.fail) : Number.NaN, ci: wilson(s.pass, s.pass + s.fail) }));
    const tagNames = [...new Set([...items.values()].flatMap((it) => it.tags ?? []))].sort();
    const tags = tagNames.map((tag) => {
        const sub = [...items.entries()].filter(([, it]) => it.tags?.includes(tag)).map(([id, it]) => ({ id, scores: it.scores }));
        const s = summarize(sub);
        return { tag, nItems: s.nItems, mean: s.mean, ci: s.ci };
    });
    const failingCases = [...items.entries()]
        .filter(([, it]) => it.scores.length && it.scores.some((x) => x === 0))
        .map(([caseId, it]) => {
        const failed = records.find((r) => r.caseId === caseId && r.verdict === "FAIL");
        const firstFail = failed?.grades.find((g) => g.verdict === "FAIL");
        const evidence = firstFail ? `${firstFail.graderId}: ${firstFail.evidence ?? ""}` : failed?.error;
        return {
            caseId,
            passRate: it.scores.reduce((a, b) => a + b, 0) / it.scores.length,
            trials: it.scores.length,
            ...(evidence ? { firstEvidence: evidence } : {}),
        };
    })
        .sort((a, b) => a.passRate - b.passRate || (a.caseId < b.caseId ? -1 : 1));
    let targetUsd = 0;
    let judgeUsd = 0;
    let judgeCalls = 0;
    let judgeCached = 0;
    for (const r of records) {
        targetUsd += r.result?.usage?.costUsd ?? 0;
        for (const g of r.grades)
            if (g.judge) {
                judgeCalls++;
                if (g.judge.cached)
                    judgeCached++;
                judgeUsd += g.judge.costUsd ?? 0;
            }
    }
    const durations = records.map((r) => r.durationMs);
    const start = meta.startedAt ? Date.parse(meta.startedAt) : Number.NaN;
    const end = meta.finishedAt ? Date.parse(meta.finishedAt) : Number.NaN;
    return {
        runId: meta.runId,
        suite: meta.suite,
        ...(meta.label ? { label: meta.label } : {}),
        datasetHash: datasetHash(records),
        summary,
        verdicts,
        terminations,
        excludedTrials: records.length - verdicts.PASS - verdicts.FAIL,
        graders,
        tags,
        failingCases,
        cost: { targetUsd, judgeUsd, judgeCalls, judgeCached },
        durationMs: { total: Number.isNaN(end - start) ? 0 : end - start, p50: percentile(durations, 0.5), p95: percentile(durations, 0.95) },
    };
}
export const pct = (x, digits = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(digits)}%` : "n/a");
export const ivl = (iv) => `[${pct(iv.low)}, ${pct(iv.high)}]`;
const usd = (x) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
export function headline(a) {
    const s = a.summary;
    return `${pct(s.mean)}  95% CI ${ivl(s.ci)}  (n=${s.nItems} items${s.clustered ? `, ${s.nClusters} clusters` : ""}, ${s.nTrials} trials)`;
}
export function formatText(a) {
    const s = a.summary;
    const lines = [
        `Suite ${a.suite}  ·  run ${a.runId}${a.label ? `  ·  ${a.label}` : ""}`,
        "",
        `  Pass rate   ${headline(a)}`,
    ];
    if (s.passAtK && s.passPowK) {
        lines.push(`  Reliability pass@${s.passAtK.k} ${pct(s.passAtK.value)}  ·  pass^${s.passPowK.k} ${pct(s.passPowK.value)}  ·  consistency ${pct(s.consistency ?? Number.NaN, 0)}`);
    }
    lines.push(`  Detectable  changes smaller than ±${pct(s.mde)} are within noise for this suite (paired A/B, 80% power)`);
    if (a.excludedTrials) {
        lines.push(`  Excluded    ${a.excludedTrials} trial(s): ${a.verdicts.UNKNOWN} unknown, ${a.verdicts.ERROR} error (${a.terminations.infra_error} infra)`);
    }
    if (a.terminations.target_error)
        lines.push(`  Crashes     ${a.terminations.target_error} trial(s) where the target itself failed (scored FAIL)`);
    lines.push("", "  Graders");
    if (!a.graders.length)
        lines.push("    (none ran: every trial ended before grading)");
    for (const g of a.graders) {
        const extra = [g.unknown && `${g.unknown} unknown`, g.error && `${g.error} error`, g.skipped && `${g.skipped} skipped`].filter(Boolean).join(", ");
        lines.push(`    ${g.graderId.padEnd(28)} ${pct(g.passRate).padStart(6)}  ${ivl(g.ci).padEnd(18)} ${g.pass}/${g.pass + g.fail}${extra ? `  (${extra})` : ""}`);
    }
    if (a.tags.length) {
        lines.push("", "  By tag");
        for (const t of a.tags)
            lines.push(`    ${t.tag.padEnd(28)} ${pct(t.mean).padStart(6)}  ${ivl(t.ci).padEnd(18)} n=${t.nItems}`);
    }
    if (a.failingCases.length) {
        lines.push("", `  Failing cases (${a.failingCases.length})`);
        for (const f of a.failingCases.slice(0, 15)) {
            lines.push(`    ✗ ${f.caseId}  ${pct(f.passRate, 0)} of ${f.trials}${f.firstEvidence ? `  — ${f.firstEvidence.replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
        }
        if (a.failingCases.length > 15)
            lines.push(`    … and ${a.failingCases.length - 15} more (see report.md)`);
    }
    lines.push("", `  Cost        target ${usd(a.cost.targetUsd)}  ·  judge ${usd(a.cost.judgeUsd)} (${a.cost.judgeCalls} calls, ${a.cost.judgeCached} cached)`, `  Time        ${(a.durationMs.total / 1000).toFixed(1)}s total  ·  p50 ${(a.durationMs.p50 / 1000).toFixed(1)}s  ·  p95 ${(a.durationMs.p95 / 1000).toFixed(1)}s per trial`);
    return lines.join("\n");
}
export function formatMarkdown(a) {
    const s = a.summary;
    const md = [
        `## trialbench · ${a.suite}`,
        "",
        `**Pass rate: ${pct(s.mean)}** (95% CI ${ivl(s.ci)}, n=${s.nItems} items${s.clustered ? `, ${s.nClusters} clusters` : ""}, ${s.nTrials} trials)`,
        "",
        "| Metric | Value |",
        "|---|---|",
        `| Standard error | ${pct(s.se)} |`,
        ...(s.passAtK && s.passPowK ? [`| pass@${s.passAtK.k} / pass^${s.passPowK.k} | ${pct(s.passAtK.value)} / ${pct(s.passPowK.value)} |`] : []),
        `| Minimum detectable change | ±${pct(s.mde)} |`,
        `| Excluded trials (unknown / error) | ${a.verdicts.UNKNOWN} / ${a.verdicts.ERROR} |`,
        `| Cost (target / judge) | ${usd(a.cost.targetUsd)} / ${usd(a.cost.judgeUsd)} |`,
        `| Run | \`${a.runId}\`${a.label ? ` (${a.label})` : ""} · dataset \`${a.datasetHash}\` |`,
        "",
        "### Graders",
        "",
        "| Grader | Pass rate | 95% CI | Passed | Unknown | Error | Skipped |",
        "|---|---|---|---|---|---|---|",
        ...a.graders.map((g) => `| \`${g.graderId}\` | ${pct(g.passRate)} | ${ivl(g.ci)} | ${g.pass}/${g.pass + g.fail} | ${g.unknown} | ${g.error} | ${g.skipped} |`),
    ];
    if (a.tags.length) {
        md.push("", "### By tag", "", "| Tag | Pass rate | 95% CI | Items |", "|---|---|---|---|", ...a.tags.map((t) => `| ${t.tag} | ${pct(t.mean)} | ${ivl(t.ci)} | ${t.nItems} |`));
    }
    if (a.failingCases.length) {
        md.push("", `### Failing cases (${a.failingCases.length})`, "", "| Case | Pass rate | First failure |", "|---|---|---|", ...a.failingCases.map((f) => `| \`${f.caseId}\` | ${pct(f.passRate, 0)} of ${f.trials} | ${(f.firstEvidence ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 200)} |`));
    }
    return md.join("\n") + "\n";
}
export function writeReports(runDir, a) {
    writeFileSync(join(runDir, "summary.json"), JSON.stringify(a, null, 2));
    writeFileSync(join(runDir, "report.md"), formatMarkdown(a));
}
/**
 * For each judge grader whose rubric has a human-label validation, the pass rate corrected for the
 * judge's measured error (Rogan-Gladen). Warns when the validation is stale (rubric or model changed).
 */
export function judgeCorrections(records, readValidationFor) {
    const lines = [];
    const byGrader = new Map();
    for (const r of records)
        for (const g of r.grades) {
            if (!g.judge?.rubric || (g.verdict !== "PASS" && g.verdict !== "FAIL"))
                continue;
            const e = byGrader.get(g.graderId) ?? { rubric: g.judge.rubric, version: g.judge.rubricVersion, model: g.judge.model, pass: 0, n: 0 };
            e.n++;
            if (g.verdict === "PASS")
                e.pass++;
            byGrader.set(g.graderId, e);
        }
    for (const [id, e] of byGrader) {
        const v = readValidationFor(e.rubric);
        if (!v?.test) {
            lines.push(`    ${id.padEnd(28)} judge not validated against human labels yet (trialbench label / judge-check)`);
            continue;
        }
        if (v.rubricVersion !== e.version || v.model !== e.model) {
            lines.push(`    ${id.padEnd(28)} validation is stale (was ${v.model} on v${v.rubricVersion}; now ${e.model} on v${e.version}): re-run judge-check`);
            continue;
        }
        const c = correctForJudge(e.pass, e.n, v.test);
        lines.push(c.valid
            ? `    ${id.padEnd(28)} raw ${pct(c.raw)} → corrected ${pct(c.corrected)} ${ivl(c.ci)}  (judge TPR ${pct(v.test.tpr, 0)}, TNR ${pct(v.test.tnr, 0)}${v.gateEligible ? "" : ", NOT gate-eligible"})`
            : `    ${id.padEnd(28)} judge too close to random to correct (TPR ${pct(v.test.tpr, 0)}, TNR ${pct(v.test.tnr, 0)})`);
    }
    return lines.length ? ["", "  Judge accuracy (vs your labels)", ...lines] : [];
}
