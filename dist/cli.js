#!/usr/bin/env node
import { Command, Option } from "commander";
import { cpSync, existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listSuites, loadConfig, loadRubric, loadSuite, resolveSuitePath } from "./config.js";
import { EXIT, gate, latestRunId, listRunIds, loadRun, saveBaseline } from "./gate.js";
import { buildFeedback } from "./feedback.js";
import { taskFromCommit } from "./tasks.js";
import { validateSuite } from "./validate.js";
import { compareRuns, formatComparison } from "./compare.js";
import { collectItems, serveLabeling } from "./labels.js";
import { checkJudge, formatValidation, readValidation } from "./judgecheck.js";
import { readFileSync, writeFileSync } from "node:fs";
import { resolveProvider } from "./judge.js";
import { analyze, formatText, judgeCorrections, writeReports } from "./report.js";
import { buildHtml } from "./html.js";
import { HARNESS_VERSION, readMeta, readTrials, runDirFor, runSuite } from "./runner.js";
import { runCommand } from "./util.js";
const runCommandQuiet = (cmd) => runCommand(cmd, { timeoutMs: 10_000 }).catch(() => undefined);
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
    .option("--keep-workspaces", "keep each trial's workspace on disk for inspection")
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
        keepWorkspaces: Boolean(opts.keepWorkspaces),
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
    writeFileSync(join(res.runDir, "report.html"), buildHtml(res.meta, analysis, res.records, suite));
    writeFileSync(join(res.runDir, "FEEDBACK.md"), buildFeedback(cfg, res.meta, res.records, suite, { trialsPath: relative(process.cwd(), join(res.runDir, "trials.jsonl")) }));
    console.log(formatText(analysis) + judgeCorrections(res.records, (r) => readValidation(cfg, r)).join("\n"));
    console.log(`\n  Details     ${relative(process.cwd(), res.runDir)}/report.md`);
    console.log(`  Feedback    ${relative(process.cwd(), res.runDir)}/FEEDBACK.md   (what to fix: hand it to a developer or Claude Code)`);
    console.log(`  Browse      trialbench view ${suite.suite}   (HTML report with every trace)`);
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
    const recs = readTrials(dir);
    const a = analyze(readMeta(dir), recs);
    writeReports(dir, a);
    console.log(formatText(a) + judgeCorrections(recs, (r) => readValidation(cfg, r)).join("\n"));
});
program
    .command("feedback")
    .description("write FEEDBACK.md for a run: failure modes with examples, changes vs the baseline, instructions for the fixer")
    .argument("<suite>")
    .option("-r, --run <runId>")
    .option("-b, --baseline <name>", "baseline to compare with", "main")
    .option("-n, --examples <n>", "examples per failure mode", (v) => parseInt(v, 10), 3)
    .option("--stdout", "print instead of writing the file")
    .action((suiteName, opts) => {
    const cfg = config();
    const id = opts.run ?? latestRunId(cfg, suiteName);
    if (!id)
        throw new Error(`No runs for ${suiteName}`);
    const dir = runDirFor(cfg, suiteName, id);
    const meta = readMeta(dir);
    let suite;
    try {
        suite = loadSuite(meta.suiteFile);
    }
    catch {
        suite = undefined; // suite file moved: feedback still works, just without inputs
    }
    const md = buildFeedback(cfg, meta, readTrials(dir), suite, {
        baseline: opts.baseline,
        examples: opts.examples,
        trialsPath: relative(process.cwd(), join(dir, "trials.jsonl")),
    });
    if (opts.stdout)
        return void process.stdout.write(md);
    const file = join(dir, "FEEDBACK.md");
    writeFileSync(file, md);
    console.log(`Wrote ${relative(process.cwd(), file)}`);
});
program
    .command("compare")
    .description("compare two runs case by case: is B better than A, and where? (default: the two latest runs)")
    .argument("<suite>")
    .argument("[runA]", "earlier run (default: second latest)")
    .argument("[runB]", "later run (default: latest)")
    .action((suite, runA, runB) => {
    const cfg = config();
    const runs = listRunIds(cfg, suite);
    const b = runB ?? runs[0];
    const a = runA ?? runs[1];
    if (!a || !b)
        throw new Error(`Need two runs of ${suite} to compare.`);
    console.log(formatComparison(compareRuns(loadRun(cfg, suite, a), loadRun(cfg, suite, b))));
});
program
    .command("label")
    .description("open a local page to label judge outputs PASS/FAIL: your ground truth for validating the judge")
    .argument("<suite>")
    .argument("<rubric>", "rubric id to label")
    .option("-r, --runs <ids>", "runs to take outputs from (default: all runs of the suite)", list)
    .option("--grader <id>", "match grades by grader id (for runs made before grades recorded their rubric)")
    .option("--port <n>", "port", (v) => parseInt(v, 10), 4677)
    .action(async (suiteName, rubricId, opts) => {
    const cfg = config();
    const rubric = loadRubric(rubricId, cfg);
    const suite = loadSuite(resolveSuitePath(suiteName, cfg));
    const inputs = new Map(suite.cases.map((c) => [c.id, { input: c.input, ...(c.reference !== undefined ? { reference: c.reference } : {}) }]));
    const runIds = opts.runs ?? listRunIds(cfg, suite.suite);
    let records = runIds.flatMap((id) => readTrials(runDirFor(cfg, suite.suite, id)));
    if (opts.grader)
        records = records.map((r) => ({ ...r, grades: r.grades.map((g) => (g.graderId === opts.grader ? { ...g, graderId: `judge:${rubricId}` } : g)) }));
    const specs = [...(suite.graders ?? []), ...suite.cases.flatMap((c) => c.graders ?? [])];
    const pathFor = (gid) => {
        const spec = specs.find((g) => g.type === "judge" && (g.id === (opts.grader ?? gid) || `judge:${g.rubric}` === gid));
        return spec && "path" in spec ? spec.path : undefined;
    };
    const items = collectItems(records, rubricId, inputs, pathFor);
    if (!items.length)
        throw new Error(`No outputs graded with rubric ${rubricId} in ${runIds.length} run(s). Try --grader <id>.`);
    const url = await serveLabeling(cfg, rubric, items, opts.port);
    console.log(`Labeling ${items.length} outputs for rubric ${rubricId}: ${url}
Keys: P = pass, F = fail, S = skip. Labels are saved to labels/${rubricId}.jsonl as you go. Ctrl+C when done.`);
    await runCommandQuiet(`open ${url}`);
});
program
    .command("judge-check")
    .description("measure how well the judge agrees with your labels (TPR/TNR/kappa on dev and a held-out test split)")
    .argument("<rubric>")
    .option("-m, --model <model>", "check a different judge model")
    .option("--dev-only", "score only the dev split (use while tuning the rubric)")
    .action(async (rubricId, opts) => {
    const cfg = config();
    const v = await checkJudge(cfg, loadRubric(rubricId, cfg), { ...(opts.model ? { model: opts.model } : {}), includeTest: !opts.devOnly });
    console.log(formatValidation(v));
    process.exit(v.gateEligible || opts.devOnly ? EXIT.PASS : EXIT.FAIL);
});
program
    .command("view")
    .description("open the HTML report for a run (default: the latest): every case, trial, grade, tool call and diff")
    .argument("<suite>")
    .option("-r, --run <runId>")
    .option("--no-open", "only write the file")
    .action(async (suiteName, opts) => {
    const cfg = config();
    const id = opts.run ?? latestRunId(cfg, suiteName);
    if (!id)
        throw new Error(`No runs for ${suiteName}`);
    const dir = runDirFor(cfg, suiteName, id);
    const meta = readMeta(dir);
    const recs = readTrials(dir);
    let suite;
    try {
        suite = loadSuite(meta.suiteFile);
    }
    catch {
        suite = undefined;
    }
    const file = join(dir, "report.html");
    writeFileSync(file, buildHtml(meta, analyze(meta, recs), recs, suite));
    console.log(`Wrote ${relative(process.cwd(), file)}`);
    if (opts.open)
        await runCommandQuiet(`open ${JSON.stringify(file)}`);
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
    .command("task-from-commit")
    .description("turn a git commit that added a feature + tests into a coding-agent task (hidden tests, reference patch, instruction)")
    .argument("<repo>", "path to the git repository")
    .argument("<commit>", "commit that added the feature together with its tests")
    .option("--id <id>", "task id (default: <sha>-<subject>)")
    .option("--tests <paths>", "which changed files are the hidden tests (comma-separated; default: files that look like tests)", list)
    .option("--test-cmd <cmd>", "command that runs the hidden tests in the workspace (default: guessed)")
    .option("--suite <name>", "append the case to suites/<name>.yaml")
    .action(async (repo, commit, opts) => {
    const cfg = config();
    const t = await taskFromCommit({ repo, commit, root: cfg.root, ...(opts.id ? { id: opts.id } : {}), ...(opts.tests ? { tests: opts.tests } : {}), ...(opts.testCmd ? { testCmd: opts.testCmd } : {}) });
    console.log(`Task ${t.id}
  hidden tests  ${t.testFiles.join(", ")}
  test command  ${t.testCmd}
  files         ${relative(process.cwd(), t.dir)}/{task.md, oracle.patch, hidden/}
`);
    if (opts.suite) {
        const file = resolveSuitePath(opts.suite, cfg);
        const text = readFileSync(file, "utf8").replace(/^cases:\s*\[\s*\]\s*$/m, "cases:");
        const indented = t.caseYaml.split("\n").map((l) => (l ? `  ${l}` : l)).join("\n");
        writeFileSync(file, text.replace(/\s*$/, "\n") + indented);
        console.log(`Appended to ${relative(process.cwd(), file)}. Review task.md, then run: trialbench validate ${opts.suite}`);
    }
    else
        console.log("Case to add to a suite:\n\n" + t.caseYaml);
});
program
    .command("validate")
    .description("check every task: its reference solution must pass and doing nothing must fail")
    .argument("<suite>")
    .option("--case <ids>", "only these case ids", list)
    .option("-j, --concurrency <n>", "parallel trials", (v) => parseInt(v, 10))
    .action(async (suiteArg, opts) => {
    const cfg = config();
    const suite = loadSuite(resolveSuitePath(suiteArg, cfg));
    console.error(`Validating ${suite.suite}: reference solutions and do-nothing runs…`);
    const res = await validateSuite(suite, cfg, { ...(opts.case ? { caseIds: opts.case } : {}), ...(opts.concurrency ? { concurrency: opts.concurrency } : {}) });
    const icon = { ok: "✓", broken: "✗", trivial: "✗", unverified: "?" };
    for (const r of res)
        console.log(`${icon[r.status]} ${r.caseId.padEnd(40)} reference ${String(r.oracle).padEnd(12)} do-nothing ${r.null.padEnd(6)} ${r.status}${r.detail ? `: ${r.detail}` : ""}`);
    const bad = res.filter((r) => r.status === "broken" || r.status === "trivial");
    console.log(`\n${res.length - bad.length}/${res.length} cases valid${bad.length ? `; fix or remove: ${bad.map((r) => r.caseId).join(", ")}` : ""}`);
    process.exit(bad.length ? EXIT.FAIL : EXIT.PASS);
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
