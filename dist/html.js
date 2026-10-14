// Self-contained HTML report with a trace viewer: the summary, every grader, and every case with its
// trials (input, output, each grade with evidence, tool calls, workspace diff). Built for error
// analysis: start from the failing and flaky cases, read the traces, write down what went wrong.
import { asText } from "./util.js";
const MAX = 30_000;
function trimRecord(r) {
    const out = r.result;
    return {
        caseId: r.caseId,
        trial: r.trial,
        verdict: r.verdict,
        termination: r.termination,
        error: r.error,
        durationMs: r.durationMs,
        output: out ? asText(out.output).slice(0, MAX) : "",
        toolCalls: (out?.toolCalls ?? []).map((c) => ({ name: c.name, args: asText(c.args).slice(0, 2000), result: asText(c.result).slice(0, 2000), error: c.error ?? false })),
        usage: out?.usage ?? {},
        diff: out?.workspace?.diff?.slice(0, MAX) ?? "",
        changed: out?.workspace?.changed ?? [],
        grades: r.grades.map((g) => ({ id: g.graderId, verdict: g.verdict, gate: g.gate, evidence: g.evidence ?? "" })),
    };
}
export function buildHtml(meta, a, records, suite) {
    const inputs = Object.fromEntries((suite?.cases ?? []).map((c) => [c.id, { input: asText(c.input).slice(0, MAX), reference: c.reference === undefined ? null : asText(c.reference).slice(0, MAX), tags: c.tags ?? [] }]));
    const data = { meta, a, inputs, records: records.map(trimRecord) };
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>trialbench: ${meta.suite}</title>
<style>
:root{--bg:#fbfcfd;--fg:#1b2730;--muted:#6b7a86;--line:rgba(27,39,48,.11);--card:#fff;--pass:#2f7d4f;--fail:#b3412e;--warn:#a46a00;--accent:#d97757}
@media (prefers-color-scheme:dark){:root{--bg:#121619;--fg:#e4eaee;--muted:#8d9ba5;--line:rgba(255,255,255,.1);--card:#1a2025;--pass:#5fbf86;--fail:#ef7a66;--warn:#e0a83c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
header{padding:20px 16px;border-bottom:1px solid var(--line)}header h1{margin:0;font-size:20px}.muted{color:var(--muted)}
.wrap{display:grid;grid-template-columns:minmax(220px,320px) 1fr;min-height:calc(100vh - 90px)}
@media (max-width:760px){.wrap{grid-template-columns:1fr}}
nav{border-right:1px solid var(--line);padding:12px;overflow:auto;max-height:calc(100vh - 90px);position:sticky;top:0}
main{padding:16px;min-width:0}
.stats{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px}
.stat b{display:block;font-size:20px}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}.filters button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:4px 10px;cursor:pointer}
.filters button.on{border-color:var(--accent);color:var(--accent)}
.case{display:flex;justify-content:space-between;gap:8px;padding:6px 8px;border-radius:8px;cursor:pointer;word-break:break-all}.case:hover,.case.sel{background:var(--card)}
.dots span{display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:3px}
.PASS{color:var(--pass)}.FAIL{color:var(--fail)}.ERROR,.UNKNOWN{color:var(--warn)}.SKIPPED{color:var(--muted)}
.bgPASS{background:var(--pass)}.bgFAIL{background:var(--fail)}.bgERROR,.bgUNKNOWN{background:var(--warn)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
pre{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px;max-height:420px;overflow:auto;font:12.5px/1.45 ui-monospace,monospace}
details{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:8px 0;padding:8px 12px}summary{cursor:pointer;font-weight:600}
.tabs{display:flex;gap:6px;margin:10px 0}.tabs button{font:inherit;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:8px;padding:4px 10px;cursor:pointer}.tabs button.on{border-color:var(--accent)}
.tool{font:12.5px ui-monospace,monospace;padding:4px 0;border-bottom:1px dashed var(--line)}
</style></head><body>
<header><h1>trialbench · ${meta.suite}</h1><div class="muted" id="sub"></div><div class="stats" id="stats"></div></header>
<div class="wrap"><nav><div class="filters" id="filters"></div><div id="list"></div></nav><main id="main"></main></div>
<script>
const D=${json};
const el=id=>document.getElementById(id), pct=x=>isFinite(x)?(100*x).toFixed(1)+'%':'n/a';
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const s=D.a.summary;
el('sub').textContent='run '+D.meta.runId+(D.meta.label?' · '+D.meta.label:'')+' · '+D.meta.startedAt.slice(0,16).replace('T',' ')+(D.meta.gitCommit?' · code '+D.meta.gitCommit:'');
const stat=(k,v)=>'<div class="stat"><span class="muted">'+k+'</span><b>'+v+'</b></div>';
el('stats').innerHTML=stat('Pass rate',pct(s.mean))+stat('95% CI','['+pct(s.ci.low)+', '+pct(s.ci.high)+']')+(s.passPowK?stat('pass^'+s.passPowK.k,pct(s.passPowK.value)):'')+stat('Cases',s.nItems)+stat('Trials',s.nTrials)+stat('Cost','$'+(D.a.cost.targetUsd+D.a.cost.judgeUsd).toFixed(2));
const cases={};for(const r of D.records)(cases[r.caseId]??=[]).push(r);
const kind=rs=>{const v=rs.map(r=>r.verdict);if(v.every(x=>x==='PASS'))return'pass';if(v.includes('PASS')&&v.includes('FAIL'))return'flaky';if(v.includes('FAIL'))return'fail';return'other'};
let filter='problems', sel=null;
const F={problems:'Failing & flaky',fail:'Failing',flaky:'Flaky',all:'All'};
function renderList(){el('filters').innerHTML=Object.entries(F).map(([k,v])=>'<button class="'+(k===filter?'on':'')+'" onclick="filter=\\''+k+'\\';renderList()">'+v+'</button>').join('');
const ids=Object.keys(cases).sort().filter(id=>{const k=kind(cases[id]);return filter==='all'||(filter==='problems'?k!=='pass':k===filter)});
el('list').innerHTML=ids.length?ids.map(id=>'<div class="case'+(id===sel?' sel':'')+'" onclick="show(\\''+id.replace(/'/g,"\\\\'")+'\\')"><span>'+esc(id)+'</span><span class="dots">'+cases[id].map(r=>'<span class="bg'+r.verdict+'" title="trial '+r.trial+': '+r.verdict+'"></span>').join('')+'</span></div>').join(''):'<p class="muted">Nothing here.</p>';
if(!sel)overview()}
function overview(){el('main').innerHTML='<h2>Graders</h2><table><tr><th>Grader</th><th>Pass rate</th><th>Passed</th><th>Unknown / error / skipped</th></tr>'+D.a.graders.map(g=>'<tr><td>'+esc(g.graderId)+'</td><td>'+pct(g.passRate)+'</td><td>'+g.pass+'/'+(g.pass+g.fail)+'</td><td class="muted">'+g.unknown+' / '+g.error+' / '+g.skipped+'</td></tr>').join('')+'</table>'+(D.a.tags.length?'<h2>By tag</h2><table>'+D.a.tags.map(t=>'<tr><td>'+esc(t.tag)+'</td><td>'+pct(t.mean)+'</td><td class="muted">n='+t.nItems+'</td></tr>').join('')+'</table>':'')+'<p class="muted">Pick a case on the left to read its trials.</p>'}
function show(id){sel=id;renderList();const rs=cases[id],c=D.inputs[id]||{};let t=0;
const trial=r=>'<div class="muted">'+r.termination+' · '+(r.durationMs/1000).toFixed(1)+'s'+(r.usage.costUsd!=null?' · $'+r.usage.costUsd.toFixed(3):'')+(r.usage.turns!=null?' · '+r.usage.turns+' turns':'')+'</div>'+(r.error?'<pre class="FAIL">'+esc(r.error)+'</pre>':'')+
'<h3>Grades</h3><table>'+r.grades.map(g=>'<tr><td class="'+g.verdict+'">'+g.verdict+'</td><td>'+esc(g.id)+(g.gate?'':' <span class="muted">(report only)</span>')+'</td><td>'+esc(g.evidence)+'</td></tr>').join('')+'</table>'+
'<h3>Output</h3><pre>'+esc(r.output)+'</pre>'+
(r.toolCalls.length?'<details><summary>Tool calls ('+r.toolCalls.length+')</summary>'+r.toolCalls.map((x,i)=>'<div class="tool"><b class="'+(x.error?'FAIL':'')+'">'+(i+1)+'. '+esc(x.name)+'</b> '+esc(x.args.slice(0,300))+(x.result?'<div class="muted">→ '+esc(x.result.slice(0,400))+'</div>':'')+'</div>').join('')+'</details>':'')+
(r.diff?'<details><summary>Workspace changes ('+r.changed.length+' files)</summary><pre>'+esc(r.diff)+'</pre></details>':'');
el('main').innerHTML='<h2>'+esc(id)+'</h2>'+(c.tags&&c.tags.length?'<div class="muted">'+c.tags.map(esc).join(' · ')+'</div>':'')+'<details open><summary>Input</summary><pre>'+esc(c.input)+'</pre></details>'+(c.reference!=null?'<details><summary>Reference</summary><pre>'+esc(c.reference)+'</pre></details>':'')+
'<div class="tabs">'+rs.map((r,i)=>'<button data-i="'+i+'" class="'+(i===0?'on ':'')+r.verdict+'">trial '+r.trial+' '+r.verdict+'</button>').join('')+'</div><div id="trial"></div>';
const tabs=el('main').querySelectorAll('.tabs button');const pick=i=>{tabs.forEach(b=>b.classList.toggle('on',+b.dataset.i===i));el('trial').innerHTML=trial(rs[i])};tabs.forEach(b=>b.onclick=()=>pick(+b.dataset.i));pick(0)}
renderList();
</script></body></html>`;
}
