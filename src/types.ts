// Core data model. Vocabulary follows Anthropic's "Demystifying evals for AI agents":
// a *suite* holds *cases*; each case is run for K *trials*; each trial is scored by *graders*.

export type Verdict = "PASS" | "FAIL" | "UNKNOWN" | "ERROR";

/** How trialbench calls the code under test. Every adapter speaks JSON in / JSON out. */
export type TargetSpec =
  // Relative paths (cmd, cwd, module) resolve against the folder containing trialbench.config.yaml.
  | { type: "exec"; cmd: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }
  | { type: "http"; url: string; method?: "POST" | "PUT"; headers?: Record<string, string>; timeoutMs?: number }
  | { type: "function"; module: string; export?: string; timeoutMs?: number }
  | ClaudeCodeTarget
  // Validation targets (used by `trialbench validate`): apply the reference patch / do nothing.
  | { type: "patch"; patch: string; timeoutMs?: number }
  | { type: "noop"; timeoutMs?: number };

/**
 * Runs Claude Code headless (`claude -p`) inside the trial's workspace and records every tool call.
 * Use it to evaluate coding agents on your repo, or an agent whose brain is Claude Code.
 */
export interface ClaudeCodeTarget {
  type: "claude-code";
  /** Model or alias. Default: the CLI's configured model. */
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Prompt template; {{input}} is replaced with the case input (or input.prompt). Default: the input itself. */
  prompt?: string;
  /** Appended to Claude Code's system prompt. */
  appendSystemPrompt?: string;
  /** Command whose stdout is appended to the system prompt. Runs from the config folder; the workspace path is in TRIALBENCH_WORKSPACE. */
  appendSystemPromptCmd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Default "acceptEdits": file edits are allowed, other tools only via allowedTools. */
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
  /** Which settings to load. Default "project": the repo's CLAUDE.md and .claude/ apply; your user-level plugins and hooks don't. */
  settingSources?: string;
  maxBudgetUsd?: number;
  /** Extra CLI flags, appended verbatim. */
  extraArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Fresh directory per trial. Exactly one of: empty (default), template, git. */
export interface WorkspaceSpec {
  /** Copy this folder (relative to the config root). */
  template?: string;
  /** Clone this repo at this ref (fast local clone; refs to later commits are removed). */
  git?: { repo: string; ref?: string; stripFutureHistory?: boolean };
  /** Paths to delete after copying, e.g. the tests the agent must recreate. */
  remove?: string[];
  /** Run once per trial after copying (installs, builds). Its changes are not counted as the agent's. */
  setup?: string;
  setupTimeoutMs?: number;
  /** Copied in AFTER the agent stops, before grading: hidden tests the agent never sees. */
  hidden?: { from: string; to?: string }[];
  /** Globs of EXISTING files the agent must not modify or delete (e.g. "tests/**"). A change fails the trial. */
  protect?: string[];
  /** Also fail when the agent creates new files matching `protect`. Default false: adding new tests is fine. */
  protectNew?: boolean;
  /** Keep workspaces after the run (for debugging). Default: delete. */
  keep?: boolean;
  /** Where to create workspaces. Default: the OS temp dir. */
  parentDir?: string;
  /** Environment for setup, the target and workspace commands, e.g. a shared CARGO_TARGET_DIR so trials don't rebuild from scratch. `~` expands to your home. */
  env?: Record<string, string>;
}

/** What the agent left behind (filled in by the runner after the target returns). */
export interface WorkspaceState {
  dir: string;
  changed: { status: string; path: string }[];
  diff: string;
  tampered: string[];
}

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
  usage?: Usage & { turns?: number };
  workspace?: WorkspaceState;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export type GraderSpec =
  | { type: "equals"; value: unknown; path?: string; id?: string; weight?: number; gate?: boolean }
  | { type: "contains"; values: string[]; all?: boolean; ignoreCase?: boolean; path?: string; id?: string; weight?: number; gate?: boolean }
  | { type: "not_contains"; values: string[]; ignoreCase?: boolean; path?: string; id?: string; weight?: number; gate?: boolean }
  | { type: "regex"; pattern: string; flags?: string; path?: string; id?: string; weight?: number; gate?: boolean }
  | { type: "max_length"; chars: number; path?: string; id?: string; weight?: number; gate?: boolean }
  | { type: "json_schema"; schema: Record<string, unknown>; path?: string; id?: string; weight?: number; gate?: boolean }
  | { type: "tool_used"; name: string; min?: number; max?: number; id?: string; weight?: number; gate?: boolean }
  | { type: "tool_not_used"; name: string; id?: string; weight?: number; gate?: boolean }
  | { type: "command"; cmd: string; cwd?: string; timeoutMs?: number; id?: string; weight?: number; gate?: boolean }
  /** `file`: judge the content of the first workspace file matching this glob instead of the output. */
  | { type: "judge"; rubric: string; model?: string; path?: string; file?: string; id?: string; weight?: number; gate?: boolean }
  // ── workspace graders (need a workspace) ──
  | { type: "file_exists"; path: string; min?: number; max?: number; id?: string; weight?: number; gate?: boolean }
  | { type: "file_contains"; path: string; values?: string[]; pattern?: string; all?: boolean; ignoreCase?: boolean; not?: boolean; id?: string; weight?: number; gate?: boolean }
  | { type: "files_changed"; allow?: string[]; forbid?: string[]; min?: number; max?: number; id?: string; weight?: number; gate?: boolean }
  // ── trajectory / efficiency graders ──
  | { type: "tool_sequence"; names: string[]; mode?: "exact" | "in_order" | "any_order"; id?: string; weight?: number; gate?: boolean }
  | { type: "budget"; maxToolCalls?: number; maxTurns?: number; maxCostUsd?: number; maxDurationMs?: number; id?: string; weight?: number; gate?: boolean }

export interface Case {
  id: string;
  input: unknown;
  reference?: unknown;
  tags?: string[];
  /** Items from the same source share a cluster; used for clustered standard errors. */
  cluster?: string;
  graders?: GraderSpec[];
  metadata?: Record<string, unknown>;
  /** Per-case workspace overrides (merged over the suite's), e.g. a different git ref or hidden tests. */
  workspace?: WorkspaceSpec;
  /** Per-case target override (rarely needed; `validate` uses it for reference patches). */
  target?: TargetSpec;
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
  /** Give every trial a fresh workspace (agents, coding agents). */
  workspace?: WorkspaceSpec;
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
  fewShots?: { input: string; output: string; critique: string; verdict: "PASS" | "FAIL" }[];
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
  /** "tamper" is added automatically when the workspace protects paths. */
  type: GraderSpec["type"] | "tamper";
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
    rubric: string;
    rubricVersion: string;
    cached: boolean;
    costUsd?: number;
    /** Exactly what the judge was shown as the output (kept so verdicts can be labeled and re-judged later). */
    subject?: string;
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
  hashes: { case: string; target: string; graders: string; harness: string };
  startedAt: string;
  durationMs: number;
  termination: Termination;
  attempts: number;
  error?: string;
  /** Errors of earlier attempts that were retried (infrastructure errors only). */
  attemptErrors?: string[];
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
