import type { Config, RunMeta, Suite, TrialRecord } from "./types.js";
export interface FeedbackOptions {
    /** Examples shown per failure mode. */
    examples?: number;
    /** Characters of input/output shown per example. */
    clip?: number;
    baseline?: string;
    /** Path of trials.jsonl, for links. */
    trialsPath?: string;
}
interface FailureMode {
    key: string;
    graderId: string;
    type: string;
    trials: TrialRecord[];
    cases: Set<string>;
}
export declare function failureModes(records: readonly TrialRecord[]): FailureMode[];
export declare function buildFeedback(config: Config, meta: RunMeta, records: readonly TrialRecord[], suite: Suite | undefined, opts?: FeedbackOptions): string;
export {};
