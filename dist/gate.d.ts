import { type RunAnalysis } from "./report.js";
import { type PairedComparison } from "./stats.js";
import type { Config } from "./types.js";
export interface Baseline {
    schemaVersion: 1;
    suite: string;
    runId: string;
    label?: string;
    createdAt: string;
    datasetHash: string;
    /** Per-item pass rate (mean over PASS/FAIL trials). */
    items: Record<string, number>;
    mean: number;
}
export declare const EXIT: {
    readonly PASS: 0;
    readonly FAIL: 1;
    readonly INFRA: 2;
};
export declare function baselinePath(config: Config, suite: string, name?: string): string;
/** Run ids of a suite, newest first. */
export declare function listRunIds(config: Config, suite: string): string[];
export declare function latestRunId(config: Config, suite: string): string | undefined;
export declare function loadRun(config: Config, suite: string, runId?: string): {
    runId: string;
    analysis: RunAnalysis;
    items: Map<string, number>;
};
export declare function saveBaseline(config: Config, suite: string, runId: string | undefined, name?: string): {
    path: string;
    baseline: Baseline;
};
export declare function loadBaseline(config: Config, suite: string, name?: string): Baseline | undefined;
export interface GateOptions {
    runId?: string;
    baseline?: string;
    /** Require the lower 95% CI bound of the pass rate to be at least this (0..1). */
    minPass?: number;
    /** Significance level for "significant regression vs baseline". */
    alpha?: number;
    /** Fail on any item that got worse vs the baseline, significant or not (for small regression suites). */
    strict?: boolean;
    /** Fail with exit 2 if more than this share of trials are infra errors. */
    maxInfraErrorRate?: number;
}
export interface GateResult {
    exitCode: 0 | 1 | 2;
    lines: string[];
    comparison?: PairedComparison;
}
/**
 * CI gate. Rules (Miller 2024; Yan, "Product evals"; Husain & Shankar, evals FAQ):
 *  - absolute bar: gate on the CI lower bound, not the point estimate;
 *  - regression: fail only on a statistically significant paired drop vs the baseline;
 *  - infra noise: too many infra errors is exit 2, not a quality failure.
 */
export declare function gate(config: Config, suite: string, opts?: GateOptions): GateResult;
