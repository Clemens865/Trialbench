// Compare two runs of the same suite: is B better than A, and where exactly?
// Paired on case ids (Miller 2024): each case is its own control, which removes case difficulty
// from the noise and makes small differences detectable with far fewer cases.

import { ivl, pct, type RunAnalysis } from "./report.js";
import { comparePaired, fisherExact, type PairedComparison } from "./stats.js";

export interface RunComparison {
  a: RunAnalysis;
  b: RunAnalysis;
  /** Trial-level pass/fail counts and Fisher exact p (all trials pooled). */
  trials: { passA: number; failA: number; passB: number; failB: number; pValue: number };
  paired: PairedComparison;
  graders: { graderId: string; a: number; b: number; delta: number }[];
  sameDataset: boolean;
  /** Cases whose graders differ between A and B: their difference may come from the eval, not the system. */
  graderChanged: string[];
}

type Loaded = { analysis: RunAnalysis; items: Map<string, number>; graderHashes?: Map<string, string> };

export function compareRuns(a: Loaded, b: Loaded): RunComparison {
  const paired = comparePaired(a.items, b.items);
  const ga = new Map(a.analysis.graders.map((g) => [g.graderId, g.passRate]));
  const graders = b.analysis.graders
    .filter((g) => ga.has(g.graderId))
    .map((g) => ({ graderId: g.graderId, a: ga.get(g.graderId)!, b: g.passRate, delta: g.passRate - ga.get(g.graderId)! }))
    .filter((g) => Number.isFinite(g.delta));
  const passA = a.analysis.verdicts.PASS;
  const failA = a.analysis.verdicts.FAIL;
  const passB = b.analysis.verdicts.PASS;
  const failB = b.analysis.verdicts.FAIL;
  return {
    a: a.analysis,
    b: b.analysis,
    paired,
    graders,
    trials: { passA, failA, passB, failB, pValue: fisherExact(passA, failA, passB, failB) },
    sameDataset: a.analysis.datasetHash === b.analysis.datasetHash,
    graderChanged: [...(a.graderHashes?.keys() ?? [])].filter((id) => b.graderHashes?.has(id) && b.graderHashes.get(id) !== a.graderHashes!.get(id)).sort(),
  };
}

const name = (x: RunAnalysis) => `${x.runId}${x.label ? ` (${x.label})` : ""}`;
const signed = (x: number) => `${x >= 0 ? "+" : ""}${pct(x)}`;
const usd = (x: number) => `$${x.toFixed(2)}`;

export function formatComparison(c: RunComparison): string {
  const p = c.paired;
  const verdict =
    p.pValue < 0.05 ? (p.diff > 0 ? "B is significantly BETTER" : "B is significantly WORSE") : "No significant difference";
  const lines = [
    `A  ${name(c.a)}`,
    `B  ${name(c.b)}`,
    "",
    `  ${verdict}: ${pct(p.meanA)} → ${pct(p.meanB)}  (${signed(p.diff)}, 95% CI ${ivl(p.ci)}, p=${p.pValue.toFixed(3)}, ${p.n} paired cases)`,
    `  Correlation between runs ${p.correlation.toFixed(2)}: pairing ${p.correlation > 0.2 ? "removes a lot of noise here" : "helps little here"}.`,
    `  Per trial: ${c.trials.failA} of ${c.trials.passA + c.trials.failA} failed in A, ${c.trials.failB} of ${c.trials.passB + c.trials.failB} in B (Fisher exact p=${c.trials.pValue.toFixed(3)}; best for rare failures).`,
  ];
  if (c.graderChanged.length)
    lines.push(
      `  ! Graders changed between A and B for ${c.graderChanged.length} case(s) (${c.graderChanged.slice(0, 5).join(", ")}${c.graderChanged.length > 5 ? ", …" : ""}).`,
      "    Part of any difference there comes from the eval, not the system. Re-run A with the current graders for a fair comparison.",
    );
  if (!c.sameDataset) lines.push(`  ! The suites differ; only the ${p.n} shared cases are compared (${p.onlyInA.length} only in A, ${p.onlyInB.length} only in B).`);
  if (p.pValue >= 0.05 && Math.abs(p.diff) > 0) lines.push(`  To confirm a difference this size, add cases or trials: this suite detects about ±${pct(c.b.summary.mde)}.`);
  if (p.regressions.length) lines.push("", `  Worse in B (${p.regressions.length}): ${p.regressions.join(", ")}`);
  if (p.improvements.length) lines.push(`  Better in B (${p.improvements.length}): ${p.improvements.join(", ")}`);
  const moved = c.graders.filter((g) => Math.abs(g.delta) >= 0.005).sort((x, y) => x.delta - y.delta);
  if (moved.length) {
    lines.push("", "  Graders that moved");
    for (const g of moved) lines.push(`    ${g.graderId.padEnd(30)} ${pct(g.a).padStart(6)} → ${pct(g.b).padStart(6)}  ${signed(g.delta)}`);
  }
  lines.push(
    "",
    `  Cost   A ${usd(c.a.cost.targetUsd + c.a.cost.judgeUsd)}  ·  B ${usd(c.b.cost.targetUsd + c.b.cost.judgeUsd)}`,
    `  Time   A p50 ${(c.a.durationMs.p50 / 1000).toFixed(1)}s  ·  B p50 ${(c.b.durationMs.p50 / 1000).toFixed(1)}s per trial`,
  );
  return lines.join("\n");
}
