import { describe, expect, it } from "vitest";
import {
  clusteredStandardError,
  comparePaired,
  correctForJudge,
  judgeAccuracy,
  mcnemarExact,
  passAtK,
  passPowK,
  standardError,
  summarize,
  wilson,
} from "../src/stats.js";

describe("standard errors", () => {
  it("matches the binary formula sqrt(p(1-p)/n) up to the n-1 correction", () => {
    const xs = [...Array(60).fill(1), ...Array(40).fill(0)];
    expect(standardError(xs)).toBeCloseTo(Math.sqrt((0.6 * 0.4) / 100) * Math.sqrt(100 / 99), 10);
  });

  it("clustered SE equals CLT SE when every item is its own cluster", () => {
    const xs = [1, 0, 1, 1, 0, 1, 0, 0, 1, 1];
    const clusters = xs.map((_, i) => `c${i}`);
    expect(clusteredStandardError(xs, clusters)).toBeCloseTo(standardError(xs), 10);
  });

  it("clustered SE grows when correlated items share a cluster", () => {
    // Two clusters of perfectly correlated items.
    const xs = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
    const clusters = ["a", "a", "a", "a", "a", "b", "b", "b", "b", "b"];
    expect(clusteredStandardError(xs, clusters)).toBeGreaterThan(2 * standardError(xs));
  });
});

describe("wilson", () => {
  it("stays inside [0,1] and is non-degenerate at p=0", () => {
    const iv = wilson(0, 20);
    expect(iv.low).toBe(0);
    expect(iv.high).toBeGreaterThan(0.1);
    expect(iv.high).toBeLessThan(0.2);
  });

  it("matches a known value (7/10)", () => {
    const iv = wilson(7, 10);
    expect(iv.low).toBeCloseTo(0.3968, 3);
    expect(iv.high).toBeCloseTo(0.8922, 3);
  });
});

describe("pass@k and pass^k", () => {
  it("both equal c/n at k=1", () => {
    expect(passAtK(5, 3, 1)).toBeCloseTo(0.6, 10);
    expect(passPowK(5, 3, 1)).toBeCloseTo(0.6, 10);
  });

  it("pass@k rises and pass^k falls with k", () => {
    expect(passAtK(5, 3, 3)).toBe(1); // only 2 failures, so any 3 trials include a pass
    expect(passPowK(5, 3, 3)).toBeCloseTo(1 / 10, 10); // C(3,3)/C(5,3)
    expect(passPowK(5, 3, 2)).toBeCloseTo(3 / 10, 10); // C(3,2)/C(5,2)
  });

  it("handles all-pass and all-fail", () => {
    expect(passAtK(4, 0, 2)).toBe(0);
    expect(passPowK(4, 4, 4)).toBe(1);
  });
});

describe("summarize", () => {
  it("uses items as the unit of analysis and reports pass@k / pass^k", () => {
    const s = summarize([
      { id: "a", scores: [1, 1, 1] },
      { id: "b", scores: [1, 0, 1] },
      { id: "c", scores: [0, 0, 0] },
    ]);
    expect(s.nItems).toBe(3);
    expect(s.nTrials).toBe(9);
    expect(s.mean).toBeCloseTo((1 + 2 / 3 + 0) / 3, 10);
    expect(s.passAtK?.k).toBe(3);
    expect(s.passAtK?.value).toBeCloseTo(2 / 3, 10);
    expect(s.passPowK?.value).toBeCloseTo(1 / 3, 10);
    expect(s.consistency).toBeCloseTo((1 + 1 / 9 + 1) / 3, 10);
    expect(s.ci.low).toBeGreaterThanOrEqual(0);
    expect(s.ci.high).toBeLessThanOrEqual(1);
  });

  it("skips pass@k for single-trial suites", () => {
    const s = summarize([{ id: "a", scores: [1] }, { id: "b", scores: [0] }]);
    expect(s.passAtK).toBeUndefined();
    expect(s.wilson).toBeDefined();
  });
});

describe("comparePaired", () => {
  it("finds flips and gives a smaller SE than unpaired when items correlate", () => {
    const a = new Map<string, number>();
    const b = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      const hard = i < 20;
      a.set(`i${i}`, hard ? 0 : 1);
      b.set(`i${i}`, hard ? (i < 5 ? 1 : 0) : 1); // B fixes 5 hard items
    }
    a.set("onlyA", 1);
    const r = comparePaired(a, b);
    expect(r.n).toBe(40);
    expect(r.diff).toBeCloseTo(5 / 40, 10);
    expect(r.improvements).toEqual(["i0", "i1", "i2", "i3", "i4"]);
    expect(r.regressions).toEqual([]);
    expect(r.onlyInA).toEqual(["onlyA"]);
    const unpairedSe = Math.sqrt(standardError([...a.values()].slice(0, 40)) ** 2 + standardError([...b.values()]) ** 2);
    expect(r.se).toBeLessThan(unpairedSe);
    expect(r.pValue).toBeCloseTo(mcnemarExact(0, 5), 10);
  });

  it("exact McNemar: 0 vs 5 discordant gives p = 2 * 0.5^5", () => {
    expect(mcnemarExact(0, 5)).toBeCloseTo(2 / 32, 10);
    expect(mcnemarExact(3, 3)).toBe(1);
  });
});

describe("judge correction", () => {
  it("computes TPR, TNR and kappa", () => {
    const pairs = [
      ...Array.from({ length: 9 }, () => ({ human: true, judge: true })),
      { human: true, judge: false },
      ...Array.from({ length: 8 }, () => ({ human: false, judge: false })),
      ...Array.from({ length: 2 }, () => ({ human: false, judge: true })),
    ];
    const acc = judgeAccuracy(pairs);
    expect(acc.tpr).toBeCloseTo(0.9, 10);
    expect(acc.tnr).toBeCloseTo(0.8, 10);
    expect(acc.kappa).toBeGreaterThan(0.6);
  });

  it("reproduces the worked examples from the research notes", () => {
    const a = correctForJudge(70, 100, { tpr: 0.9, tnr: 0.8, m1: 50, m0: 50 });
    expect(a.corrected).toBeCloseTo(0.714, 3);
    const lenient = correctForJudge(70, 100, { tpr: 0.95, tnr: 0.6, m1: 50, m0: 50 });
    expect(lenient.corrected).toBeCloseTo(0.545, 3);
    expect(lenient.ci.low).toBeLessThan(lenient.corrected);
    expect(lenient.ci.high).toBeGreaterThan(lenient.corrected);
  });

  it("refuses to correct with a near-random judge", () => {
    const r = correctForJudge(50, 100, { tpr: 0.52, tnr: 0.5, m1: 50, m0: 50 });
    expect(r.valid).toBe(false);
  });
});
