export declare const Z95 = 1.959963984540054;
export interface Interval {
    low: number;
    high: number;
}
export declare function mean(xs: readonly number[]): number;
/** Sample variance (n-1 denominator). */
export declare function variance(xs: readonly number[]): number;
/** Standard error of the mean, Miller Eq. 1. */
export declare function standardError(xs: readonly number[]): number;
/**
 * Clustered standard error, Miller Eq. 4. Items sharing a cluster (same source document,
 * same conversation, variants of one seed) are not independent; ignoring that understates SE.
 */
export declare function clusteredStandardError(xs: readonly number[], clusters: readonly string[]): number;
/** Wilson score interval: better than the normal interval for small n or p near 0/1. */
export declare function wilson(successes: number, n: number, z?: number): Interval;
export declare function normalInterval(m: number, se: number, z?: number): Interval;
/** Unbiased pass@k for one task with n trials and c successes (Chen et al. 2021). P(at least one of k succeeds). */
export declare function passAtK(n: number, c: number, k: number): number;
/** Unbiased pass^k for one task (tau-bench). P(all k trials succeed): the reliability metric. */
export declare function passPowK(n: number, c: number, k: number): number;
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
    passAtK?: {
        k: number;
        value: number;
    };
    passPowK?: {
        k: number;
        value: number;
    };
    /** Mean over items of (2p-1)^2: 1 = every item fully consistent, 0 = coin flips. */
    consistency?: number;
    /** Smallest paired A/B difference this suite can detect (alpha 0.05, power 0.8, assumed item correlation 0.5). */
    mde: number;
}
/**
 * Headline numbers for a suite. Items are the unit of analysis: each item's score is the mean
 * of its trials (Miller §resampling), and SEs are computed across items, clustered when any
 * item has a cluster.
 */
export declare function summarize(items: readonly ItemTrials[]): SuiteSummary;
/**
 * Minimum detectable effect for a paired comparison (Miller Eq. 10) with the item-score
 * correlation between versions assumed to be 0.5, i.e. omega^2 = Var(x).
 * Falls back to the binary worst case (p=0.5) when the observed variance is 0.
 */
export declare function minimumDetectableEffect(n: number, itemVariance: number, correlation?: number): number;
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
export declare function pearson(xs: readonly number[], ys: readonly number[]): number;
/** Two-sided exact binomial test of k successes in n trials at p=0.5 (McNemar exact). */
export declare function mcnemarExact(b: number, c: number): number;
/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export declare function normalCdf(x: number): number;
/**
 * Paired A/B comparison on shared item IDs (Miller Eq. 7). Pairing removes item difficulty
 * from the noise, which typically shrinks the SE a lot compared with an unpaired test.
 */
export declare function comparePaired(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): PairedComparison;
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
export declare function judgeAccuracy(pairs: readonly {
    human: boolean;
    judge: boolean | null;
}[]): JudgeAccuracy;
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
export declare function correctForJudge(passes: number, n: number, acc: Pick<JudgeAccuracy, "tpr" | "tnr" | "m1" | "m0">, z?: number): CorrectedRate;
