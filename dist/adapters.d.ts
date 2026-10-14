import type { Case, TargetResult, TargetSpec } from "./types.js";
/** The JSON document every target receives. */
export interface TargetRequest {
    caseId: string;
    trial: number;
    input: unknown;
    metadata?: Record<string, unknown>;
}
export type TargetFn = (request: TargetRequest) => Promise<TargetResult | unknown> | TargetResult | unknown;
/**
 * Normalize whatever a target returned. A target may return the full TargetResult
 * ({ output, toolCalls?, usage? }) or just a bare value, which becomes `output`.
 */
export declare function normalizeResult(raw: unknown): TargetResult;
export declare function buildRequest(c: Case, trial: number): TargetRequest;
export declare function callTarget(target: TargetSpec, request: TargetRequest, baseDir: string, defaultTimeoutMs: number): Promise<TargetResult>;
/** The most useful line of a stack trace / stderr dump: the first line mentioning an error, else the first line. */
export declare function firstErrorLine(stderr: string): string;
