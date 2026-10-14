import { z } from "zod";
import type { JudgeConfig, Rubric, Verdict } from "./types.js";
export declare const JudgeVerdictSchema: z.ZodObject<{
    reasoning: z.ZodString;
    evidence: z.ZodArray<z.ZodString>;
    verdict: z.ZodEnum<{
        FAIL: "FAIL";
        PASS: "PASS";
        UNKNOWN: "UNKNOWN";
    }>;
}, z.core.$strip>;
export type JudgeVerdict = z.infer<typeof JudgeVerdictSchema>;
export interface JudgeItem {
    input: unknown;
    output: unknown;
    reference?: unknown;
    context?: string;
}
export interface JudgeOutcome {
    verdict: Verdict;
    reasoning: string;
    evidence: string[];
    model: string;
    provider: "anthropic" | "claude-cli";
    promptHash: string;
    cached: boolean;
    costUsd?: number;
    error?: string;
}
/** Static part of the prompt (rules + criterion + few-shots): identical across items, so it caches well. */
export declare function buildSystemPrompt(rubric: Rubric): string;
/** Per-item part. Only content goes in: no model names, run ids or timestamps (blinding). */
export declare function buildUserPrompt(item: JudgeItem): string;
export declare function resolveProvider(cfg: JudgeConfig): "anthropic" | "claude-cli";
export declare class Judge {
    private readonly cfg;
    private readonly cacheDir?;
    private client?;
    readonly provider: "anthropic" | "claude-cli";
    constructor(cfg: JudgeConfig, cacheDir?: string | undefined);
    evaluate(rubric: Rubric, item: JudgeItem, modelOverride?: string): Promise<JudgeOutcome>;
    private callAnthropic;
    /** Uses the local Claude Code login. Settings, plugins, MCP and tools are disabled so the judge sees only our prompt. */
    private callClaudeCli;
    private cachePath;
    private readCache;
    private writeCache;
}
