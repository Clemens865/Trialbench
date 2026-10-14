// Validate an LLM judge against human labels (Shankar et al., "Who Validates the Validators";
// Husain, evals FAQ). Labels are split deterministically into train / dev / test (15 / 45 / 40):
//   train: source of few-shot examples, never scored;
//   dev:   tune the rubric against it, as often as you like;
//   test:  the honest number. If you tune against it, it stops being one.
// A judge whose TPR or TNR on test is below 0.8 should not gate CI; reports then also show
// pass rates corrected for the judge's measured error (Rogan-Gladen, Lee et al. 2025).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Judge } from "./judge.js";
import { readLabels } from "./labels.js";
import { judgeAccuracy } from "./stats.js";
import { mapLimit } from "./util.js";
export function splitOf(labelId) {
    const bucket = parseInt(labelId.slice(0, 8), 16) % 100;
    return bucket < 15 ? "train" : bucket < 60 ? "dev" : "test";
}
export const validationFile = (config, rubric) => join(config.root, "labels", `${rubric}.validation.json`);
export function readValidation(config, rubric) {
    const f = validationFile(config, rubric);
    return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined;
}
export async function checkJudge(config, rubric, opts = {}) {
    const labels = readLabels(config, rubric.id);
    if (labels.length < 10)
        throw new Error(`Only ${labels.length} labels for ${rubric.id}. Label at least ~20 (ideally 100: 50 PASS / 50 FAIL) with \`trialbench label\`.`);
    const judge = new Judge(opts.model ? { ...config.judge, model: opts.model } : config.judge, config.cacheDir);
    const scored = labels.filter((l) => splitOf(l.id) === "dev" || (opts.includeTest !== false && splitOf(l.id) === "test"));
    const results = await mapLimit(scored, opts.concurrency ?? 4, async (l) => {
        const o = await judge.evaluate(rubric, { input: l.input, output: l.output, ...(l.reference !== undefined ? { reference: l.reference } : {}) }, opts.model);
        return { l, o };
    });
    const acc = (split) => {
        const rows = results.filter((r) => splitOf(r.l.id) === split);
        if (!rows.length)
            return undefined;
        const a = judgeAccuracy(rows.map((r) => ({ human: r.l.human === "PASS", judge: r.o.verdict === "PASS" ? true : r.o.verdict === "FAIL" ? false : null })));
        return { ...a, n: rows.length };
    };
    const dev = acc("dev");
    const test = acc("test");
    const first = results[0]?.o;
    const v = {
        rubric: rubric.id,
        rubricVersion: rubric.version,
        model: first?.model ?? opts.model ?? config.judge.model,
        promptHash: first?.promptHash ?? "",
        validatedAt: new Date().toISOString(),
        ...(dev ? { dev } : {}),
        ...(test ? { test } : {}),
        gateEligible: Boolean(test && test.tpr >= 0.8 && test.tnr >= 0.8 && test.m1 >= 10 && test.m0 >= 10),
        disagreements: results
            .filter((r) => r.o.verdict !== r.l.human)
            .map((r) => ({ id: r.l.id, split: splitOf(r.l.id), human: r.l.human, judge: r.o.verdict, ...(r.l.critique ? { critique: r.l.critique } : {}), reasoning: r.o.reasoning.slice(0, 600) })),
    };
    writeFileSync(validationFile(config, rubric.id), JSON.stringify(v, null, 2) + "\n");
    return v;
}
export function formatValidation(v) {
    const f = (a) => a ? `TPR ${(100 * a.tpr).toFixed(0)}%  TNR ${(100 * a.tnr).toFixed(0)}%  κ ${a.kappa.toFixed(2)}  (n=${a.n}: ${a.m1} pass / ${a.m0} fail labels)` : "no labels in this split";
    const lines = [
        `Judge ${v.model} on rubric ${v.rubric} v${v.rubricVersion}`,
        `  dev   ${f(v.dev)}`,
        `  test  ${f(v.test)}`,
        "",
        v.gateEligible
            ? "  ✓ Trustworthy enough to gate CI. Reports will show judge-corrected pass rates."
            : "  ✗ Not yet trustworthy enough to gate: needs TPR and TNR ≥ 80% on test with ≥10 labels of each kind.",
    ];
    if (v.disagreements.length) {
        lines.push("", `  Disagreements (${v.disagreements.length}): tighten the rubric wording on dev, then re-check`);
        for (const d of v.disagreements.filter((x) => x.split === "dev").slice(0, 8)) {
            lines.push(`    · human ${d.human}, judge ${d.judge}${d.critique ? `: you said "${d.critique}"` : ""}`, `      judge: ${d.reasoning.replace(/\s+/g, " ").slice(0, 220)}`);
        }
    }
    return lines.join("\n");
}
