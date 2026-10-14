import type { Config, Rubric, TrialRecord } from "./types.js";
export interface Label {
    /** Content hash of (rubric, input, output): the same output is never labeled twice. */
    id: string;
    rubric: string;
    input: unknown;
    output: string;
    reference?: unknown;
    human: "PASS" | "FAIL";
    critique?: string;
    source?: string;
    labeledAt: string;
}
export interface LabelItem {
    id: string;
    input: unknown;
    output: string;
    reference?: unknown;
    source: string;
    judgeVerdict?: string;
}
export declare const labelsFile: (config: Config, rubric: string) => string;
export declare function readLabels(config: Config, rubric: string): Label[];
export declare const labelId: (rubric: string, input: unknown, output: string) => string;
/** Items to label: every distinct output a judge with this rubric graded in the given runs. */
export declare function collectItems(records: readonly TrialRecord[], rubric: string, inputs: Map<string, {
    input: unknown;
    reference?: unknown;
}>, 
/** Output path per grader id, for records made before grades stored what the judge saw. */
pathFor?: (graderId: string) => string | undefined): LabelItem[];
/** Serve the labeling page until the process is stopped. Resolves with the URL once listening. */
export declare function serveLabeling(config: Config, rubric: Rubric, items: LabelItem[], port?: number): Promise<string>;
