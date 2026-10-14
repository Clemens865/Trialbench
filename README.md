# trialbench

**Statistically honest evals for LLM features, tool-using agents and coding agents.**

Drop trialbench into any project (TypeScript, Python, Rust, Electron, anything with a CLI or an HTTP endpoint) and get:

- **Pass rates with confidence intervals**, not a bare percentage, so you know whether 82% vs 79% is a real difference or noise.
- **Repeated trials** with **pass@k** (works at least once in k tries) and **pass^k** (works every time), because LLMs are non-deterministic.
- **Cheap checks first, an LLM judge second.** Deterministic graders (exact match, regex, JSON Schema, tool calls, your own scripts) run first; a Claude judge only runs when they all passed.
- **A CI gate that doesn't cry wolf:** it fails on a *statistically significant* regression against a committed baseline, or when the lower bound of the confidence interval drops below your bar.
- **Full trial records** (inputs, outputs, tool calls, every grade with its evidence, cost, timing), so any number can be recomputed or re-graded later.

```
Suite sift  ·  run 20261014-094250-f01262  ·  full-k3

  Pass rate   98.6%  95% CI [83.3%, 99.9%]  (n=23 items, 69 trials)
  Reliability pass@3 100.0%  ·  pass^3 95.7%  ·  consistency 96%
  Detectable  changes smaller than ±4.1% are within noise for this suite

  Graders
    parsed                       100.0%  [94.7%, 100.0%]    69/69
    summary-faithful              98.5%  [92.1%, 99.7%]     67/68  (1 skipped)
    equals:zone                  100.0%  [93.7%, 100.0%]    57/57
    regex:zone                    91.7%  [64.6%, 98.5%]     11/12

  Failing cases (1)
    ✗ case/no-matching-case  67% of 3  — regex:zone: no match for /^(answer|glance)$/

  Cost        target $0.40  ·  judge $1.45 (68 calls, 2 cached)
```

*(Real output from evaluating an email-triage feature: the failing case is a real bug that a single-trial eval would have missed, since 2 of 3 trials passed.)*

---

## Install

trialbench needs **Node.js 20+** (23.6+ if you want `function` targets to load `.ts` files directly; Node strips the types itself).

```bash
# run without installing (builds from GitHub on first use)
npx github:Clemens865/Trialbench --help

# or add it to a project as a dev dependency
npm install --save-dev github:Clemens865/Trialbench
npx trialbench --help
```

npm may print an `install-scripts` warning when installing from GitHub. You can ignore it: the package ships prebuilt in `dist/`, so nothing needs to run.

For the LLM judge you need **one** of:

- an Anthropic API key (`ANTHROPIC_API_KEY`) or an `ant auth login` profile, **or**
- the [Claude Code](https://claude.com/claude-code) CLI, logged in (`claude` on your PATH). trialbench then judges through your Claude login, with your settings, plugins, MCP servers and hooks switched off so the judge sees only its own prompt.

Deterministic graders need neither: `--no-judge` runs everything for free.

---

## Quick start (5 minutes)

```bash
cd your-project
npx trialbench init                          # creates evals/ with a working example
npx trialbench -C evals run example --no-judge   # free run, deterministic graders only
npx trialbench -C evals run example              # with the Claude judge
npx trialbench -C evals baseline example         # store this run as the baseline (commit it)
npx trialbench -C evals gate example --strict    # what CI runs: exit 0 / 1 / 2
```

`init` creates:

```
evals/
├── trialbench.config.yaml     judge model and defaults
├── suites/example.yaml        target + cases + graders
├── rubrics/faithful-summary.yaml   one judge criterion per file
├── targets/example-target.mjs      the script trialbench calls (replace with yours)
├── baselines/                 commit these: CI compares against them
└── .gitignore                 ignores runs/ and the judge cache
```

`-C evals` tells trialbench where the config is. If you run commands from inside `evals/`, leave it out.

---

## Connecting your code: targets

trialbench never needs to know your framework. For every case it sends one JSON request to a **target** and reads one JSON response:

```jsonc
// request
{ "caseId": "refund-policy", "trial": 1, "input": <whatever the case's input is>, "metadata": {} }

// response: only "output" is required (plain text on stdout also works and becomes the output)
{
  "output": <the thing to grade: a string or any JSON>,
  "toolCalls": [{ "name": "search", "args": { "q": "..." } }],    // optional: for tool graders
  "usage": { "inputTokens": 1200, "outputTokens": 80, "costUsd": 0.004 }  // optional: cost tracking
}
```

There are three target types. Relative paths resolve against the folder that holds `trialbench.config.yaml`.

### `exec`: any language, via a command

The request arrives on **stdin**, the response goes to **stdout**. Write a small entry point that calls the real feature.

```yaml
target: { type: exec, cmd: python -m app.eval_entry }
```

<details><summary>Python example: <code>app/eval_entry.py</code></summary>

```python
import json, sys
from app.summarize import summarize   # your real code

req = json.load(sys.stdin)
result = summarize(req["input"]["text"])
print(json.dumps({"output": result.text,
                  "usage": {"inputTokens": result.in_tokens, "outputTokens": result.out_tokens}}))
```
</details>

<details><summary>Rust example: <code>cargo run -q --bin eval_entry</code></summary>

```rust
use std::io::Read;
fn main() {
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let req: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let out = my_crate::classify(req["input"].as_str().unwrap_or_default());
    println!("{}", serde_json::json!({ "output": out }));
}
```
</details>

A non-zero exit code means **your code failed**: the trial is scored FAIL with the error as evidence.

### `http`: a running server

```yaml
target: { type: http, url: http://localhost:3000/api/eval, headers: { Authorization: "Bearer dev" } }
```

trialbench POSTs the request JSON and reads the JSON response. Good for Electron/Tauri dev servers, web apps and APIs. HTTP 4xx = your code failed (FAIL); 5xx, timeouts and connection errors are infrastructure errors (see below).

### `function`: import a JS/TS function directly

```yaml
target: { type: function, module: ../src/evals/summarizeTarget.ts, export: evalTarget }
```

```ts
// src/evals/summarizeTarget.ts
import { summarize } from "../summarize.ts";
export async function evalTarget({ input }: { input: { text: string } }) {
  const r = await summarize(input.text);
  return { output: r.text, usage: { costUsd: r.cost } };
}
```

Fastest option for Node/TypeScript projects (no process per case). `.ts` modules work on Node 23.6+ through built-in type stripping (no build step).

**Tip:** wrap the *production* code path, not a copy of it: same prompt builder, same parser, same model settings. Then the eval measures what your users get.

---

## Writing a suite

```yaml
# evals/suites/summarize.yaml
suite: summarize
target: { type: exec, cmd: python -m app.eval_entry }
trials: 3            # repeat each case; use 3-5 for anything non-deterministic
concurrency: 4

graders:             # applied to every case
  - { type: max_length, chars: 500 }
  - { type: not_contains, values: ["as an AI language model"], ignoreCase: true }

cases:
  - id: refund-policy                       # stable id: results and baselines key on it
    input: { text: "file://fixtures/refund.md" }   # file:// is replaced by the file's contents
    reference: "Refunds within 30 days; sale items are final."
    tags: [policy, en]                      # results are broken down by tag
    cluster: refund-doc                     # cases from the same source share a cluster
    graders:
      - { type: contains, values: ["30"] }
      - { type: judge, rubric: faithful-summary }
```

**How many cases?** 20-50 well-chosen cases are a good start. Cover the real distribution of inputs, plus edge cases: empty input, very long input, other languages, adversarial input. Every run prints the **smallest change the suite can detect**; if you need to see a 3-point difference, you need several hundred cases.

**Where do cases come from?** The best source is your own failures. Read real outputs, write down what went wrong, and turn each failure mode into cases and graders.

### Graders

Deterministic graders are free and run first. If any gating one fails, the judges for that trial are skipped (and cost nothing).

| Grader | Passes when |
|---|---|
| `equals` `value` | the output (or `path` inside it) equals the value (key order ignored) |
| `contains` `values` (`all`, `ignoreCase`) | any (or all) of the strings appear |
| `not_contains` `values` (`ignoreCase`) | none of the strings appear |
| `regex` `pattern` (`flags`) | the pattern matches; a leading `(?i)` works too |
| `max_length` `chars` | the text is at most this long |
| `json_schema` `schema` | the output, or a JSON string, matches the JSON Schema |
| `tool_used` `name` (`min`, `max`) | the target reported that tool call (n times) |
| `tool_not_used` `name` | the target did not call that tool |
| `command` `cmd` | your script exits 0; it gets `{"case": ..., "result": ...}` on stdin |
| `judge` `rubric` (`model`) | the LLM judge says PASS for that rubric |

Every grader accepts `path` (dotted path into the output, e.g. `answer.items.0.name`), `id` (a readable name), `weight`, and `gate: false` (report the grade but don't let it decide pass/fail).

A trial **passes** when every gating grader passes. With `threshold: 0.8` on the suite, it passes when the weighted score of the gating graders is at least 0.8. A FAIL always wins; a grader that errors makes the trial ERROR, never a silent PASS.

### LLM judges

Write **one criterion per rubric**, as concrete PASS/FAIL conditions, ideally taken from failures you actually saw:

```yaml
# evals/rubrics/faithful-summary.yaml
id: faithful-summary
version: 1                      # bump it when you change the wording
name: Summary is faithful to the source
pass: Every number, duration, price and condition in the summary appears in the input.
fail: The summary adds, changes or reverses a number, duration, price or condition.
outOfScope: Brevity, tone, formatting and which details were left out.
# fewShots: [{ input, output, critique, verdict: PASS|FAIL }]   # labeled examples, optional
```

What the judge does, following the LLM-as-judge research:

- It writes its **reasoning before the verdict** and quotes the evidence.
- It can answer **UNKNOWN** instead of guessing. UNKNOWN trials are excluded from the pass rate and listed separately.
- It is **blinded**: no model names, run ids or metadata, only input, optional reference, and output.
- Its verdict is **schema-validated JSON**.
- It has **no silent fallback**: if the judge refuses or errors, the grade is ERROR. A judge's accuracy is only known for the model you validated.
- Every verdict records the **judge model, prompt hash and rubric version**, and verdicts are **cached**: re-running unchanged outputs costs nothing.

### Which judge model? (default: `claude-sonnet-5-5`)

The default is chosen by **quality first, cost second**, and it was measured rather than guessed. 68 real outputs from an email-triage feature, all judged against the same rubric:

| Judge | Same verdict as Opus 5.5 | Broken verdicts | Cost per verdict |
|---|---|---|---|
| `claude-opus-5-5` | (reference) | 0 | $0.021 |
| **`claude-sonnet-5-5`** (default) | **67 / 68** | 0 | **$0.010** |
| `claude-haiku-5-5` | 64 / 68 | 2 | $0.0008 |

Sonnet 5.5 matches Opus on almost every verdict at half the price. Haiku is 26× cheaper but produced malformed verdicts and a false FAIL. Fine for a quick draft run, not as the default.

Change it in `trialbench.config.yaml`, per rubric (`model:` in the rubric file) or per grader (`model:` on the judge grader):

```yaml
judge:
  provider: auto        # auto | anthropic | claude-cli
  model: claude-sonnet-5-5
  # effort: medium      # low | medium | high | xhigh | max
```

Use a stronger judge (`claude-opus-5-5`) for subtle criteria. Agreement with Opus is not the same as being right, though: the real test is agreement with **your own** labels (see the roadmap).


---

## Agents and coding agents

Agents change things: files, repos, data. For those, give every trial a **fresh workspace** and grade what the agent left behind.

```yaml
suite: chat-agent
target:
  type: claude-code                 # runs `claude -p` inside the trial's workspace
  model: sonnet
  allowedTools: [Read, Write, Edit, Glob]
  appendSystemPromptCmd: node targets/print-system-prompt.mjs   # your agent's real system prompt
  maxBudgetUsd: 1
workspace:
  template: fixtures/starting-files   # or: git: { repo: .., ref: <commit> }   or: {} for an empty folder
  hidden: [{ from: hidden-tests }]    # copied in only AFTER the agent stops
  protect: ["tests/**"]               # existing files the agent must not touch (checked automatically)
trials: 3
cases:
  - id: landing-page
    input: "Make a one-page landing page for a bakery with three products and opening hours."
    graders:
      - { type: file_exists, path: "Artifacts/*.html", min: 1, max: 1 }
      - { type: file_contains, path: "Artifacts/*.html", pattern: "<script[^>]+src=[\"']https?:", not: true }
      - { type: judge, rubric: artifact-fulfills-request, file: "Artifacts/*.html" }   # judge the FILE
      - { type: budget, maxToolCalls: 8, gate: false }
```

**The `claude-code` target** records every tool call (name, arguments, result, errors), turns, tokens and cost. Hooks are disabled (a Stop hook can replace the answer under `-p`), and only project settings load by default (`settingSources: project`): your repo's `CLAUDE.md` applies, your personal plugins don't skew the result. Options: `model`, `effort`, `prompt` (template with `{{input}}`), `appendSystemPrompt`, `appendSystemPromptCmd`, `allowedTools`, `disallowedTools`, `permissionMode` (default `acceptEdits`), `settingSources`, `maxBudgetUsd`, `extraArgs`, `env`. An agent that runs out of time or budget **failed** the task; only a CLI that never produced a result counts as an infrastructure error. Any other agent works through `exec`: your script gets the workspace path in the request (`workspace`) and in `TRIALBENCH_WORKSPACE`.

**Workspace options:** `template` (copy a folder), `git` (fast local clone at `ref`; refs to later commits are removed so the agent can't read the answer), `remove` (delete paths after copying), `setup` (runs once per trial; its changes don't count as the agent's), `hidden`, `protect`, `protectNew` (also forbid *new* files matching `protect`), `env` (for setup, the agent and checks, e.g. a shared `CARGO_TARGET_DIR`), `keep`. Cases can override any of these. Workspaces are deleted after each trial unless you pass `--keep-workspaces`.

| Agent grader | Passes when |
|---|---|
| `file_exists` `path` (`min`, `max`) | that many files match the glob (`*`, `**`, `?`) |
| `file_contains` `path`, `values` and/or `pattern` (`all`, `ignoreCase`, `not`) | a matching file contains it (with `not`: no matching file does) |
| `files_changed` (`allow`, `forbid`, `min`, `max`) | the agent changed only allowed paths / none of the forbidden ones / that many files |
| `tool_sequence` `names` (`mode`: `in_order` / `exact` / `any_order`) | the tool calls follow that sequence |
| `budget` (`maxToolCalls`, `maxTurns`, `maxCostUsd`, `maxDurationMs`) | the run stayed within budget (usually `gate: false`) |
| `command` | runs **in the workspace** (where hidden tests live), e.g. `cargo test` or `npm test` |
| `judge` with `file:` | the judge grades a file the agent wrote instead of its reply |
| *(automatic)* `tamper` | no protected file was modified |

### Coding tasks from your own git history

The most realistic coding-agent benchmark is your own repo. A commit that added a feature together with its tests becomes a task:

```bash
trialbench task-from-commit .. a1b2c3d --suite coding-agent
#  → tasks/<id>/task.md        instruction: the commit message + the public API the tests import
#  → tasks/<id>/hidden/        the commit's test files (the agent never sees them)
#  → tasks/<id>/oracle.patch   the real change, as the reference solution
#  → a case in suites/coding-agent.yaml: workspace at the commit's parent, graded by the hidden tests
trialbench validate coding-agent    # reference must PASS, doing nothing must FAIL
trialbench run coding-agent -k 3
```

`validate` catches broken tasks (the reference doesn't pass: wrong test command, missing fixture) and trivial ones (passes without any change: the tests don't check the feature). Run it whenever you add tasks. A case can point at its own reference solution with `metadata.oracle`.

---

## Reading the results

| Line | Meaning |
|---|---|
| **Pass rate** `72.0% 95% CI [58.3%, 82.5%]` | The true pass rate is very likely in that range. Cases are the unit of analysis: with several trials, each case scores its own pass rate. Small or extreme samples use the Wilson interval; cases with a `cluster` get clustered standard errors (correlated cases count less). |
| **pass@3 / pass^3** | Chance that at least one of 3 tries works / that all 3 work. pass^k is the number that matters for anything user-facing. |
| **consistency** | 100% = every case gives the same verdict on every trial; 0% = coin flips. |
| **Detectable** | The smallest A/B difference this suite can reliably see (80% power). Smaller differences are noise. |
| **Excluded** | Trials that ended UNKNOWN or ERROR, or hit infrastructure errors. Never counted as passes or fails. |
| **Crashes** | Trials where your code itself failed. These ARE counted as fails. |

**Failures vs infrastructure errors.** A target that exits non-zero, throws, or returns HTTP 4xx has a real bug: FAIL. A timeout, an unreachable server or HTTP 5xx is the environment: retried (`retries`, default 2) and, if it keeps happening, excluded from the score. Otherwise a flaky network would look like a quality drop, or a crashing input would quietly disappear.

Every run writes `runs/<suite>/<runId>/`:

- `trials.jsonl`: one line per trial with everything: input hash, output, tool calls, each grade with evidence, cost, duration.
- `summary.json`: all the numbers above.
- `report.md`: a Markdown report you can paste into a PR.


---

## Feeding results back into development

Every run writes three things next to its records:

| File | For |
|---|---|
| `report.md` | the numbers, for a PR or a ship decision |
| `report.html` (`trialbench view <suite>`) | **reading traces**: every case and trial with input, output, each grade's evidence, tool calls and the workspace diff, filtered to failing and flaky cases |
| `FEEDBACK.md` (`trialbench feedback <suite>`) | **what to fix**, written for a developer or a coding agent |

`FEEDBACK.md` groups failures by **failure mode** (the grader that decided them), not case by case, and gives 2-3 concrete examples of each with input, output and evidence. It separates flaky cases (fail only sometimes: look for ambiguity) from consistent failures, lists what got worse or better than the baseline, and ends with instructions for whoever fixes it: fix root causes rather than cases, don't game the evals (no special-casing inputs, no editing tests or rubrics), keep what passes, then re-run and compare.

The loop:

```bash
trialbench run my-suite -l before
# hand runs/my-suite/<run>/FEEDBACK.md to Claude Code: "Fix what this report describes."
trialbench run my-suite -l after
trialbench compare my-suite          # paired, case by case: did it really help?
trialbench gate my-suite --strict    # nothing that passed before is broken now
```

`compare` pairs the two runs on case ids, which removes case difficulty from the noise, and tells you whether B is significantly better or worse than A, which cases flipped, which graders moved, and how cost and speed changed. Use it for prompt versions, models (`SIFT_MODEL=sonnet …`), effort levels or code changes.

## Can I trust the judge?

An LLM judge is a measuring instrument, and an uncalibrated one can be confidently wrong. trialbench checks it against **your own labels**:

```bash
trialbench label my-suite faithful-summary      # local page: mark real outputs PASS/FAIL (keys P / F / S)
trialbench judge-check faithful-summary         # judge vs your labels on dev and a held-out test split
```

- Labels go to `labels/<rubric>.jsonl` (commit them: they're your ground truth). Aim for ~100, about half PASS and half FAIL; 20 already tells you a lot.
- Labels split deterministically into **train** (few-shot examples), **dev** (tune the rubric against it) and **test** (the honest score: don't tune against it).
- `judge-check` reports TPR (catches real passes), TNR (catches real failures) and Cohen's κ, lists the disagreements with the judge's reasoning, and saves the result. A judge needs **TPR and TNR ≥ 80% on test** to be trusted for CI.
- Once validated, every report shows the judge's pass rate **corrected for its measured error** (Rogan-Gladen with a confidence interval), and warns when the validation is stale because the rubric or judge model changed.
- Try a cheaper judge: `trialbench judge-check faithful-summary -m claude-haiku-5-5`.

---

## CI

```bash
trialbench run my-suite -q                      # run (judge cache keeps reruns cheap)
trialbench gate my-suite --min-pass 0.8         # fail if the CI's LOWER bound is under 80%
trialbench gate my-suite --strict               # also fail if any case got worse than the baseline
```

The gate:

- fails on a **statistically significant** paired drop versus `baselines/<suite>/main.json` (exact McNemar test on the cases that flipped), and lists every case that got worse or better;
- with `--min-pass`, checks the **lower bound** of the 95% CI, not the point estimate (90% on 10 cases is not "above 80%");
- with `--strict`, fails on **any** case that regressed. Use it for small regression suites that should stay at 100%;
- exits `0` pass, `1` regression or below the bar, `2` too many infrastructure errors (the results aren't trustworthy).

When a change is intentional, run it and update the baseline: `trialbench baseline my-suite`, then commit the file.

<details><summary>GitHub Actions example</summary>

```yaml
# .github/workflows/evals.yml
name: evals
on: [pull_request]
jobs:
  evals:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - name: Run evals
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx github:Clemens865/Trialbench -C evals run my-suite -q
          npx github:Clemens865/Trialbench -C evals gate my-suite --strict --min-pass 0.8
      - name: Add report to the job summary
        if: always()
        run: cat evals/runs/my-suite/*/report.md >> "$GITHUB_STEP_SUMMARY"
```
</details>

---

## Use it as a library

```ts
import { loadConfig, loadSuite, runSuite, analyze, formatText } from "trialbench";

const config = loadConfig("evals");
const suite = loadSuite("evals/suites/summarize.yaml");
const run = await runSuite(suite, config, { trials: 3, label: "prompt-v2" });
const analysis = analyze(run.meta, run.records);
console.log(formatText(analysis));
if (analysis.summary.ci.low < 0.8) process.exit(1);
```

The statistics are exported too (`summarize`, `comparePaired`, `wilson`, `passAtK`, `passPowK`, `correctForJudge`, …) if you want them in your own tooling.

---

## Commands

| Command | Does |
|---|---|
| `trialbench init [dir]` | scaffold `evals/` (default) with a working example |
| `trialbench run <suite>` | run a suite. `-k 3` trials, `-t tag1,tag2`, `--case id1,id2`, `-l label`, `-j 8` concurrency, `--no-judge`, `--no-cache`, `--resume <runId>`, `--keep-workspaces`, `--min-pass 0.8` |
| `trialbench report <suite>` | re-print a run (latest by default, `-r <runId>`) |
| `trialbench baseline <suite>` | store a run as the baseline (`-n name` for several) |
| `trialbench gate <suite>` | CI check (`--min-pass`, `--strict`, `--alpha`, `-b name`) |
| `trialbench feedback <suite>` | write `FEEDBACK.md`: failure modes with examples, changes vs baseline, instructions for the fixer |
| `trialbench view <suite>` | open the HTML report with every trace |
| `trialbench compare <suite> [runA] [runB]` | paired comparison of two runs (default: the two latest) |
| `trialbench task-from-commit <repo> <commit>` | turn a commit with tests into a coding-agent task (`--suite`, `--tests`, `--test-cmd`) |
| `trialbench validate <suite>` | reference solutions must pass, doing nothing must fail |
| `trialbench label <suite> <rubric>` | label outputs in a local page (`--grader` for older runs) |
| `trialbench judge-check <rubric>` | validate the judge against your labels (`-m model`, `--dev-only`) |
| `trialbench list` | suites and their latest run |

Global option: `-C <dir>`, the directory with `trialbench.config.yaml` (searched upward from there).

---

## Roadmap

- **Optimization loop:** `trialbench improve`: let a coding agent iterate on a prompt or config against a suite, with a train/test split so it can't overfit, until a target or budget is reached.
- **Sandboxes:** Docker / microVM isolation for agents that run arbitrary commands; network allowlists.
- **More targets:** Codex CLI, OpenAI Agents SDK, and user simulators for multi-turn agents.
- **Robustness:** prompt paraphrases and fault injection (tool timeouts, bad data) reported as a delta from clean runs.
- **Later:** OpenTelemetry export (Langfuse, Opik), synthetic case generation, online sampling of production traffic.

## Background

The design draws on Anthropic's *Demystifying evals for AI agents* and *A statistical approach to model evaluations*; Evan Miller, *Adding Error Bars to Evals* (2024); Chen et al. 2021 (pass@k) and Yao et al. 2024 (τ-bench, pass^k); Hamel Husain and Shreya Shankar on error analysis and judge alignment; Zheng et al. 2023 on LLM-as-judge biases; and Lee et al. 2025 on correcting judge-measured rates.

## Development

```bash
npm install          # also builds (prepare script)
npm test             # vitest
npm run typecheck
```

MIT licensed.
