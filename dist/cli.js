#!/usr/bin/env node
import { Command, Option } from "commander";
import { cpSync, existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listSuites, loadConfig, loadSuite, resolveSuitePath } from "./config.js";
import { EXIT, gate, latestRunId, loadRun, saveBaseline } from "./gate.js";
import { resolveProvider } from "./judge.js";
import { analyze, formatText, writeReports } from "./report.js";
import { HARNESS_VERSION, readMeta, readTrials, runDirFor, runSuite } from "./runner.js";
const program = new Command();
program
    .name("trialbench")
    .description("Statistically honest evals for LLM features, tool-using agents and coding agents")
    .version(HARNESS_VERSION)
    .option("-C, --dir <dir>", "directory containing trialbench.config.yaml (searched upward)", ".");
const config = () => loadConfig(resolve(program.opts().dir));
const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
program
    .command("init")
    .description("scaffold an evals/ folder (config, example suite, rubric and target)")
    .argument("[dir]", "where to create it", "evals")
    .option("--force", "overwrite existing files")
    .action((dir, opts) => {
    const target = resolve(dir);
    if (existsSync(target) && readdirSync(target).length && !opts.force) {
        console.error(`${target} is not empty. Use --force to overwrite.`);
        process.exit(EXIT.FAIL);
    }
    const templates = join(dirname(fileURLToPath(import.meta.url)), "..", "templates", "init");
    cpSync(templates, target, { recursive: true, force: Boolean(opts.force) });
    // npm drops .gitignore files from published packages, so the template ships as "gitignore".
    if (existsSync(join(target, "gitignore")))
        renameSync(join(target, "gitignore"), join(target, ".gitignore"));
    const rel = relative(process.cwd(), target) || ".";
    console.log(`Created ${rel}/
  trialbench.config.yaml   judge model, defaults
  suites/example.yaml      cases + graders (edit the target to call your code)
  rubrics/                 one LLM-judge criterion per file
  targets/                 example target script
  baselines/               commit these: CI compares against them

Next:
  npx trialbench -C ${rel} run example --no-judge   # free, deterministic graders only
  npx trialbench -C ${rel} run example              # with the Claude judge
  npx trialbench -C ${rel} baseline example         # store the current run as the baseline`);
});
program
    .command("run")
    .description("run a suite and print the results")
    .argument("<suite>", "suite name (suites/<name>.yaml) or path")
    .option("-k, --trials <n>", "trials per case (overrides the suite)", (v) => parseInt(v, 10))
    .option("-j, --concurrency <n>", "parallel trials", (v) => parseInt(v, 10))
    .option("-t, --tags <tags>", "only cases with one of these tags (comma-separated)", list)
    .option("--case <ids>", "only these case ids (comma-separated)", list)
    .option("-l, --label <label>", "label for this run (e.g. a branch or prompt version)")
    .option("--resume <runId>", "continue an interrupted run")
    .option("--no-judge", "skip LLM judges (deterministic graders only, no cost)")
    .option("--no-cache", "bypass the judge cache")
    .option("--min-pass <rate>", "exit 1 unless the CI lower bound of the pass rate is at least this (0..1)", parseFloat)
    .option("-q, --quiet", "no progress output")
    .action(async (suiteArg, opts) => {
    const cfg = config();
    const suite = loadSuite(resolveSuitePath(suiteArg, cfg));
    const usesJudge = [...(suite.graders ?? []), ...suite.cases.flatMap((c) => c.graders ?? [])].some((g) => g.type === "judge");
    if (!opts.quiet) {
        const judgeInfo = usesJudge ? (opts.judge === false ? "judges off" : `judge ${cfg.judge.model} via ${resolveProvider(cfg.judge)}`) : "no judges";
        console.error(`Running ${suite.suite}: ${suite.cases.length} cases · ${judgeInfo}`);
    }
    const res = await runSuite(suite, cfg, {
        ...(opts.trials ? { trials: opts.trials } : {}),
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
        ...(opts.tags ? { tags: opts.tags } : {}),
        ...(opts.case ? { caseIds: opts.case } : {}),
        ...(opts.label ? { label: opts.label } : {}),
        ...(opts.resume ? { resumeRunId: opts.resume } : {}),
        noJudge: opts.judge === false,
        noCache: opts.cache === false,
        onTrial: opts.quiet
            ? undefined
            : (r, done, total) => {
                const mark = r.verdict === "PASS" ? "✓" : r.verdict === "FAIL" ? "✗" : "?";
                process.stderr.write(`\r  ${String(done).padStart(String(total).length)}/${total} ${mark} ${r.caseId}#${r.trial}`.padEnd(70));
            },
    });
    if (!opts.quiet)
        process.stderr.write("\n\n");
    const analysis = analyze(res.meta, res.records);
    writeReports(res.runDir, analysis);
    console.log(formatText(analysis));
    console.log(`\n  Details     ${relative(process.cwd(), res.runDir)}/report.md`);
    if (opts.minPass !== undefined && analysis.summary.ci.low < opts.minPass) {
        console.log(`\n✗ CI lower bound ${(100 * analysis.summary.ci.low).toFixed(1)}% is below --min-pass ${(100 * opts.minPass).toFixed(1)}%`);
        process.exit(EXIT.FAIL);
    }
});
program
    .command("report")
    .description("print the results of a run (default: the latest)")
    .argument("<suite>")
    .option("-r, --run <runId>")
    .action((suite, opts) => {
    const cfg = config();
    const id = opts.run ?? latestRunId(cfg, suite);
    if (!id)
        throw new Error(`No runs for ${suite}`);
    const dir = runDirFor(cfg, suite, id);
    const a = analyze(readMeta(dir), readTrials(dir));
    writeReports(dir, a);
    console.log(formatText(a));
});
program
    .command("baseline")
    .description("store a run (default: the latest) as the baseline CI compares against; commit the file")
    .argument("<suite>")
    .option("-r, --run <runId>")
    .option("-n, --name <name>", "baseline name", "main")
    .action((suite, opts) => {
    const cfg = config();
    const { path, baseline } = saveBaseline(cfg, suite, opts.run, opts.name);
    console.log(`Baseline "${opts.name}" for ${suite} = run ${baseline.runId} (${(100 * baseline.mean).toFixed(1)}% over ${Object.keys(baseline.items).length} items)`);
    console.log(`Wrote ${relative(process.cwd(), path)}. Commit it so CI can compare against it.`);
});
program
    .command("gate")
    .description("CI check: exit 0 = pass, 1 = regression or below the bar, 2 = infrastructure problems")
    .argument("<suite>")
    .option("-r, --run <runId>", "run to check (default: the latest)")
    .option("-b, --baseline <name>", "baseline name", "main")
    .option("--min-pass <rate>", "required lower CI bound of the pass rate (0..1)", parseFloat)
    .option("--alpha <p>", "significance level for regressions", parseFloat)
    .option("--strict", "fail on any item that got worse than the baseline (use for small regression suites)")
    .addOption(new Option("--max-infra <rate>", "max share of infra-error trials before exit 2").argParser(parseFloat))
    .action((suite, opts) => {
    const cfg = config();
    const res = gate(cfg, suite, {
        ...(opts.run ? { runId: opts.run } : {}),
        baseline: opts.baseline,
        ...(opts.minPass !== undefined ? { minPass: opts.minPass } : {}),
        ...(opts.alpha !== undefined ? { alpha: opts.alpha } : {}),
        ...(opts.strict ? { strict: true } : {}),
        ...(opts.maxInfra !== undefined ? { maxInfraErrorRate: opts.maxInfra } : {}),
    });
    const run = loadRun(cfg, suite, opts.run);
    console.log(`trialbench gate · ${suite} · run ${run.runId}`);
    for (const l of res.lines)
        console.log(`  ${l}`);
    console.log(res.exitCode === 0 ? "\nPASS" : res.exitCode === 1 ? "\nFAIL" : "\nINFRA ERROR");
    process.exit(res.exitCode);
});
program
    .command("list")
    .description("list suites and their latest run")
    .action(() => {
    const cfg = config();
    const suites = listSuites(cfg);
    if (!suites.length)
        console.log(`No suites in ${join(cfg.root, "suites")}. Run \`trialbench init\` first.`);
    for (const s of suites) {
        const id = latestRunId(cfg, s);
        console.log(`${s.padEnd(30)} ${id ? `latest run ${id}` : "no runs yet"}`);
    }
});
program.parseAsync().catch((err) => {
    console.error(`trialbench: ${err.message}`);
    process.exit(EXIT.INFRA);
});
