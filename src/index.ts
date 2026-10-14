// Library entry point: use trialbench programmatically (e.g. from a test runner or a script).
export { loadConfig, loadSuite, loadRubric, parseConfig, resolveSuitePath, DEFAULT_JUDGE_MODEL } from "./config.js";
export { runSuite, readTrials, readMeta, HARNESS_VERSION, type RunOptions, type RunResult } from "./runner.js";
export { analyze, formatText, formatMarkdown, type RunAnalysis } from "./report.js";
export { gate, saveBaseline, loadBaseline, loadRun, EXIT, type GateOptions, type GateResult } from "./gate.js";
export { Judge, buildSystemPrompt, buildUserPrompt, type JudgeItem, type JudgeOutcome } from "./judge.js";
export { grade, combine } from "./graders.js";
export type { TargetRequest, TargetFn } from "./adapters.js";
export * from "./stats.js";
export type * from "./types.js";
