// Human labels for validating LLM judges ("who validates the validators").
//
// `trialbench label` serves a small local page with real outputs from a run; you mark each one
// PASS or FAIL against the rubric and add a short critique. Labels are appended to
// labels/<rubric>.jsonl next to your config (commit them: they are your ground truth).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { asText, getPath, sha256 } from "./util.js";
export const labelsFile = (config, rubric) => join(config.root, "labels", `${rubric}.jsonl`);
export function readLabels(config, rubric) {
    const f = labelsFile(config, rubric);
    if (!existsSync(f))
        return [];
    const byId = new Map();
    for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim())
            continue;
        const l = JSON.parse(line);
        byId.set(l.id, l); // a later label for the same item wins (corrections)
    }
    return [...byId.values()];
}
export const labelId = (rubric, input, output) => sha256({ rubric, input, output }).slice(0, 16);
/** Items to label: every distinct output a judge with this rubric graded in the given runs. */
export function collectItems(records, rubric, inputs, 
/** Output path per grader id, for records made before grades stored what the judge saw. */
pathFor = () => undefined) {
    const seen = new Map();
    for (const r of records) {
        const g = r.grades.find((x) => x.judge?.rubric === rubric || x.graderId === `judge:${rubric}`);
        if (!g || !r.result)
            continue;
        const c = inputs.get(r.caseId);
        const output = g.judge?.subject ?? asText(getPath(r.result.output, pathFor(g.graderId)));
        const id = labelId(rubric, c?.input, output);
        if (!seen.has(id))
            seen.set(id, { id, input: c?.input, output, ...(c?.reference !== undefined ? { reference: c.reference } : {}), source: `${r.runId}/${r.caseId}#${r.trial}`, judgeVerdict: g.verdict });
    }
    return [...seen.values()];
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function page(rubric, items, done) {
    const data = JSON.stringify(items.map((i) => ({ ...i, input: asText(i.input), reference: i.reference === undefined ? null : asText(i.reference), done: done.has(i.id) })));
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Label: ${esc(rubric.name)}</title>
<style>
:root{--bg:#fbfcfd;--fg:#1b2730;--muted:#6b7a86;--line:rgba(27,39,48,.12);--pass:#2f7d4f;--fail:#b3412e;--card:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#14191d;--fg:#e6ecef;--muted:#93a1ab;--line:rgba(255,255,255,.12);--card:#1b2227}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 120px}
h1{font-size:20px;margin:0 0 4px} .muted{color:var(--muted)} .rubric{border:1px solid var(--line);border-radius:12px;padding:12px 16px;margin:16px 0;background:var(--card)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;max-height:340px;overflow:auto;font:13px/1.45 ui-monospace,monospace}
.bar{position:fixed;bottom:0;left:0;right:0;background:var(--bg);border-top:1px solid var(--line);padding:12px 16px}
.bar div{max-width:860px;margin:0 auto;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
button{font:inherit;border-radius:10px;border:1px solid var(--line);padding:8px 16px;cursor:pointer;background:var(--card);color:var(--fg)}
.pass{background:var(--pass);color:#fff;border:0}.fail{background:var(--fail);color:#fff;border:0}
input{flex:1;min-width:200px;font:inherit;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--fg)}
</style></head><body><main>
<h1>${esc(rubric.name)}</h1><div class="muted">Rubric <b>${esc(rubric.id)}</b> v${esc(rubric.version)} · <span id="progress"></span></div>
<div class="rubric"><b>PASS if:</b> ${esc(rubric.pass)}<br><b>FAIL if:</b> ${esc(rubric.fail)}${rubric.outOfScope ? `<br><span class="muted">Out of scope: ${esc(rubric.outOfScope)}</span>` : ""}</div>
<div id="item"></div></main>
<div class="bar"><div><button class="pass" onclick="save('PASS')">Pass (P)</button><button class="fail" onclick="save('FAIL')">Fail (F)</button>
<input id="critique" placeholder="Why? One sentence (optional, but it makes few-shot examples)"><button onclick="move(1)">Skip (S)</button></div></div>
<script>
const items=${data.replace(/</g, "\\u003c")};let i=items.findIndex(x=>!x.done);if(i<0)i=0;
const el=id=>document.getElementById(id);
function render(){const n=items.filter(x=>x.done).length;el('progress').textContent=n+' of '+items.length+' labeled'+(n>=items.length?' · all done, you can close this tab':'');
const it=items[i];if(!it){el('item').innerHTML='<p>Nothing to label.</p>';return}
el('item').innerHTML='<p class="muted">'+(i+1)+' / '+items.length+(it.done?' · already labeled':'')+' · '+it.source+'</p><h3>Input</h3><pre></pre>'+(it.reference!==null?'<h3>Reference</h3><pre></pre>':'')+'<h3>Output</h3><pre></pre>';
const pres=el('item').querySelectorAll('pre');pres[0].textContent=it.input;let k=1;if(it.reference!==null)pres[k++].textContent=it.reference;pres[k].textContent=it.output;el('critique').value=''}
function move(d){i=Math.max(0,Math.min(items.length-1,i+d));const next=items.findIndex((x,j)=>j>=i&&!x.done);if(d>0&&next>=0)i=next;render()}
async function save(v){const it=items[i];await fetch('/label',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:it.id,human:v,critique:el('critique').value})});it.done=true;move(1)}
document.addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;if(e.key==='p')save('PASS');if(e.key==='f')save('FAIL');if(e.key==='s')move(1)});render();
</script></body></html>`;
}
/** Serve the labeling page until the process is stopped. Resolves with the URL once listening. */
export function serveLabeling(config, rubric, items, port = 4677) {
    const file = labelsFile(config, rubric.id);
    mkdirSync(join(config.root, "labels"), { recursive: true });
    const done = new Set(readLabels(config, rubric.id).map((l) => l.id));
    const byId = new Map(items.map((i) => [i.id, i]));
    const server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/label") {
            let body = "";
            req.on("data", (d) => (body += d));
            req.on("end", () => {
                try {
                    const { id, human, critique } = JSON.parse(body);
                    const it = byId.get(id);
                    if (!it || (human !== "PASS" && human !== "FAIL"))
                        throw new Error("bad label");
                    const label = { id, rubric: rubric.id, input: it.input, output: it.output, ...(it.reference !== undefined ? { reference: it.reference } : {}), human, ...(critique ? { critique } : {}), source: it.source, labeledAt: new Date().toISOString() };
                    appendFileSync(file, JSON.stringify(label) + "\n");
                    done.add(id);
                    res.writeHead(204).end();
                }
                catch (e) {
                    res.writeHead(400).end(e.message);
                }
            });
            return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(rubric, items, done));
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(`http://127.0.0.1:${port}/`)));
}
