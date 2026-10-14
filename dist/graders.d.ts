import type { Judge } from "./judge.js";
import type { Case, Config, GradeResult, GraderSpec, Rubric, TargetResult, Verdict } from "./types.js";
export interface GradeContext {
    case: Case;
    result: TargetResult;
    config: Config;
    suiteDir: string;
    judge?: Judge;
    loadRubric: (id: string) => Rubric;
}
/** Deterministic graders are free; judges cost money. Run cheap ones first. */
export declare const isDeterministic: (g: GraderSpec) => g is {
    type: "equals";
    value: unknown;
    path?: string;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "contains";
    values: string[];
    all?: boolean;
    ignoreCase?: boolean;
    path?: string;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "not_contains";
    values: string[];
    ignoreCase?: boolean;
    path?: string;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "regex";
    pattern: string;
    flags?: string;
    path?: string;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "max_length";
    chars: number;
    path?: string;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "json_schema";
    schema: Record<string, unknown>;
    path?: string;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "tool_used";
    name: string;
    min?: number;
    max?: number;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "tool_not_used";
    name: string;
    id?: string;
    weight?: number;
    gate?: boolean;
} | {
    type: "command";
    cmd: string;
    cwd?: string;
    timeoutMs?: number;
    id?: string;
    weight?: number;
    gate?: boolean;
};
export declare function graderId(g: GraderSpec, index: number): string;
export declare function grade(spec: GraderSpec, index: number, ctx: GradeContext): Promise<GradeResult>;
/**
 * Combine grades into one trial verdict.
 * - Without a threshold: PASS only if every gating grader passed.
 * - With a threshold: PASS if the weighted score of gating graders >= threshold.
 * Otherwise FAIL beats ERROR beats UNKNOWN: we never guess a PASS from incomplete grades.
 */
export declare function combine(all: GradeResult[], threshold?: number): {
    verdict: Verdict;
    score?: number;
};
