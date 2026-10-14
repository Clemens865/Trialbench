// Statistics for evals. Formulas follow Evan Miller, "Adding Error Bars to Evals"
// (arXiv:2411.00640), Chen et al. 2021 (pass@k), Yao et al. 2024 (pass^k, tau-bench)
// and Lee et al. 2025 (Rogan-Gladen correction for LLM judges, arXiv:2511.21140).

export const Z95 = 1.959963984540054;
const Z_POWER_80 = 0.8416212335729143;

export interface Interval {
  low: number;
  high: number;
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return Number.NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Sample variance (n-1 denominator). */
export function variance(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return s / (n - 1);
}

/** Standard error of the mean, Miller Eq. 1. */
export function standardError(xs: readonly number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  return Math.sqrt(variance(xs) / n);
}

/**
 * Clustered standard error, Miller Eq. 4. Items sharing a cluster (same source document,
 * same conversation, variants of one seed) are not independent; ignoring that understates SE.
 */
export function clusteredStandardError(xs: readonly number[], clusters: readonly string[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const m = mean(xs);
  const sums = new Map<string, number>();
  xs.forEach((x, i) => {
    const c = clusters[i] ?? `__item_${i}`;
    sums.set(c, (sums.get(c) ?? 0) + (x - m));
  });
  // Σ_c (Σ_i e_ic)² = Σ e² + Σ_c Σ_i Σ_{j≠i} e_ic e_jc, so the cross terms are the difference.
  let grouped = 0;
  for (const v of sums.values()) grouped += v * v;
  let sumSq = 0;
  for (const x of xs) sumSq += (x - m) ** 2;
  const se2 = sumSq / (n * (n - 1)) + (grouped - sumSq) / (n * n);
  return Math.sqrt(Math.max(0, se2));
}

/** Wilson score interval: better than the normal interval for small n or p near 0/1. */
export function wilson(successes: number, n: number, z = Z95): Interval {
  if (n === 0) return { low: 0, high: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half) };
}

export function normalInterval(m: number, se: number, z = Z95): Interval {
  return { low: m - z * se, high: m + z * se };
}

/** C(n-c, k) / C(n, k) computed as a product, stable for large n. */
function ratioOfCombinations(n: number, c: number, k: number): number {
  if (n - c < k) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r *= (n - c - i) / (n - i);
  return r;
}

/** Unbiased pass@k for one task with n trials and c successes (Chen et al. 2021). P(at least one of k succeeds). */
export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass@k needs k <= n (k=${k}, n=${n})`);
  return 1 - ratioOfCombinations(n, c, k);
}

/** Unbiased pass^k for one task (tau-bench). P(all k trials succeed): the reliability metric. */
export function passPowK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`pass^k needs k <= n (k=${k}, n=${n})`);
  // C(c, k) / C(n, k) == ratioOfCombinations(n, n - c, k)
  return ratioOfCombinations(n, n - c, k);
}

export interface ItemTrials {
  id: string;
  cluster?: string;
  /** One entry per trial, each 0..1 (binary pass = 1). */
  scores: number[];
}

export interface SuiteSummary {
  nItems: number;
  nTrials: number;
  nClusters: number;
  mean: number;
  se: number;
  clustered: boolean;
  ci: Interval;
  /** Wilson interval on per-trial passes when scores are binary; undefined otherwise. */
  wilson?: Interval;
  /** pass@k / pass^k at k = min trials per item (only when every item has >= 2 binary trials). */
  passAtK?: { k: number; value: number };
  passPowK?: { k: number; value: number };
  /** Mean over items of (2p-1)^2: 1 = every item fully consistent, 0 = coin flips. */
  consistency?: number;
  /** Smallest paired A/B difference this suite can detect (alpha 0.05, power 0.8, assumed item correlation 0.5). */
  mde: number;
}

function isBinary(xs: readonly number[]): boolean {
  return xs.every((x) => x === 0 || x === 1);
}

/**
 * Headline numbers for a suite. Items are the unit of analysis: each item's score is the mean
 * of its trials (Miller §resampling), and SEs are computed across items, clustered when any
 * item has a cluster.
 */
export function summarize(items: readonly ItemTrials[]): SuiteSummary {
  const scored = items.filter((it) => it.scores.length > 0);
  const itemMeans = scored.map((it) => mean(it.scores));
  const clusters = scored.map((it, i) => it.cluster ?? `__item_${i}`);
  const clustered = scored.some((it) => it.cluster !== undefined);
  const m = mean(itemMeans);
  const se = clustered ? clusteredStandardError(itemMeans, clusters) : standardError(itemMeans);
  const allTrialScores = scored.flatMap((it) => it.scores);
  const binary = allTrialScores.length > 0 && isBinary(allTrialScores);

  const summary: SuiteSummary = {
    nItems: scored.length,
    nTrials: allTrialScores.length,
    nClusters: new Set(clusters).size,
    mean: m,
    se,
    clustered,
    // Wilson on the item means behaves at small n and at 0%/100%; with clusters we need the clustered SE.
    ci: clustered ? clampInterval(normalInterval(m, se)) : wilson(m * scored.length, scored.length),
    mde: minimumDetectableEffect(scored.length, variance(itemMeans)),
  };

  if (binary && scored.length > 0) {
    const passes = allTrialScores.filter((x) => x === 1).length;
    summary.wilson = wilson(passes, allTrialScores.length);
    const k = Math.min(...scored.map((it) => it.scores.length));
    if (k >= 2) {
      const perItem = (f: (n: number, c: number, k: number) => number) =>
        mean(scored.map((it) => f(it.scores.length, it.scores.filter((x) => x === 1).length, k)));
      summary.passAtK = { k, value: perItem(passAtK) };
      summary.passPowK = { k, value: perItem(passPowK) };
      summary.consistency = mean(scored.map((it) => (2 * mean(it.scores) - 1) ** 2));
    }
  }
  return summary;
}

function clampInterval(iv: Interval): Interval {
  return { low: Math.max(0, iv.low), high: Math.min(1, iv.high) };
}

/**
 * Minimum detectable effect for a paired comparison (Miller Eq. 10) with the item-score
 * correlation between versions assumed to be 0.5, i.e. omega^2 = Var(x).
 * Falls back to the binary worst case (p=0.5) when the observed variance is 0.
 */
export function minimumDetectableEffect(n: number, itemVariance: number, correlation = 0.5): number {
  if (n < 2) return 1;
  const v = itemVariance > 0 ? itemVariance : 0.25;
  const omega2 = 2 * v * (1 - correlation);
  return (Z95 + Z_POWER_80) * Math.sqrt(omega2 / n);
}

export interface PairedComparison {
  n: number;
  meanA: number;
  meanB: number;
  /** B minus A. */
  diff: number;
  se: number;
  ci: Interval;
  correlation: number;
  /** Two-sided p-value: exact McNemar on discordant pairs when binary, normal approximation otherwise. */
  pValue: number;
  /** Items whose score dropped from A to B (regressions) or rose (improvements). For binary items these are the pass↔fail flips. */
  regressions: string[];
  improvements: string[];
  onlyInA: string[];
  onlyInB: string[];
}

export function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

/** Two-sided exact binomial test of k successes in n trials at p=0.5 (McNemar exact). */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // log-space binomial pmf at p = 0.5
  const logC = (nn: number, kk: number) => logFactorial(nn) - logFactorial(kk) - logFactorial(nn - kk);
  let tail = 0;
  for (let i = 0; i <= k; i++) tail += Math.exp(logC(n, i) - n * Math.LN2);
  return Math.min(1, 2 * tail);
}

const logFactCache: number[] = [0];
function logFactorial(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) logFactCache[i] = logFactCache[i - 1]! + Math.log(i);
  return logFactCache[n]!;
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-((x / Math.SQRT2) ** 2));
  return 0.5 * (1 + Math.sign(x) * y);
}

/**
 * Paired A/B comparison on shared item IDs (Miller Eq. 7). Pairing removes item difficulty
 * from the noise, which typically shrinks the SE a lot compared with an unpaired test.
 */
export function comparePaired(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): PairedComparison {
  const ids = [...a.keys()].filter((id) => b.has(id)).sort();
  const xa = ids.map((id) => a.get(id)!);
  const xb = ids.map((id) => b.get(id)!);
  const d = ids.map((_, i) => xb[i]! - xa[i]!);
  const diff = mean(d);
  const se = standardError(d);
  const binary = isBinary(xa) && isBinary(xb);
  const regressions = ids.filter((_, i) => xb[i]! < xa[i]!);
  const improvements = ids.filter((_, i) => xb[i]! > xa[i]!);
  let pValue: number;
  if (binary) pValue = mcnemarExact(regressions.length, improvements.length);
  else if (se === 0) pValue = diff === 0 ? 1 : 0;
  else pValue = 2 * (1 - normalCdf(Math.abs(diff / se)));
  // For binary pairs use the Agresti-Min interval (add 0.5 to each cell of the 2x2 table):
  // good coverage at small n, stays inside [-1, 1], and agrees with the exact McNemar test.
  let ci = normalInterval(diff, se);
  if (binary && ids.length > 0) {
    const nAdj = ids.length + 2;
    const pReg = (regressions.length + 0.5) / nAdj;
    const pImp = (improvements.length + 0.5) / nAdj;
    const dAdj = pImp - pReg;
    const half = Z95 * Math.sqrt((pReg + pImp - dAdj * dAdj) / nAdj);
    ci = { low: Math.max(-1, dAdj - half), high: Math.min(1, dAdj + half) };
  }
  return {
    n: ids.length,
    meanA: mean(xa),
    meanB: mean(xb),
    diff,
    se,
    ci,
    correlation: pearson(xa, xb),
    pValue,
    regressions,
    improvements,
    onlyInA: [...a.keys()].filter((id) => !b.has(id)).sort(),
    onlyInB: [...b.keys()].filter((id) => !a.has(id)).sort(),
  };
}

export interface JudgeAccuracy {
  /** Judge PASS rate on items humans labeled PASS (sensitivity). */
  tpr: number;
  /** Judge FAIL rate on items humans labeled FAIL (specificity). */
  tnr: number;
  /** Number of human-PASS and human-FAIL items used. */
  m1: number;
  m0: number;
  kappa: number;
  agreement: number;
}

/** Judge vs human agreement on binary labels. UNKNOWN judge verdicts count as disagreement. */
export function judgeAccuracy(pairs: readonly { human: boolean; judge: boolean | null }[]): JudgeAccuracy {
  const pos = pairs.filter((p) => p.human);
  const neg = pairs.filter((p) => !p.human);
  const tp = pos.filter((p) => p.judge === true).length;
  const tn = neg.filter((p) => p.judge === false).length;
  const n = pairs.length;
  const agree = pairs.filter((p) => p.judge === p.human).length;
  const po = n ? agree / n : 0;
  const pHumanYes = n ? pos.length / n : 0;
  const pJudgeYes = n ? pairs.filter((p) => p.judge === true).length / n : 0;
  const pe = pHumanYes * pJudgeYes + (1 - pHumanYes) * (1 - pJudgeYes);
  return {
    tpr: pos.length ? tp / pos.length : Number.NaN,
    tnr: neg.length ? tn / neg.length : Number.NaN,
    m1: pos.length,
    m0: neg.length,
    kappa: pe === 1 ? 1 : (po - pe) / (1 - pe),
    agreement: po,
  };
}

export interface CorrectedRate {
  raw: number;
  corrected: number;
  ci: Interval;
  /** False when TPR + TNR - 1 <= 0.05: the judge is too close to random to correct. */
  valid: boolean;
}

/**
 * Rogan-Gladen correction of a judge-measured pass rate with Lee et al.'s adjusted CI:
 *   theta = (p + TNR - 1) / (TPR + TNR - 1)
 * The raw judge rate is biased upward at low true rates and downward at high ones.
 */
export function correctForJudge(passes: number, n: number, acc: Pick<JudgeAccuracy, "tpr" | "tnr" | "m1" | "m0">, z = Z95): CorrectedRate {
  const raw = n ? passes / n : Number.NaN;
  const youden = acc.tpr + acc.tnr - 1;
  if (!(youden > 0.05) || n === 0 || acc.m0 === 0 || acc.m1 === 0) {
    return { raw, corrected: raw, ci: { low: 0, high: 1 }, valid: false };
  }
  const clip = (x: number) => Math.min(1, Math.max(0, x));
  const corrected = clip((raw + acc.tnr - 1) / youden);
  // Adjusted (pseudo-count) interval from Lee et al. 2025.
  const z2 = z * z;
  const nT = n + z2;
  const pT = (passes + z2 / 2) / nT;
  const q0 = (acc.m0 * acc.tnr + 1) / (acc.m0 + 2);
  const q1 = (acc.m1 * acc.tpr + 1) / (acc.m1 + 2);
  const m0T = acc.m0 + 2;
  const m1T = acc.m1 + 2;
  const denom = q0 + q1 - 1;
  const thetaT = clip((pT + q0 - 1) / denom);
  const half =
    (z * Math.sqrt((pT * (1 - pT)) / nT + ((1 - thetaT) ** 2 * q0 * (1 - q0)) / m0T + (thetaT ** 2 * q1 * (1 - q1)) / m1T)) / denom;
  return { raw, corrected, ci: { low: clip(thetaT - half), high: clip(thetaT + half) }, valid: true };
}
