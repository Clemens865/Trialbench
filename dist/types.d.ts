export type Verdict = "PASS" | "FAIL" | "UNKNOWN" | "ERROR";
/** How trialbench calls the code under test. Every adapter speaks JSON in / JSON out. */
export type TargetSpec = {
    type: "exec";
    cmd: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
} | {
    type: "http";
    url: string;
    method?: "POST" | "PUT";
    headers?: Record<string, string>;
    timeoutMs?: number;
} | {
    type: "function";
    module: string;
    export?: string;
    timeoutMs?: number;
};
/** A single tool invocation reported by the target (used by tool/trajectory graders). */
export interface ToolCall {
    name: string;
    args?: unknown;
    result?: unknown;
    startedAt?: string;
    endedAt?: string;
}
export interface Usage {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}
/** What a target returns. Only `output` is required. */
export interface TargetResult {
    output: unknown;
    toolCalls?: ToolCall[];
    usage?: Usage;
    traceId?: string;
    metadata?: Record<string, unknown>;
}
export type GraderSpec = {
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
} | {
    type: "judge";
    rubric: string;
    model?: string;
    path?: string;
    id?: string;
    weight?: number;
    gate?: boolean;
};
export interface Case {
    id: string;
    input: unknown;
    reference?: unknown;
    tags?: string[];
    /** Items from the same source share a cluster; used for clustered standard errors. */
    cluster?: string;
    graders?: GraderSpec[];
    metadata?: Record<string, unknown>;
}
export interface SuiteDefaults {
    trials?: number;
    concurrency?: number;
    timeoutMs?: number;
    /** Retries for infrastructure errors only (adapter crash, timeout, HTTP 5xx). Never for failed grades. */
    retries?: number;
    /** Pass threshold for a trial's weighted score (0..1). Default: every gating grader must pass. */
    threshold?: number;
}
export interface Suite extends SuiteDefaults {
    suite: string;
    description?: string;
    target: TargetSpec;
    /** Graders applied to every case, in addition to per-case graders. */
    graders?: GraderSpec[];
    cases: Case[];
    /** Absolute path of the suite file (set by the loader). */
    file: string;
}
export interface Rubric {
    id: string;
    version: string;
    name: string;
    pass: string;
    fail: string;
    outOfScope?: string;
    model?: string;
    fewShots?: {
        input: string;
        output: string;
        critique: string;
        verdict: "PASS" | "FAIL";
    }[];
}
export interface JudgeConfig {
    /** "anthropic" uses the Anthropic SDK; "claude-cli" shells out to `claude -p` (uses your Claude login). "auto" picks anthropic if credentials exist. */
    provider: "auto" | "anthropic" | "claude-cli";
    model: string;
    effort?: "low" | "medium" | "high" | "xhigh" | "max";
    maxTokens?: number;
}
export interface Config {
    judge: JudgeConfig;
    rubricsDir: string;
    runsDir: string;
    cacheDir: string;
    defaults: Required<Pick<SuiteDefaults, "trials" | "concurrency" | "timeoutMs" | "retries">>;
    /** Directory the config was loaded from; relative paths resolve against it. */
    root: string;
}
export interface GradeResult {
    graderId: string;
    type: GraderSpec["type"];
    /** SKIPPED: an expensive grader not run because a cheaper gating grader already failed the trial. */
    verdict: Verdict | "SKIPPED";
    /** 0..1; PASS=1, FAIL=0 for binary graders. Undefined when UNKNOWN/ERROR. */
    score?: number;
    weight: number;
    gate: boolean;
    evidence?: string;
    /** Judge-only: reproducibility fingerprint. */
    judge?: {
        model: string;
        provider: string;
        promptHash: string;
        rubricVersion: string;
        cached: boolean;
        costUsd?: number;
    };
}
/** completed: target returned. target_error: the code under test failed (scored FAIL). infra_error: environment failed after retries (excluded from scores). */
export type Termination = "completed" | "target_error" | "infra_error";
/** One append-only JSONL line per trial: everything needed to recompute or re-grade later. */
export interface TrialRecord {
    schemaVersion: 1;
    runId: string;
    suite: string;
    caseId: string;
    trial: number;
    cluster?: string;
    tags?: string[];
    hashes: {
        case: string;
        target: string;
        graders: string;
        harness: string;
    };
    startedAt: string;
    durationMs: number;
    termination: Termination;
    attempts: number;
    error?: string;
    result?: TargetResult;
    grades: GradeResult[];
    /** Weighted mean of scored grades (0..1), undefined if nothing could be scored. */
    score?: number;
    verdict: Verdict;
}
export interface RunMeta {
    schemaVersion: 1;
    runId: string;
    suite: string;
    suiteFile: string;
    startedAt: string;
    finishedAt?: string;
    harnessVersion: string;
    gitCommit?: string;
    trials: number;
    judge: JudgeConfig;
    label?: string;
}
