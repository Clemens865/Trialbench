import { type RunAnalysis } from "./report.js";
import { type PairedComparison } from "./stats.js";
export interface RunComparison {
    a: RunAnalysis;
    b: RunAnalysis;
    /** Trial-level pass/fail counts and Fisher exact p (all trials pooled). */
    trials: {
        passA: number;
        failA: number;
        passB: number;
        failB: number;
        pValue: number;
    };
    paired: PairedComparison;
    graders: {
        graderId: string;
        a: number;
        b: number;
        delta: number;
    }[];
    sameDataset: boolean;
    /** Cases whose graders differ between A and B: their difference may come from the eval, not the system. */
    graderChanged: string[];
}
type Loaded = {
    analysis: RunAnalysis;
    items: Map<string, number>;
    graderHashes?: Map<string, string>;
};
export declare function compareRuns(a: Loaded, b: Loaded): RunComparison;
export declare function formatComparison(c: RunComparison): string;
export {};
