import { type JudgeAccuracy } from "./stats.js";
import type { Config, Rubric } from "./types.js";
export type Split = "train" | "dev" | "test";
export declare function splitOf(labelId: string): Split;
export interface JudgeValidation {
    rubric: string;
    rubricVersion: string;
    model: string;
    promptHash: string;
    validatedAt: string;
    dev?: JudgeAccuracy & {
        n: number;
    };
    test?: JudgeAccuracy & {
        n: number;
    };
    /** Test TPR and TNR both >= 0.8 with at least 10 labels of each kind. */
    gateEligible: boolean;
    disagreements: {
        id: string;
        split: Split;
        human: string;
        judge: string;
        critique?: string;
        reasoning: string;
    }[];
}
export declare const validationFile: (config: Config, rubric: string) => string;
export declare function readValidation(config: Config, rubric: string): JudgeValidation | undefined;
export declare function checkJudge(config: Config, rubric: Rubric, opts?: {
    model?: string;
    includeTest?: boolean;
    concurrency?: number;
}): Promise<JudgeValidation>;
export declare function formatValidation(v: JudgeValidation): string;
