import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
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
    z.object({ type: z.literal("judge"), rubric: z.string(), model: z.string().optional(), ...pathField, ...common }),
]);
const TargetSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("exec"), cmd: z.string(), cwd: z.string().optional(), env: z.record(z.string(), z.string()).optional(), timeoutMs: z.number().int().positive().optional() }),
    z.object({ type: z.literal("http"), url: z.string().url(), method: z.enum(["POST", "PUT"]).optional(), headers: z.record(z.string(), z.string()).optional(), timeoutMs: z.number().int().positive().optional() }),
    z.object({ type: z.literal("function"), module: z.string(), export: z.string().optional(), timeoutMs: z.number().int().positive().optional() }),
]);
const CaseSchema = z.object({
    id: z.string().regex(/^[\w.\-:/]+$/, "case ids may only contain letters, digits and . - _ : /"),
    input: z.unknown(),
    reference: z.unknown().optional(),
    tags: z.array(z.string()).optional(),
    cluster: z.string().optional(),
    graders: z.array(GraderSchema).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
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
function formatZodError(file, err) {
    return `${file}:\n` + err.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
function readStructured(file) {
    const text = readFileSync(file, "utf8");
    return extname(file) === ".json" ? JSON.parse(text) : YAML.parse(text);
}
/** Walk up from `start` to find trialbench.config.yaml; falls back to defaults rooted at `start`. */
export function loadConfig(start = process.cwd()) {
    let dir = resolve(start);
    for (;;) {
        const candidate = join(dir, CONFIG_FILE);
        if (existsSync(candidate))
            return parseConfig(readStructured(candidate), dir, candidate);
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return parseConfig({}, resolve(start), "(defaults)");
}
export function parseConfig(raw, root, file = "(inline)") {
    const parsed = ConfigSchema.safeParse(raw ?? {});
    if (!parsed.success)
        throw new Error(formatZodError(file, parsed.error));
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
export function loadSuite(file) {
    const abs = resolve(file);
    const parsed = SuiteSchema.safeParse(readStructured(abs));
    if (!parsed.success)
        throw new Error(formatZodError(abs, parsed.error));
    const base = dirname(abs);
    const ids = new Set();
    for (const c of parsed.data.cases) {
        if (ids.has(c.id))
            throw new Error(`${abs}: duplicate case id "${c.id}"`);
        ids.add(c.id);
    }
    const suite = parsed.data;
    return {
        ...suite,
        cases: suite.cases.map((c) => ({ ...c, input: resolveFileRefs(c.input, base), reference: resolveFileRefs(c.reference, base) })),
        file: abs,
    };
}
/** Find a suite by name or path: "summarize" -> <root>/suites/summarize.yaml. */
export function resolveSuitePath(nameOrPath, config) {
    const direct = resolve(nameOrPath);
    if (existsSync(direct) && /\.(ya?ml|json)$/.test(direct))
        return direct;
    for (const ext of [".yaml", ".yml", ".json"]) {
        const p = join(config.root, "suites", nameOrPath + ext);
        if (existsSync(p))
            return p;
    }
    throw new Error(`Suite "${nameOrPath}" not found (looked for ${direct} and ${join(config.root, "suites", nameOrPath)}.yaml)`);
}
export function listSuites(config) {
    const dir = join(config.root, "suites");
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => /\.(ya?ml|json)$/.test(f))
        .map((f) => basename(f).replace(/\.(ya?ml|json)$/, ""));
}
export function loadRubric(id, config) {
    for (const ext of [".yaml", ".yml", ".json"]) {
        const file = join(config.rubricsDir, id + ext);
        if (!existsSync(file))
            continue;
        const parsed = RubricSchema.safeParse(readStructured(file));
        if (!parsed.success)
            throw new Error(formatZodError(file, parsed.error));
        if (parsed.data.id !== id)
            throw new Error(`${file}: id "${parsed.data.id}" does not match file name "${id}"`);
        return parsed.data;
    }
    throw new Error(`Rubric "${id}" not found in ${config.rubricsDir}`);
}
