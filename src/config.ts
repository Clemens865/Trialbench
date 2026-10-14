import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { Config, Rubric, Suite } from "./types.js";
import { resolveFileRefs } from "./util.js";

export const CONFIG_FILE = "trialbench.config.yaml";
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-5-5";

const common = {
  id: z.string().optional(),
  weight: z.number().positive().optional(),
  gate: z.boolean().optional(),
};
const pathField = { path: z.string().optional() };

const GraderSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("equals"), value: z.unknown(), ...pathField, ...common }),
  z.object({ type: z.literal("contains"), values: z.array(z.string()).min(1), all: z.boolean().optional(), ignoreCase: z.boolean().optional(), ...pathField, ...common }),
  z.object({ type: z.literal("not_contains"), values: z.array(z.string()).min(1), ignoreCase: z.boolean().optional(), ...pathField, ...common }),
  z.object({ type: z.literal("regex"), pattern: z.string(), flags: z.string().optional(), ...pathField, ...common }),
  z.object({ type: z.literal("max_length"), chars: z.number().int().positive(), ...pathField, ...common }),
  z.object({ type: z.literal("json_schema"), schema: z.record(z.string(), z.unknown()), ...pathField, ...common }),
  z.object({ type: z.literal("tool_used"), name: z.string(), min: z.number().int().optional(), max: z.number().int().optional(), ...common }),
  z.object({ type: z.literal("tool_not_used"), name: z.string(), ...common }),
  z.object({ type: z.literal("command"), cmd: z.string(), cwd: z.string().optional(), timeoutMs: z.number().int().positive().optional(), ...common }),
  z.object({ type: z.literal("judge"), rubric: z.string(), model: z.string().optional(), file: z.string().optional(), ...pathField, ...common }),
  z.object({ type: z.literal("file_exists"), path: z.string(), min: z.number().int().min(0).optional(), max: z.number().int().optional(), ...common }),
  z.object({
    type: z.literal("file_contains"), path: z.string(), values: z.array(z.string()).optional(), pattern: z.string().optional(),
    all: z.boolean().optional(), ignoreCase: z.boolean().optional(), not: z.boolean().optional(), ...common,
  }).refine((g) => g.values?.length || g.pattern, "file_contains needs values or pattern"),
  z.object({ type: z.literal("files_changed"), allow: z.array(z.string()).optional(), forbid: z.array(z.string()).optional(), min: z.number().int().min(0).optional(), max: z.number().int().optional(), ...common }),
  z.object({ type: z.literal("tool_sequence"), names: z.array(z.string()).min(1), mode: z.enum(["exact", "in_order", "any_order"]).optional(), ...common }),
  z.object({
    type: z.literal("budget"), maxToolCalls: z.number().int().positive().optional(), maxTurns: z.number().int().positive().optional(),
    maxCostUsd: z.number().positive().optional(), maxDurationMs: z.number().int().positive().optional(), ...common,
  }),
]);

const WorkspaceSchema = z.object({
  template: z.string().optional(),
  git: z.object({ repo: z.string(), ref: z.string().optional(), stripFutureHistory: z.boolean().optional() }).optional(),
  remove: z.array(z.string()).optional(),
  setup: z.string().optional(),
  setupTimeoutMs: z.number().int().positive().optional(),
  hidden: z.array(z.object({ from: z.string(), to: z.string().optional() })).optional(),
  protect: z.array(z.string()).optional(),
  protectNew: z.boolean().optional(),
  keep: z.boolean().optional(),
  parentDir: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
}).refine((w) => !(w.template && w.git), "workspace: use either template or git, not both");

const TargetSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("exec"), cmd: z.string(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("http"), url: z.string().url(), method: z.enum(["POST", "PUT"]).optional(), headers: z.record(z.string(), z.string()).optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("function"), module: z.string(), export: z.string().optional(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("patch"), patch: z.string(), timeoutMs: z.number().int().positive().optional() }),
  z.object({ type: z.literal("noop"), timeoutMs: z.number().int().positive().optional() }),
  z.object({
    type: z.literal("claude-code"),
    model: z.string().optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    prompt: z.string().optional(),
    appendSystemPrompt: z.string().optional(),
    appendSystemPromptCmd: z.string().optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(),
    settingSources: z.string().optional(),
    maxBudgetUsd: z.number().positive().optional(),
    extraArgs: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  }),
]);

const CaseSchema = z.object({
  id: z.string().regex(/^[\w.\-:/]+$/, "case ids may only contain letters, digits and . - _ : /"),
  input: z.unknown(),
  reference: z.unknown().optional(),
  tags: z.array(z.string()).optional(),
  cluster: z.string().optional(),
  graders: z.array(GraderSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  workspace: WorkspaceSchema.optional(),
  target: TargetSchema.optional(),
});

const SuiteSchema = z.object({
  suite: z.string(),
  description: z.string().optional(),
  target: TargetSchema,
  trials: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  retries: z.number().int().min(0).optional(),
  threshold: z.number().min(0).max(1).optional(),
  graders: z.array(GraderSchema).optional(),
  workspace: WorkspaceSchema.optional(),
  cases: z.array(CaseSchema).min(1),
});

const ConfigSchema = z.object({
  judge: z
    .object({
      provider: z.enum(["auto", "anthropic", "claude-cli"]).default("auto"),
      model: z.string().default(DEFAULT_JUDGE_MODEL),
      effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .prefault({}),
  rubricsDir: z.string().default("rubrics"),
  runsDir: z.string().default("runs"),
  cacheDir: z.string().default(".trialbench-cache"),
  defaults: z
    .object({
      trials: z.number().int().positive().default(1),
      concurrency: z.number().int().positive().default(4),
      timeoutMs: z.number().int().positive().default(120_000),
      retries: z.number().int().min(0).default(2),
    })
    .prefault({}),
});

const RubricSchema = z.object({
  id: z.string(),
  version: z.union([z.string(), z.number()]).transform(String),
  name: z.string(),
  pass: z.string(),
  fail: z.string(),
  outOfScope: z.string().optional(),
  model: z.string().optional(),
  fewShots: z
    .array(z.object({ input: z.string(), output: z.string(), critique: z.string(), verdict: z.enum(["PASS", "FAIL"]) }))
    .optional(),
});

function formatZodError(file: string, err: z.ZodError): string {
  return `${file}:\n` + err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}

function readStructured(file: string): unknown {
  const text = readFileSync(file, "utf8");
  return extname(file) === ".json" ? JSON.parse(text) : YAML.parse(text);
}

/** Walk up from `start` to find trialbench.config.yaml; falls back to defaults rooted at `start`. */
export function loadConfig(start = process.cwd()): Config {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return parseConfig(readStructured(candidate), dir, candidate);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return parseConfig({}, resolve(start), "(defaults)");
}

export function parseConfig(raw: unknown, root: string, file = "(inline)"): Config {
  const parsed = ConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(formatZodError(file, parsed.error));
  const c = parsed.data;
  return {
    judge: c.judge,
    rubricsDir: resolve(root, c.rubricsDir),
    runsDir: resolve(root, c.runsDir),
    cacheDir: resolve(root, c.cacheDir),
    defaults: c.defaults,
    root,
  };
}

export function loadSuite(file: string): Suite {
  const abs = resolve(file);
  const parsed = SuiteSchema.safeParse(readStructured(abs));
  if (!parsed.success) throw new Error(formatZodError(abs, parsed.error));
  const base = dirname(abs);
  const ids = new Set<string>();
  for (const c of parsed.data.cases) {
    if (ids.has(c.id)) throw new Error(`${abs}: duplicate case id "${c.id}"`);
    ids.add(c.id);
  }
  const suite = parsed.data as Omit<Suite, "file">;
  return {
    ...suite,
    cases: suite.cases.map((c) => ({ ...c, input: resolveFileRefs(c.input, base), reference: resolveFileRefs(c.reference, base) })),
    file: abs,
  };
}

/** Find a suite by name or path: "summarize" -> <root>/suites/summarize.yaml. */
export function resolveSuitePath(nameOrPath: string, config: Config): string {
  const direct = resolve(nameOrPath);
  if (existsSync(direct) && /\.(ya?ml|json)$/.test(direct)) return direct;
  for (const ext of [".yaml", ".yml", ".json"]) {
    const p = join(config.root, "suites", nameOrPath + ext);
    if (existsSync(p)) return p;
  }
  throw new Error(`Suite "${nameOrPath}" not found (looked for ${direct} and ${join(config.root, "suites", nameOrPath)}.yaml)`);
}

export function listSuites(config: Config): string[] {
  const dir = join(config.root, "suites");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(ya?ml|json)$/.test(f))
    .map((f) => basename(f).replace(/\.(ya?ml|json)$/, ""));
}

export function loadRubric(id: string, config: Config): Rubric {
  for (const ext of [".yaml", ".yml", ".json"]) {
    const file = join(config.rubricsDir, id + ext);
    if (!existsSync(file)) continue;
    const parsed = RubricSchema.safeParse(readStructured(file));
    if (!parsed.success) throw new Error(formatZodError(file, parsed.error));
    if (parsed.data.id !== id) throw new Error(`${file}: id "${parsed.data.id}" does not match file name "${id}"`);
    return parsed.data;
  }
  throw new Error(`Rubric "${id}" not found in ${config.rubricsDir}`);
}
