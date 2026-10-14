import { type Interval, type SuiteSummary } from "./stats.js";
import type { RunMeta, TrialRecord } from "./types.js";
export interface GraderStat {
    graderId: string;
    type: string;
    pass: number;
    fail: number;
    unknown: number;
    error: number;
    skipped: number;
    passRate: number;
    ci: Interval;
}
export interface RunAnalysis {
    runId: string;
    suite: string;
    label?: string;
    datasetHash: string;
    summary: SuiteSummary;
    verdicts: Record<"PASS" | "FAIL" | "UNKNOWN" | "ERROR", number>;
    terminations: Record<TrialRecord["termination"], number>;
    /** Trials left out of the headline (UNKNOWN, ERROR, infra errors). */
    excludedTrials: number;
    graders: GraderStat[];
    tags: {
        tag: string;
        nItems: number;
        mean: number;
        ci: Interval;
    }[];
    failingCases: {
        caseId: string;
        passRate: number;
        trials: number;
        firstEvidence?: string;
    }[];
    cost: {
        targetUsd: number;
        judgeUsd: number;
        judgeCalls: number;
        judgeCached: number;
    };
    durationMs: {
        total: number;
        p50: number;
        p95: number;
    };
}
/** Item-level pass rates. Only PASS/FAIL trials count; UNKNOWN/ERROR are excluded and reported separately. */
export declare function perItemScores(records: readonly TrialRecord[]): Map<string, {
    cluster?: string;
    tags?: string[];
    scores: number[];
}>;
export declare function analyze(meta: RunMeta, records: readonly TrialRecord[]): RunAnalysis;
export declare const pct: (x: number, digits?: number) => string;
export declare const ivl: (iv: Interval) => string;
export declare function headline(a: RunAnalysis): string;
export declare function formatText(a: RunAnalysis): string;
export declare function formatMarkdown(a: RunAnalysis): string;
export declare function writeReports(runDir: string, a: RunAnalysis): void;
