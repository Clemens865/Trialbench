import type { Case, TargetResult, TargetSpec, ToolCall } from "./types.js";
/** The JSON document every target receives. */
export interface TargetRequest {
    caseId: string;
    trial: number;
    input: unknown;
    metadata?: Record<string, unknown>;
    /** Absolute path of this trial's fresh workspace, when the suite has one. */
    workspace?: string;
    /** Workspace env (not sent to http/function targets; applied to exec and claude-code processes). */
    env?: Record<string, string>;
}
export type TargetFn = (request: TargetRequest) => Promise<TargetResult | unknown> | TargetResult | unknown;
/**
 * Normalize whatever a target returned. A target may return the full TargetResult
 * ({ output, toolCalls?, usage? }) or just a bare value, which becomes `output`.
 */
export declare function normalizeResult(raw: unknown): TargetResult;
export declare function buildRequest(c: Case, trial: number, workspace?: string, env?: Record<string, string>): TargetRequest;
export declare function callTarget(target: TargetSpec, request: TargetRequest, baseDir: string, defaultTimeoutMs: number): Promise<TargetResult>;
/** The most useful line of a stack trace / stderr dump: the first line mentioning an error, else the first line. */
export declare function firstErrorLine(stderr: string): string;
/** The prompt for an agent: input.prompt if present, else the input as text; optionally through a template. */
export declare function agentPrompt(template: string | undefined, input: unknown): string;
/** Parse Claude Code's stream-json events into tool calls, the final answer, cost and turns. */
export declare function parseClaudeStream(ndjson: string): {
    result?: string;
    isError: boolean;
    subtype?: string;
    costUsd?: number;
    turns?: number;
    inputTokens?: number;
    outputTokens?: number;
    toolCalls: ToolCall[];
    assistantText: string[];
};
