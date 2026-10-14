import type { Config, Rubric, Suite } from "./types.js";
export declare const CONFIG_FILE = "trialbench.config.yaml";
export declare const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";
/** Walk up from `start` to find trialbench.config.yaml; falls back to defaults rooted at `start`. */
export declare function loadConfig(start?: string): Config;
export declare function parseConfig(raw: unknown, root: string, file?: string): Config;
export declare function loadSuite(file: string): Suite;
/** Find a suite by name or path: "summarize" -> <root>/suites/summarize.yaml. */
export declare function resolveSuitePath(nameOrPath: string, config: Config): string;
export declare function listSuites(config: Config): string[];
export declare function loadRubric(id: string, config: Config): Rubric;
