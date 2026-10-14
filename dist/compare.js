// Compare two runs of the same suite: is B better than A, and where exactly?
// Paired on case ids (Miller 2024): each case is its own control, which removes case difficulty
// from the noise and makes small differences detectable with far fewer cases.
import { ivl, pct } from "./report.js";
import { comparePaired } from "./stats.js";
export function compareRuns(a, b) {
    const paired = comparePaired(a.items, b.items);
    const ga = new Map(a.analysis.graders.map((g) => [g.graderId, g.passRate]));
    const graders = b.analysis.graders
        .filter((g) => ga.has(g.graderId))
        .map((g) => ({ graderId: g.graderId, a: ga.get(g.graderId), b: g.passRate, delta: g.passRate - ga.get(g.graderId) }))
        .filter((g) => Number.isFinite(g.delta));
    return { a: a.analysis, b: b.analysis, paired, graders, sameDataset: a.analysis.datasetHash === b.analysis.datasetHash };
}
const name = (x) => `${x.runId}${x.label ? ` (${x.label})` : ""}`;
const signed = (x) => `${x >= 0 ? "+" : ""}${pct(x)}`;
const usd = (x) => `$${x.toFixed(2)}`;
export function formatComparison(c) {
    const p = c.paired;
    const verdict = p.pValue < 0.05 ? (p.diff > 0 ? "B is significantly BETTER" : "B is significantly WORSE") : "No significant difference";
    const lines = [
        `A  ${name(c.a)}`,
        `B  ${name(c.b)}`,
        "",
        `  ${verdict}: ${pct(p.meanA)} → ${pct(p.meanB)}  (${signed(p.diff)}, 95% CI ${ivl(p.ci)}, p=${p.pValue.toFixed(3)}, ${p.n} paired cases)`,
        `  Correlation between runs ${p.correlation.toFixed(2)}: pairing ${p.correlation > 0.2 ? "removes a lot of noise here" : "helps little here"}.`,
    ];
    if (!c.sameDataset)
        lines.push(`  ! The suites differ; only the ${p.n} shared cases are compared (${p.onlyInA.length} only in A, ${p.onlyInB.length} only in B).`);
    if (p.pValue >= 0.05 && Math.abs(p.diff) > 0)
        lines.push(`  To confirm a difference this size, add cases or trials: this suite detects about ±${pct(c.b.summary.mde)}.`);
    if (p.regressions.length)
        lines.push("", `  Worse in B (${p.regressions.length}): ${p.regressions.join(", ")}`);
    if (p.improvements.length)
        lines.push(`  Better in B (${p.improvements.length}): ${p.improvements.join(", ")}`);
    const moved = c.graders.filter((g) => Math.abs(g.delta) >= 0.005).sort((x, y) => x.delta - y.delta);
    if (moved.length) {
        lines.push("", "  Graders that moved");
        for (const g of moved)
            lines.push(`    ${g.graderId.padEnd(30)} ${pct(g.a).padStart(6)} → ${pct(g.b).padStart(6)}  ${signed(g.delta)}`);
    }
    lines.push("", `  Cost   A ${usd(c.a.cost.targetUsd + c.a.cost.judgeUsd)}  ·  B ${usd(c.b.cost.targetUsd + c.b.cost.judgeUsd)}`, `  Time   A p50 ${(c.a.durationMs.p50 / 1000).toFixed(1)}s  ·  B p50 ${(c.b.durationMs.p50 / 1000).toFixed(1)}s per trial`);
    return lines.join("\n");
}
