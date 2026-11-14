#!/usr/bin/env node
// Turns a review-map analysis (JSON) into a GitHub pull request comment (Markdown).
// CLI:    node render.mjs <analysis.json> > comment.md
// Module: import { render } from './render.mjs'
//
// Everything in the output is plain GitHub-flavoured Markdown: a Mermaid diagram for the pipeline map,
// <details> blocks for traces and unit cards, and alert blocks for what needs a human.
// Values in the trace tables are copied from the probe result files by this script, and the cause and
// effect tags are computed here, so the reviewing agent cannot word them.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MARKER = '<!-- review-map:v1 -->';

const EVIDENCE = {
  observed: '✅ observed in a run',
  static: '🔎 read in the code',
  stated: '⚠️ stated by the author, not checked',
  none: '⚠️ no evidence',
};
const VERDICT = {
  verified: '✅ Holds',
  partly: '🟡 Partly holds',
  'not-verified': '⚠️ Not verified',
  contradicted: '❌ Does not hold',
  'code-only': '🔎 Holds in the code, not run',
};
const STATUS = {
  changed: 'changed by this PR',
  affected: 'code untouched, behaviour changes',
  same: 'unchanged',
};
const SEVERITY = { CAUTION: '🛑', WARNING: '⚠️', IMPORTANT: '❗', NOTE: 'ℹ️' };
const SEVERITY_ORDER = ['CAUTION', 'WARNING', 'IMPORTANT', 'NOTE'];
const SEVERITY_WORD = { CAUTION: 'caution', WARNING: 'warning', IMPORTANT: 'important', NOTE: 'note' };
const SEVERITY_PLURAL = { CAUTION: 'cautions', WARNING: 'warnings', IMPORTANT: 'important', NOTE: 'notes' };
const REASON_MEANING = { intent: 'the requirement does not say', 'trade-off': 'a policy call with no technically right answer', unreproduced: 'the reported bug never showed before the change', 'out-of-reach': 'the tools here cannot run it' };
const REASON = { intent: '`intent`', 'trade-off': '`trade-off`', unreproduced: '`unreproduced`', 'out-of-reach': '`out-of-reach`' };
const REQ_VERDICT = { met: '✅ met', partly: '🟡 partly', 'not-met': '❌ not met', 'not-shown': '⚠️ not shown' };
const REPRO = {
  reproduced: 'So the bug was reproduced. A "fixed" verdict also needs the symptom gone after the PR.',
  unreproduced: 'So the bug was **not** reproduced, and the script will not let the review say the PR fixes it.',
  'no-repro': 'So the script will not let the review say the PR fixes it.',
  'not-run': 'So the script will not let the review say the PR fixes it.',
  'bad-symptom': 'The prediction could not be checked, so the script will not let the review say the PR fixes it.',
};
// Only people a human named (REVIEW_MAP_OWNERS, or the PR's reviewers and assignees) get an @-mention.
const ownerText = (o) => (o?.login ? `@${o.login}${o.source === 'PR reviewers' ? ' <sub>(from the PR reviewers)</sub>' : ''}` : 'unassigned <sub>(set the repository variable `REVIEW_MAP_OWNERS`)</sub>');
const TAG = { cause: '🟧 **cause**', effect: '🟦 effect', same: 'same' };

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const mm = (s) => String(s).replace(/"/g, '#quot;');
const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// A resolved evidence pointer, as quoted by the script, with a link to the trace it comes from.
// GitHub prefixes every name attribute in a comment with "user-content-"; linking to the prefixed name
// lets the browser jump there by itself, without relying on GitHub's script to map the short form.
const quote = (r) => `${r.resolved?.quote ?? ''}${r.resolved?.anchor ? ` [↗](#user-content-${r.resolved.anchor})` : ''}`;
const quotes = (refs) => (refs ?? []).filter((r) => r.resolved?.ok).map(quote);

// ---- evidence, shown so it stands out ---------------------------------------------------------
// Run and test evidence becomes one `diff` block (red = before the PR, green = after), code evidence a
// `csharp` snippet under a link to the exact lines. Every value comes from the script's resolution of
// the reviewer's pointers (lib/verify.mjs), never from the reviewer's own words.
const safe = (s) => String(s ?? '').replace(/```/g, "'''").replace(/\r?\n/g, ' ');
const dedent = (lines) => {
  const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
  return lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0));
};
function evidence(refs, { traces = true } = {}) {
  const ok = (refs ?? []).filter((r) => r.resolved?.ok);
  if (!ok.length) return [];
  const out = [];
  const diff = [];
  const codes = [];
  for (const r of ok) {
    const d = r.resolved.data;
    if (!d) {
      out.push(`- ${quote(r)}`);
      continue;
    }
    if (d.kind === 'run') {
      // Circled digits are too small to read in a monospace block, so the step number is spelled out.
      const node = String(d.node).replace(/^([①②③④⑤⑥])\s*/, (_, c) => `step ${'①②③④⑤⑥'.indexOf(c) + 1} · `);
      diff.push(`@@ ${d.scenario} · ${node} @@`);
      if (d.side === 'both' && d.differs) diff.push(`- before: ${safe(d.before)}`, `+ after:  ${safe(d.after)}`);
      else if (d.side === 'both') diff.push(`  same before and after: ${safe(d.after)}`);
      else if (d.side === 'before') diff.push(`- before: ${safe(d.value)}`);
      else if (d.side === 'after') diff.push(`+ after:  ${safe(d.value)}`);
      else diff.push(`  ${safe(d.label)}: ${safe(d.value)}`);
    } else if (d.kind === 'test') {
      diff.push(`@@ test ${d.name} @@`, `- before: ${d.before}`, `+ after:  ${d.after}`);
    } else if (d.kind === 'code') {
      codes.push(d);
    }
  }
  if (diff.length) out.push('```diff', ...diff, '```');
  for (const c of codes) {
    out.push(c.url ? `[${c.where}](${c.url})` : c.where, '```csharp', ...dedent(c.lines).map((l) => l.replace(/```/g, "'''")), '```');
  }
  if (traces) {
    const ids = [...new Set(ok.filter((r) => r.kind === 'run').map((r) => r.scenario))];
    if (ids.length) out.push(`<sub>Full trace: ${ids.map((id) => `[${code(id)}](#user-content-trace-${id})`).join(' · ')}</sub>`);
  }
  return out;
}

export async function render(a, { analysisDir = '.' } = {}) {
  const out = [];
  const p = (...lines) => out.push(...lines);
  const replayFor = (id) => (a.integrity?.replay ? a.integrity.replay.replace('{id}', id) : null);
  const found = [...(a.found ?? [])].sort((x, y) => SEVERITY_ORDER.indexOf(x.severity) - SEVERITY_ORDER.indexOf(y.severity));
  const decisions = a.decisions ?? [];
  const notChecked = a.notChecked ?? [];
  const sevCount = (s) => found.filter((f) => f.severity === s).length;

  p(MARKER);
  p(`## Review map · \`${a.pr.branch}\``);
  p('');

  // ---- confidence first: everything below is read in its light ---------------------------------
  if (a.confidence?.length) {
    p('> [!CAUTION]');
    p(`> **Reduced confidence:** ${a.confidence.join(' ')}`);
    p('');
  }

  // ---- at a glance ------------------------------------------------------------------------------
  const glance = [
    ...SEVERITY_ORDER.filter((s) => sevCount(s)).map((s) => `${SEVERITY[s]} ${count(sevCount(s), SEVERITY_WORD[s], SEVERITY_PLURAL[s])}`),
    `🤔 ${count(decisions.length, 'decision', 'decisions')} for you`,
    `⬜ ${notChecked.length} not checked`,
  ];
  p(`**At a glance:** ${glance.join(' · ')}`);
  const t = a.tests ?? {};
  const facts = [];
  if (a.requirements?.length) facts.push(`${a.requirements.filter((r) => r.verdict === 'met').length}/${a.requirements.length} requirements met`);
  if (t.newTests?.length) facts.push(`${t.newTests.filter((x) => x.verdict === 'discriminates').length}/${t.newTests.length} new tests fail without the PR`);
  if (t.coverage?.measured) facts.push(`${t.coverage.reached}/${t.coverage.executable} changed lines ran`);
  if (a.sensitivity?.ran) facts.push(`a known break shows in ${a.sensitivity.detected}/${a.sensitivity.scenarios} inputs`);
  if (facts.length) p(`<sub>Computed from the runs: ${facts.join(' · ')}</sub>`);
  p('');

  // ---- in short -----------------------------------------------------------------------------------
  if (typeof a.summary === 'string') p(a.summary);
  else if (a.summary?.length) p(a.summary.map((s) => s.sentence).join(' '));
  else p('_No summary sentence could be backed by the recorded evidence._');
  p('');

  // ---- what it found ------------------------------------------------------------------------------
  p(`### 🔍 What it found`);
  p('');
  if (!found.length) p('_Nothing the evidence backs._');
  found.forEach((f, i) => {
    p(`**${i + 1}. ${SEVERITY[f.severity]} ${f.statement}**${f.computed ? ' <sub>🤖 computed by the script</sub>' : ''}`);
    p('');
    const ev = evidence(f.refs);
    if (ev.length) p(...ev, '');
  });

  // ---- decisions ----------------------------------------------------------------------------------
  p(`### 🤔 Decisions for you`);
  p('');
  if (!decisions.length) p('_None: every question in this review is settled by the evidence._');
  decisions.forEach((d, i) => {
    p(`**${i + 1}. ${d.question}** · ${REASON[d.reason] ?? code(d.reason)} · owner: ${ownerText(d.owner)}${d.computed ? ' · <sub>🤖 opened by rule</sub>' : ''}`);
    p('');
    p(`> **Why the AI didn't decide:** ${d.detail}`);
    p(`> **What would settle it:** ${d.wouldSettleIt}`);
    if (d.options?.length) p(`> **Options:** ${d.options.map((o, k) => `(${String.fromCharCode(97 + k)}) ${o}`).join(' · ')}`);
    p('');
    const ev = evidence(d.refs);
    if (ev.length) p('<details>', '<summary>Evidence</summary>', '', ...ev, '', '</details>', '');
  });
  if (decisions.length) p(`<sub>Reasons come from a fixed list: ${Object.entries(REASON_MEANING).map(([k, v]) => `\`${k}\` ${v}`).join(' · ')}.</sub>`, '');

  // ---- not checked --------------------------------------------------------------------------------
  p(`### ⬜ What it did not check`);
  p('');
  if (!notChecked.length) p('_Nothing listed._');
  else {
    p('| What | Why not | Risk if wrong | How to check |');
    p('|---|---|---|---|');
    for (const n of notChecked) p(`| ${cell(n.item)}${n.computed ? ' <sub>🤖</sub>' : ''} | ${cell(n.reason)} | ${cell(n.riskIfWrong)} | ${cell(n.howToCheck)} |`);
    p('', '<sub>🤖 added by the script from coverage, the requirement map and the extra builds.</sub>');
  }
  p('');

  // ---- items the gate removed (visible: they say how much of the reviewer's text failed) -----------
  if (a.unverified?.length) {
    p(`### ❌ Not backed by the evidence (${a.unverified.length})`);
    p('');
    p('The reviewer wrote these, but what it pointed to does not exist or shows something else. Treat them as unchecked opinions.');
    p('');
    for (const u of a.unverified) p(`- **${u.section}:** ${u.text.replace(/\n+/g, ' ')}<br><sub>${u.reasons.join('; ')}${u.quotes?.length ? `. The runs show: ${u.quotes.join('; ')}` : ''}</sub>`);
    p('');
  }

  // ---- requirements -------------------------------------------------------------------------------
  if (a.requirements?.length) {
    p(`### 📋 Requirements${a.pr.issueRef ? ` · issue ${code(a.pr.issueRef)}` : ''}`);
    p('');
    const r = a.reproduction;
    if (r && r.status !== 'no-symptom') {
      const predicted = r.symptom?.contains?.length ? `${r.symptom.contains.map(code).join(' or ')} at ${r.node ?? code(r.symptom.handoff)}` : 'nothing';
      const row = (r.rows ?? []).find((x) => x.seen) ?? (r.rows ?? [])[0];
      const seen = !row ? 'no input reproduces the issue' : !row.ran ? `${code(row.id)} did not run` : row.seen ? `seen before the PR (${code(row.value)})${row.seenAfter === false ? `, gone after (${code(row.afterValue)})` : row.seenAfter ? ', **still there after**' : ''}` : `not seen before the PR (${code(row.value)})`;
      const ok = r.status === 'reproduced' && (r.rows ?? []).some((x) => x.seen && x.seenAfter === false);
      p(`🐞 **The reported bug:** ${a.plannedBeforeRuns ? 'predicted before the runs' : 'stated by the reviewer'} as ${predicted}; ${seen}. ${ok ? '✅ A "fixed" verdict is allowed.' : '❌ The script will not let the review say the PR fixes it.'}`);
      p('');
    }
    p('| | Requirement | Verdict | Shown by |');
    p('|---|---|---|---|');
    for (const q of a.requirements) {
      const cov = q.covers.length
        ? q.covers.map((c) => `[${code(c.id)}](#user-content-trace-${c.id}) ${!c.ran ? 'did not run' : c.differs.length ? [...new Set(c.differs)].join('') : 'no change'}`).join('<br>')
        : '_no input_';
      p(`| ${q.id}${q.primary ? ' ★' : ''} | ${cell(q.statement)} | ${REQ_VERDICT[q.verdict]}<br><sub>${cell(q.note)}${q.rule ? `<br>by rule: ${q.rule}` : ''}</sub> | ${cov} |`);
    }
    p('');
    p(`<sub>★ says the reported bug is gone. ①②③④ are the hand-offs that change. ${a.plannedBeforeRuns ? 'Requirements and the expected bug were written before anything ran.' : 'Requirements were written by hand after the runs, so they are not a prediction.'}</sub>`);
    p('');
  }

  // ---- which part causes what, with the code itself -------------------------------------------------
  if (a.effects?.ran && a.effects.groups.length) {
    const blob = a.pr.blob;
    const hunkLink = (h) => (h.whole || !blob ? code(h.label) : `[${h.label}](${blob}/${h.file}#L${h.newStart}${h.newCount > 1 ? `-L${h.newStart + h.newCount - 1}` : ''})`);
    const chips = (list) => {
      const by = new Map();
      for (const x of list) by.set(x.scenario, [...(by.get(x.scenario) ?? []), x.node.split(' ')[0]]);
      return [...by].map(([s, ns]) => `[${code(s)}](#user-content-trace-${s}) ${[...new Set(ns)].join('')}`).join(' · ');
    };
    p('### 🧩 Which part of the change causes what');
    p('');
    p(`<sub>The script rebuilt the PR with one part removed at a time and ran every input through it (${count(a.effects.runs, 'build', 'builds')}). A part **causes** an effect when removing it brings the old value back.</sub>`);
    p('');
    for (const g of a.effects.groups) {
      const parts = g.hunks.map(hunkLink).join(' + ');
      let what;
      if (g.build !== 'ok') what = `did not build without it${g.errors?.[0] ? ` (${code(`${g.errors[0].code}: ${g.errors[0].message}`.slice(0, 90))})` : ''}`;
      else if (!g.needed.length && !g.partly.length && !g.sideEffects.length) what = '**no effect in any input** (nothing here shows what it changes)';
      else what = `**causes** ${chips(g.needed) || '–'}${g.partly.length ? ` · partly ${chips(g.partly)}` : ''}${g.sideEffects.length ? ` · removing it also changes ${chips(g.sideEffects)}` : ''}`;
      p(`- ${parts}${g.hunks.length > 1 ? ' <sub>(grouped: the compiler needs them together)</sub>' : ''} → ${what}`);
      const diff = [];
      let partial = false;
      for (const h of g.hunks) {
        if (h.whole) continue;
        const body = dedent([...(h.removed ?? []), ...(h.added ?? [])]);
        const nr = (h.removed ?? []).length;
        diff.push(`@@ ${h.label} @@`, ...body.map((l, k) => `${k < nr ? '-' : '+'} ${l}`.trimEnd()));
        if (!h.removed || h.moreLines) partial = true;
      }
      const block = ['```diff', ...diff.map((l) => l.replace(/```/g, "'''")), '```'];
      if (diff.length <= 9) p('', ...block.map((l) => `  ${l}`), '');
      else p('', '  <details>', `  <summary>Show the code (${diff.length - g.hunks.length} lines${partial ? ', shortened' : ''})</summary>`, '', ...block.map((l) => `  ${l}`), '', '  </details>', '');
    }
    p('');
  }

  // ---- pipeline map -------------------------------------------------------------------------------
  p('### 🗺️ The change as a pipeline');
  p('');
  p('```mermaid');
  p('flowchart LR');
  for (const n of a.nodes) p(`  ${n.id}["<b>${mm(n.label)}</b><br/>${mm(n.sub)}"]:::${n.status}`);
  for (const e of a.edges) p(`  ${e.from} ${e.changed ? '-.->' : '-->'}${e.label ? `|"${mm(e.label)}"|` : ''} ${e.to}`);
  p('  classDef changed fill:#FAEEDA,stroke:#BA7517,stroke-width:2px,color:#412402');
  p('  classDef affected fill:#E1F5EE,stroke:#0F6E56,color:#04342C');
  p('  classDef same fill:#F1EFE8,stroke:#888780,color:#2C2C2A');
  p('```');
  p('');
  p('<sub>🟧 changed by this PR · 🟩 code untouched, behaviour changes · ⬜ unchanged · dashed arrow: the data on that hand-off changes</sub>');
  p('');

  // ---- traces: one real input followed through every hand-off -----------------------------
  if (a.traces?.cases?.length) {
    const dir = resolve(analysisDir, a.traces.evidence);
    const load = (when) => {
      const f = resolve(dir, `probe-${when}.json`);
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
    };
    const before = load('before');
    const after = load('after');
    const adapterUrl = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), 'adapters', a.traces.adapter ?? 'messagepack', 'handoffs.mjs'));
    const { handoffs } = await import(adapterUrl.href);
    const HANDOFFS = handoffs({ code });

    p('### 🔬 Follow one real input through the pipeline');
    p('');
    p('<sub>Each input ran on the code before and after this PR. Each box shows what crossed that hand-off; 🟧 is where a difference starts, 🟦 what follows from it. Values are copied from the runs by a script.</sub>');
    p('');
    a.traces.cases.forEach((c, i) => {
      const b = before.find((s) => s.id === c.id);
      const f = after.find((s) => s.id === c.id);
      const shown = f ?? b;
      if (!shown) return;
      p(`<a name="trace-${c.id}"></a>`);
      p('');
      p(`<details${i === 0 ? ' open' : ''}>`);
      p(`<summary><b>${c.title}</b></summary>`);
      p('');
      // Cause and effect follow the pipeline graph: a hand-off that differs is a cause when nothing
      // upstream of it differs, and an effect when something upstream does. Parallel branches can
      // therefore each have their own cause.
      const rows = HANDOFFS.map((h) => ({ h, x: h.cell(b), y: h.cell(f) }));
      const differs = Object.fromEntries(rows.map((r) => [r.h.id, r.x.key !== r.y.key]));
      const parentsOf = Object.fromEntries(HANDOFFS.map((h) => [h.id, h.parents ?? []]));
      const upstreamDiffers = (id) => (parentsOf[id] ?? []).some((pid) => differs[pid] || upstreamDiffers(pid));
      const tagOf = (r) => c.tags?.[r.h.id] ?? (!differs[r.h.id] ? 'same' : upstreamDiffers(r.h.id) ? 'effect' : 'cause');

      // The trace as a diagram: the real input enters on the left, each node shows what crossed that
      // hand-off before and after the change.
      const mt = (s) => {
        const t = String(s ?? '');
        return (t.length > 70 ? t.slice(0, 68) + '…' : t).replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
      };
      const NODE_TAG = { cause: '🟧 cause', effect: '🟦 effect', same: 'same' };
      p('```mermaid');
      p('flowchart LR');
      const input = shown.runtime?.valuesIn;
      p(`  n_input["<b>Input</b><br/>${mt(input ? `object: ${input}` : c.title)}"]:::input`);
      for (const r of rows) {
        const tag = tagOf(r);
        const bx = r.h.brief(b);
        const by = r.h.brief(f);
        const body = differs[r.h.id] ? `before: ${mt(bx)}<br/>after: ${mt(by)}` : mt(by);
        p(`  n_${r.h.id}["<b>${mt(r.h.node ?? r.h.label)}</b><br/>${NODE_TAG[tag]}<br/>${body}"]:::${tag}`);
      }
      for (const r of rows) for (const pid of r.h.parents ?? []) p(`  n_${pid} ${differs[r.h.id] ? '-.->' : '-->'} n_${r.h.id}`);
      p('  classDef input fill:#EEEDFE,stroke:#534AB7,color:#26215C');
      p('  classDef cause fill:#FAEEDA,stroke:#BA7517,stroke-width:2px,color:#412402');
      p('  classDef effect fill:#E6F1FB,stroke:#185FA5,color:#0C447C');
      p('  classDef same fill:#F1EFE8,stroke:#888780,color:#5F5E5A');
      p('```');
      p('');
      p('<details>');
      p('<summary>The input as C#</summary>');
      p('');
      p('```csharp');
      const cut = (src) => src.split('\n[MessagePack.GeneratedMessagePackResolver]')[0].trim();
      if (shown.referencedSource) p('// ---- referenced assembly, compiled separately', cut(shown.referencedSource), '');
      p('// ---- your project', cut(shown.projectSource));
      p('```');
      p('');
      p('</details>');
      p('');
      p('<details>');
      p('<summary>Full values at each hand-off</summary>');
      p('');
      p('| Hand-off | Before this PR | After this PR |');
      p('|---|---|---|');
      for (const r of rows) {
        const where = c.where?.[r.h.id] ? `<br><sub>${c.where[r.h.id]}</sub>` : '';
        p(`| ${r.h.label}<br>${TAG[tagOf(r)]}${where} | ${cell(r.x.show)} | ${cell(r.y.show)} |`);
      }
      p('');
      if (replayFor(c.id)) {
        p(`Scenario \`${c.id}\`. Re-run it yourself and compare with this table:`);
        p('');
        p('```bash');
        p(replayFor(c.id));
        p('```');
        p('');
      }
      p('</details>');
      p('');
      p(c.story);
      p('');
      p('</details>');
      p('');
    });
  }

  // ---- more detail, folded ------------------------------------------------------------------------
  p('### More detail');
  p('');
  if (a.tests) {
    const t = a.tests;
    const side = (s) => (s?.built ? `${s.passed}/${s.total} pass` : 'did not build');
    const disc = (t.newTests ?? []).filter((x) => x.verdict === 'discriminates').length;
    p('<details>');
    p(`<summary><b>🧪 Tests</b>: ${side(t.before)} before, ${side(t.after)} after${t.newTests?.length ? ` · ${disc} of ${t.newTests.length} new tests fail without the PR` : ''}${t.coverage?.measured ? ` · ${t.coverage.reached}/${t.coverage.executable} changed lines ran` : ''}</summary>`);
    p('');
    p(`${code(t.project)}. Before: ${t.before?.mode ?? 'the PR\'s source reverted'}.`);
    p('');
    if (t.newTests?.length) {
      const V = {
        discriminates: '✅ fails before, passes after',
        'passes-both': '⚠️ passes before too: does not test this change',
        'fails-after': '❌ fails on this PR',
        'not-run-before': '❔ could not run before (tests reverted)',
        'missing-before': '❔ did not run before',
      };
      p('| New test | Before | After | What it shows |');
      p('|---|---|---|---|');
      for (const x of t.newTests.slice(0, 60)) p(`| ${code(x.name.split('.').slice(-2).join('.'))} | ${x.before ?? '–'} | ${x.after} | ${V[x.verdict]} |`);
      p('');
    }
    const other = (t.changes ?? []).filter((c) => !(t.newTests ?? []).some((x) => x.name === c.name));
    if (other.length) {
      p('Other tests that changed outcome:');
      p('');
      p('| Test | Before | After |');
      p('|---|---|---|');
      for (const ch of other.slice(0, 40)) p(`| ${code(ch.name)} | ${ch.before ?? 'did not exist'} | ${ch.after ?? 'did not exist'} |`);
      p('');
    }
    if (t.coverage?.measured) p(`Changed lines that ran: ${t.coverage.reached} of ${t.coverage.executable} (${t.coverage.byProbe} by an input, ${t.coverage.byTests} by a test)${t.coverage.removedLines ? `; ${t.coverage.removedLines} removed lines are checked by the before side only` : ''}.`, '');
    p('</details>');
    p('');
  }

  if (a.units?.length) {
    p('<details>');
    p(`<summary><b>🔧 Units, input to output</b> (${a.units.length})</summary>`);
    p('');
    for (const u of a.units) {
      p(`**${u.name}** · ${STATUS[u.status]}${u.where ? ` · ${u.where}` : ''}`);
      p('');
      p(`- **Receives:** ${u.receives}`);
      p(`- **Emits:** ${u.emits}`);
      p(`- **What changed:** ${u.change}`);
      p('');
      for (const x of u.examples ?? []) {
        if (x.refs) {
          p(`_${x.note}_`);
          p('');
          const ev = evidence(x.refs, { traces: false });
          if (ev.length) p(...ev, '');
        } else p(`- ${x.input}: ${x.before} → ${x.after} (${EVIDENCE[x.evidence]})`);
      }
    }
    p('</details>');
    p('');
  }

  if (a.claims?.length) {
    const v = a.claims.reduce((m, c) => ((m[c.verdict] = (m[c.verdict] ?? 0) + 1), m), {});
    const open = (v['not-verified'] ?? 0) + (v.contradicted ?? 0) + (v.partly ?? 0);
    p('<details>');
    p(`<summary><b>📝 The author's claims, checked</b>: ${v.verified ?? 0} hold, ${open} need you${v['code-only'] ? `, ${v['code-only']} hold in the code only` : ''}</summary>`);
    p('');
    for (const c of a.claims) {
      p(`**${VERDICT[c.verdict]}:** ${c.claim} <sub>(${c.source})</sub>`);
      p('');
      p(`${c.evidence}`);
      p('');
      const ev = evidence(c.refs, { traces: false });
      if (ev.length) p(...ev, '');
    }
    p('</details>');
    p('');
  }

  p('<details>');
  p('<summary><b>⚙️ How this was checked</b></summary>');
  p('');
  for (const m of a.method.observed) p(`- ${m}`);
  const s = a.sensitivity;
  if (s?.ran) {
    const blind = (s.rows ?? []).filter((r) => !r.handoffs.length).map((r) => code(r.id));
    p(`- Can the probe see a break? A known break (${s.description}) showed in ${s.detected} of ${s.scenarios} inputs${s.where?.length ? `, at ${s.where.join(', ')}` : ''}.${!s.detected ? ' So "no difference" here is weak evidence.' : blind.length ? ` It did not show in ${blind.join(', ')}, so for those inputs "no difference" says less.` : ''}`);
  }
  if (a.method.downgraded?.length) {
    p('');
    p('**Reviewer verdicts the script downgraded**');
    for (const m of a.method.downgraded) p(`- ${m}`);
  }
  p('');
  p('</details>');
  p('');
  p(`<sub>Review map for \`${a.pr.head}\` against \`${a.pr.base}\`. ${a.pr.generatedBy ?? 'Generated by a reviewing agent that did not write this change.'}</sub>`);
  if (a.integrity?.files?.length) {
    p('');
    p(`<sub>Evidence${a.integrity.artifact ? ` ([download](${a.integrity.artifact}), kept 90 days)` : ''}, SHA-256: ${a.integrity.files.map((f) => `${f.name} \`${f.sha256.slice(0, 16)}\``).join(' · ')}</sub>`);
  }

  let md = out.join('\n') + '\n';
  // Never hyperlink upstream issues: a link from a public comment adds an entry to their timeline.
  for (const repo of a.pr.noLinkRepos ?? []) {
    const r = repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    md = md.replace(new RegExp(`\\[([^\\]]*)\\]\\(https://github\\.com/${r}/(?:issues|pull)/(\\d+)[^)]*\\)`, 'g'), '$1 (`' + repo.split('/')[0] + '#$2`)');
    md = md.replace(new RegExp(`https://github\\.com/${r}/(?:issues|pull)/(\\d+)\\S*`, 'g'), '`' + repo.split('/')[0] + '#$1`');
  }
  return md;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const a = JSON.parse(readFileSync(file, 'utf8'));
  process.stdout.write(await render(a, { analysisDir: dirname(resolve(file)) }));
}
