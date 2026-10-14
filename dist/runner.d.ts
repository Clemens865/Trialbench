import type { Config, RunMeta, Suite, TrialRecord } from "./types.js";
export declare const HARNESS_VERSION: string;
export interface RunOptions {
    trials?: number;
    concurrency?: number;
    label?: string;
    /** Continue an interrupted run: completed trials are kept, the rest are run. */
    resumeRunId?: string;
    /** Only run cases with at least one of these tags. */
    tags?: string[];
    /** Only run these case ids. */
    caseIds?: string[];
    /** Skip LLM judges (their grades are recorded as SKIPPED). */
    noJudge?: boolean;
    /** Bypass the judge cache. */
    noCache?: boolean;
    /** Keep every trial's workspace on disk (paths are in the trial records). */
    keepWorkspaces?: boolean;
    onTrial?: (record: TrialRecord, done: number, total: number) => void;
}
export interface RunResult {
    runId: string;
    runDir: string;
    meta: RunMeta;
    records: TrialRecord[];
}
export declare function runDirFor(config: Config, suite: string, runId: string): string;
export declare function newRunId(): string;
export declare function readTrials(runDir: string): TrialRecord[];
export declare function readMeta(runDir: string): RunMeta;
export declare function runSuite(suite: Suite, config: Config, opts?: RunOptions): Promise<RunResult>;
/** Hash that identifies a suite's cases; compare runs only when it matches. */
export declare function datasetHash(records: readonly TrialRecord[]): string;
