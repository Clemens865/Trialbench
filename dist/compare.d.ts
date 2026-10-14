import { type RunAnalysis } from "./report.js";
import { type PairedComparison } from "./stats.js";
export interface RunComparison {
    a: RunAnalysis;
    b: RunAnalysis;
    paired: PairedComparison;
    graders: {
        graderId: string;
        a: number;
        b: number;
        delta: number;
    }[];
    sameDataset: boolean;
}
export declare function compareRuns(a: {
    analysis: RunAnalysis;
    items: Map<string, number>;
}, b: {
    analysis: RunAnalysis;
    items: Map<string, number>;
}): RunComparison;
export declare function formatComparison(c: RunComparison): string;
