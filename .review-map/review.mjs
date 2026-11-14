#!/usr/bin/env node
// review-map: an AI reviewer for AI-written pull requests, built so a human can trust what it says.
//
//   node review.mjs plan     --repo <checkout> --pr <n> [--slug owner/repo] --out <dir>
//   node review.mjs evidence --repo <checkout> --out <dir> [--rollforward-sdk]
//   node review.mjs analyze  --repo <checkout> --out <dir>
//   node review.mjs post     --out <dir>
//   node review.mjs all      (the four steps in order, for local runs)
//   node review.mjs replay   --scenario <id> (--run <workflow run id> | --from <dir>) --repo <checkout of the reviewed commit>
//                            re-runs one input before and after and compares it with the recording
//
// plan      The reviewing agent reads the diff and the issue and chooses real inputs to run.      (needs API key)
// evidence  Runs those inputs and the repo's tests on the code before and after the change.         (runs PR code, no secrets)
// analyze   The reviewing agent explains the change from that evidence; a script fills the tables. (needs API key)
// post      Creates or updates one comment on the pull request.                                     (needs GitHub token)
//
// The steps are separate so the GitHub Action can run them in separate jobs: the code under review never
// runs on a machine that holds the API key.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ask } from './lib/claude.mjs';
import { budgetedDiff, linkedIssue, mergeBaseOf, pullRequest } from './lib/context.mjs';
import { collectEvidence } from './lib/evidence.mjs';
import { ablationEffects, ablationSides, fingerprints, reproduction } from './lib/checks.mjs';
import { finishAnalysis } from './lib/finish.mjs';
import { Analysis, AnalysisMap, AnalysisTop, Plan } from './lib/schemas.mjs';
import { MARKER, render } from './render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    repo: { type: 'string', default: '.' },
    pr: { type: 'string' },
    slug: { type: 'string', default: process.env.GITHUB_REPOSITORY },
    out: { type: 'string', default: 'review-map-out' },
    adapter: { type: 'string', default: 'messagepack' },
    'rollforward-sdk': { type: 'boolean', default: false },
    scenario: { type: 'string' },
    run: { type: 'string' },
    from: { type: 'string' },
    'agent-output': { type: 'string' },
  },
});
const step = positionals[0];
const repo = resolve(opt.repo);
const out = resolve(opt.out);
mkdirSync(out, { recursive: true });
const adapter = (await import(new URL(`./adapters/${opt.adapter}/adapter.mjs`, import.meta.url))).default;

const readJson = (f) => JSON.parse(readFileSync(resolve(out, f), 'utf8'));
const writeJson = (f, v) => writeFileSync(resolve(out, f), JSON.stringify(v, null, 2));
const log = (...m) => console.error('[review-map]', ...m);

const ROLE = `You are the reviewing agent in review-map. A different AI agent wrote the pull request you are given, and a human has to decide whether to approve it. You did not write this change, and you do not take its description, comments, docs or tests on trust: they are claims to check.

The human's problem is understanding. They need to see what each unit of the change receives and emits, how the units form a pipeline, and which change causes which effect, shown with real data rather than prose. Everything you produce is checked against real runs by a script, and statements without evidence are labelled as such.`;

function contextBlock(ctx, diff) {
  return [
    `<pipeline>\n${adapter.pipeline}\n</pipeline>`,
    `<pull_request>\nTitle: ${ctx.pr.title}\nBranch: ${ctx.pr.headRef}\n\n${ctx.pr.body}\n</pull_request>`,
    ctx.commitMessage ? `<commit_message>\n${ctx.commitMessage}\n</commit_message>` : '',
    ctx.issue ? `<issue ref="${ctx.issue.ref}">\nTitle: ${ctx.issue.title}\n\n${ctx.issue.body}\n</issue>` : '<issue>No linked issue was found.</issue>',
    `<diff base="${ctx.mergeBase.slice(0, 8)}" head="${ctx.head.slice(0, 8)}">\n${diff}\n</diff>`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

// ---- plan -----------------------------------------------------------------------------------
async function plan() {
  if (!opt.pr || !opt.slug) throw new Error('plan needs --pr and --slug (or GITHUB_REPOSITORY)');
  const pr = pullRequest(opt.slug, opt.pr);
  const head = pr.headSha;
  const mergeBase = mergeBaseOf(repo, pr.baseSha, head);
  const commitMessage = spawnSync('git', ['log', '--format=%B', `${mergeBase}..${head}`], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const ctx = { slug: opt.slug, pr, head, mergeBase, commitMessage, issue: linkedIssue(pr, adapter), adapter: adapter.name };
  writeJson('context.json', ctx);
  const diff = budgetedDiff(repo, mergeBase, head, adapter);

  const system = `${ROLE}

In this step you choose the inputs. The probe described in <pipeline> will run each one through the real pipeline twice, on the code before and after the change, and record what crosses every hand-off. Choose 3 to 6 scenarios that, together, let a human see the cause and effect of this change:
- the issue's own reproduction, when it gives one;
- inputs that reach each new or changed branch in the diff, especially edge cases the author's tests do not cover;
- an input that tests a behaviour the author claims (in the PR, docs, comments or test names);
- one control input that the change should not affect at all.
Pick inputs that would expose a problem if there is one; a scenario that only confirms the happy path is worth little. Each scenario must compile on its own: follow the scenario format exactly. In "why", say in one sentence what the scenario will show.

Before choosing scenarios, break the issue into requirements: short statements of what the issue asks for or reports, each with an id (R1, R2, ...). Mark as primary the one that states the reported bug is gone. If there is no linked issue, take the requirements from the PR description. For each scenario, list in "covers" the requirement ids it exercises, and set "reproducesIssue" on the scenario(s) that reproduce the issue's own report.

Also state the symptom: how the reported bug shows up in a recording of the code before the PR. Give the hand-off id from <pipeline> and one or more short strings, one of which the recorded value at that hand-off will contain on the before side (for example an exception type or a diagnostic id). This is checked against the recording by a script; if the issue's reproduction does not show it, the review will say the bug was not reproduced. If the issue describes no observable symptom, leave "contains" empty.`;

  const user = `${contextBlock(ctx, diff)}

<example_scenarios note="Scenarios written for a different PR, to show the format. Do not reuse them unless they fit this change.">
${JSON.stringify(adapter.exampleScenarios, null, 2)}
</example_scenarios>

Choose the scenarios for this pull request.`;

  const { value, model } = await ask({ system, user, schema: Plan, label: 'plan' });
  writeJson('plan.json', { ...value, model, issueRef: ctx.issue?.ref ?? null });
  writeJson('scenarios.json', value.scenarios);
  log(`plan: ${value.scenarios.length} scenarios: ${value.scenarios.map((s) => s.id).join(', ')}`);
}

// ---- evidence -------------------------------------------------------------------------------
function evidence() {
  const ctx = readJson('context.json');
  const summary = collectEvidence({
    repo,
    adapter,
    mergeBase: ctx.mergeBase,
    head: ctx.head,
    scenariosFile: resolve(out, 'scenarios.json'),
    outDir: resolve(out, 'evidence'),
    rollForwardSdk: opt['rollforward-sdk'],
  });
  summary.runner = process.env.RUNNER_OS ? `GitHub Actions ${process.env.RUNNER_OS}` : process.platform;
  writeJson('evidence/tests.json', summary);
  log(`evidence: probe after=${summary.probe.after} before=${summary.probe.before}; tests after=${summary.after.passed ?? '-'}/${summary.after.total ?? '-'} before=${summary.before.passed ?? '-'}/${summary.before.total ?? '-'}; ${summary.changes.length} changed outcome`);
}

// ---- analyze --------------------------------------------------------------------------------
async function analyze() {
  const ctx = readJson('context.json');
  const plan = readJson('plan.json');
  const tests = readJson('evidence/tests.json');
  const load = (f) => {
    try {
      return readJson(`evidence/${f}`);
    } catch {
      return [];
    }
  };
  const before = load('probe-before.json');
  const after = load('probe-after.json');
  const mutant = load('probe-mutant.json');
  const { digest, handoffs } = await import(new URL(`./adapters/${adapter.name}/handoffs.mjs`, import.meta.url));
  const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
  const HANDOFFS = handoffs({ code });
  const probeDigest = plan.scenarios.map((s) => {
    const b = before.find((x) => x.id === s.id);
    const f = after.find((x) => x.id === s.id);
    const sameFiles = b?.generated && f?.generated ? f.generated.map((g) => ({ file: g.hintName, identical: b.generated.some((h) => h.hintName === g.hintName && h.text === g.text) })) : null;
    const changedText = f?.generated?.filter((g) => !b?.generated?.some((h) => h.hintName === g.hintName && h.text === g.text)).map((g) => ({ file: g.hintName, after: g.text.slice(0, 3000) }));
    return { id: s.id, title: s.title, why: s.why, before: digest(b), after: digest(f), generatedFileComparison: sameFiles, generatedTextAfterWhereDifferent: changedText };
  });
  const diff = budgetedDiff(repo, ctx.mergeBase, ctx.head, adapter);
  const blob = `https://github.com/${ctx.slug}/blob/${ctx.head}`;
  const { results, ...testSummary } = tests;
  const testNames = [...new Set([...Object.keys(results?.after ?? {}), ...Object.keys(results?.before ?? {})])];

  const system = `${ROLE}

In this step you explain the change from evidence. You get the diff, the probe results for the scenarios you chose earlier (recorded on the code before and after the change), and the repo's test results on both sides. Produce the review map.

You never write evidence values yourself; you point at them. A script resolves every pointer (a "ref") against the recordings and quotes the values next to your words. An item whose refs do not resolve, or resolve to something other than what its "expects" says, is moved out of the main comment into an "unverified" section. A ref is one string in one of three forms:
- "run:<scenario>:<handoff>:<side>:<expects>": scenario is an id from <probe_results>; handoff is one of ${HANDOFFS.map((h) => `${h.id} (${h.label})`).join(', ')}; side is before, after or both; with side both, expects says whether that hand-off differs between before and after or is the same (any if it does not matter). Example: "run:dup-keys:generated:both:differs".
- The side can also be "without-<group>" for a recorded run of the PR with one part removed (see perHunkBuilds in <script_findings>), with expects any; for example "run:dup-keys:model:without-H3:any" shows what the model is without hunk H3. Use these to say which part of the change causes an effect.
- "test:<name>:<expects>": name is from <test_names> (the full name, or Class.Method for all its cases); expects is fails-before-passes-after, passes-both, fails-after or any.
- "code:<path>:<start>-<end>": lines in the head commit, for what you read in the code rather than saw in a run. Example: "code:src/Foo/Bar.cs:120-124".
Prefer run and test refs; a claim backed only by code refs is shown as "holds in the code, not run".

- summary: two or three plain sentences: what the change does, whether it does what the issue asked, and the most important thing the human must know. Each sentence with refs.
- nodes and edges: the pipeline from <pipeline>, only the stages this change touches or affects plus their neighbours (4 to 8 nodes). status "changed" if the PR edits that stage's code, "affected" if its code is untouched but its behaviour differs in the evidence, "same" otherwise. Short ids (letters only). Label the edges that match recorded hand-offs with ① model, ② diagnostics, ③ C# files, ④ bytes; mark an edge changed when the evidence shows different data crossing it. An edge without a label has label "".
The top of the comment is three separate lists. Keep facts, decisions and gaps apart:
- found: facts the evidence shows, most important first. statement: one sentence; severity WARNING (a defect or data loss a user would hit), CAUTION (risky behaviour), IMPORTANT (needed to understand the change) or NOTE; refs. A finding with no run or test ref is shown as a NOTE whatever severity you give it. Include what the human can stop worrying about as NOTE items with refs.
- decisions: what you refuse to decide, because it is not yours to decide. question: one question a human answers. reason, from a fixed list: "intent" (the requirement does not say whether this is wanted), "trade-off" (a policy call with no technically right answer), "unreproduced" (a symptom never appeared on the before side), "out-of-reach" (the tools here cannot exercise it, such as a NativeAOT publish or an IDE). detail: one or two sentences on why. wouldSettleIt: what evidence or answer settles it. options: the realistic answers (two or three). refs when evidence bears on it. Do not add the "does this fix the issue" decision when the issue was not reproduced: the script adds that one by rule (see <script_findings>).
- notChecked: what this review did not check: item, reason, riskIfWrong, howToCheck. The script already adds changed lines nothing reached, requirements no scenario covers, and test projects that were not run; do not repeat those.
- requirements: a verdict for each requirement id in <requirements>: "met", "partly", "not-met" or "not-shown", a one-sentence note, and refs. A verdict without a run or test ref that resolves is shown as "not-shown".
- traces: one entry per scenario worth showing, most important first, using the scenario ids. story: one to three sentences of cause and effect, naming the hand-off numbers. where: for the hand-off where the cause lies, point to the code (a Markdown link like [TypeCollector.cs line 239](${blob}/src/...#L239)); use handoff ids from <pipeline>.
- units: the functions or stages that changed and the ones whose behaviour changed, each with where (a code link, or "" if none), status ("changed", "affected" or "same"), what it receives and emits, what changed, and examples. An example is a note (one sentence on what the evidence shows) and refs; the script quotes the before and after values.
- claims: statements the author made (PR text, commit message, docs, code comments, test names and test comments), each with a verdict ("verified", "partly", "not-verified" or "contradicted"), a one-sentence reason, and refs. Include claims that hold. A claim you could not check: verdict "not-verified" and no refs.

Write for a busy engineer: short sentences, no jargon without a gloss, no praise. Code links go to ${blob}. Never link to issues in ${adapter.issueRepo}; write them as \`${adapter.issueRepo.split('/')[0]}#123\`.`;

  const user = `${contextBlock(ctx, diff)}

<probe_results note="Recorded by running the real pipeline. 'before' is the code with the PR's source files reverted.">
${JSON.stringify(probeDigest, null, 1)}
</probe_results>

<test_results>
${JSON.stringify({ project: testSummary.project, after: testSummary.after, before: testSummary.before, changes: testSummary.changes }, null, 1)}
</test_results>

<test_names>
${testNames.join('\n')}
</test_names>

<requirements note="Chosen in the plan step, before anything ran.">
${JSON.stringify((plan.requirements ?? []).map((r) => ({ ...r, coveredBy: plan.scenarios.filter((s) => s.covers?.includes(r.id)).map((s) => s.id) })), null, 1)}
</requirements>

<script_findings note="Computed by a script from the runs and shown in the comment as they are.">
${JSON.stringify({ issueReproduction: reproduction({ plan, before, after, handoffs: HANDOFFS }), perHunkBuilds: (() => { const e = ablationEffects({ tests, before, after, sides: ablationSides(tests, load), handoffs: HANDOFFS }); return e.ran ? e.groups.map((g) => ({ group: g.id, hunks: g.hunks.map((h) => h.label), build: g.build, neededFor: g.needed.map((x) => `${x.scenario} ${x.handoff}`), partlyFor: g.partly.map((x) => `${x.scenario} ${x.handoff}`), notNeededFor: g.notNeeded.map((x) => `${x.scenario} ${x.handoff}`), changesOnlyWithout: g.sideEffects.map((x) => `${x.scenario} ${x.handoff}`) })) : e.reason; })(), newTests: testSummary.newTests, changedLineCoverage: testSummary.coverage }, null, 1)}
</script_findings>

Write the review map.`;

  let a, model, usage;
  if (opt['agent-output']) {
    // Testing aid: reuse a recorded agent response instead of calling the API.
    ({ value: a, model = 'recorded', usage = null } = JSON.parse(readFileSync(resolve(opt['agent-output']), 'utf8')));
    a = Analysis.parse(a);
  } else {
    // Two parallel calls with the same context: one schema with every section is too large a grammar.
    const only = (parts) => `${user}\n\nIn this response, write only these parts of the review map: ${parts}. The other parts are written separately.`;
    const [top, map] = await Promise.all([
      ask({ system, user: only('summary, found, decisions, notChecked, requirements, claims'), schema: AnalysisTop, label: 'analyze (lists and claims)' }),
      ask({ system, user: only('nodes, edges, traces, units'), schema: AnalysisMap, label: 'analyze (map, traces and units)' }),
    ]);
    a = Analysis.parse({ ...top.value, ...map.value });
    model = top.model;
    const sum = (k) => (top.usage?.[k] ?? 0) + (map.usage?.[k] ?? 0);
    usage = { input_tokens: sum('input_tokens'), output_tokens: sum('output_tokens') };
  }
  writeJson('agent-output.json', { value: a, model, usage });

  // The gate and the rules: every pointer is resolved against the recordings and quoted by the script,
  // and the script adds what it decides by rule (lib/finish.mjs).
  const readCode = (p) => {
    const r = spawnSync('git', ['show', `${ctx.head}:${p}`], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  };
  const projects = spawnSync('git', ['ls-tree', '-r', '--name-only', ctx.head], { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .stdout.split('\n')
    .filter((p) => adapter.isTest(p) && p.endsWith('.csproj') && p !== adapter.testProject);
  const changed = (tests.changedFiles ?? []).map((f) => f.path);
  const otherTestProjects = projects.map((p) => {
    const dir = p.slice(0, p.lastIndexOf('/') + 1);
    return { path: p, name: p.split('/').pop().replace(/\.csproj$/, ''), touched: changed.some((c) => c.startsWith(dir)) };
  });
  const fin = finishAnalysis(a, {
    plan,
    issueRef: ctx.issue?.ref ?? null,
    pr: ctx.pr,
    tests,
    before,
    after,
    mutant,
    extraSides: ablationSides(tests, load),
    handoffs: HANDOFFS,
    readCode,
    blob,
    ownersSetting: process.env.REVIEW_MAP_OWNERS,
    otherTestProjects,
  });
  const verified = fin.verified;
  const { unverified, downgraded } = fin;
  const failed = fin.failedScenarios;
  const side = (t) => (t.built ? `${t.passed} passed, ${t.failed} failed` : `did not build (${t.reason})`);
  const runId = process.env.GITHUB_RUN_ID;
  let artifact = null;
  if (runId) {
    const r = spawnSync('gh', ['api', `repos/${ctx.slug}/actions/runs/${runId}/artifacts`, '--jq', '.artifacts[] | select(.name == "evidence") | .id'], { encoding: 'utf8' });
    const id = r.stdout.trim().split('\n')[0];
    if (id) artifact = `${process.env.GITHUB_SERVER_URL ?? 'https://github.com'}/${ctx.slug}/actions/runs/${runId}/artifacts/${id}`;
  }
  const ev = (f) => resolve(out, 'evidence', f);
  const analysis = {
    pr: {
      branch: ctx.pr.headRef,
      head: ctx.head.slice(0, 8),
      base: ctx.mergeBase.slice(0, 8),
      blob,
      issueRef: ctx.issue?.ref ?? null,
      noLinkRepos: [adapter.issueRepo],
      generatedBy: `Generated automatically by review-map with \`${model}\`, which did not write this change${runId ? ` · [workflow run](${process.env.GITHUB_SERVER_URL}/${ctx.slug}/actions/runs/${runId})` : ''}.`,
    },
    confidence: fin.confidence,
    found: verified.found,
    decisions: verified.decisions,
    notChecked: fin.notChecked,
    requirements: fin.requirements,
    reproduction: fin.repro,
    plannedBeforeRuns: true,
    summary: verified.summary,
    nodes: verified.nodes,
    edges: verified.edges,
    traces: {
      evidence: 'evidence',
      adapter: adapter.name,
      cases: fin.traceCases.map((t) => ({ id: t.id, title: t.title, story: t.story, where: Array.isArray(t.where) ? Object.fromEntries(t.where.map((w) => [w.handoff, w.text])) : (t.where ?? {}) })),
    },
    tests: testSummary,
    units: verified.units,
    claims: verified.claims,
    unverified,
    sensitivity: fin.sensitivity,
    effects: fin.effects,
    integrity: {
      files: fingerprints([resolve(out, 'scenarios.json'), ev('probe-before.json'), ev('probe-after.json'), ev('probe-mutant.json'), ev('tests.json'), ...(tests.ablation?.groups ?? []).filter((g) => g.probe === 'ok').map((g) => ev(`probe-without-${g.id}.json`))]),
      artifact,
      replay: runId
        ? `node .review-map/review.mjs replay --run ${runId} --scenario {id} --repo <checkout of ${ctx.head.slice(0, 8)}>`
        : `node review.mjs replay --from ${opt.out} --scenario {id} --repo <checkout of ${ctx.head.slice(0, 8)}>`,
    },
    method: {
      observed: [
        `${plan.scenarios.length} scenarios chosen by the reviewing agent from the diff and the issue, each run through the real generator, analyzer and run-time serializer on both sides${failed.length ? `; ${failed.length} could not run: ${failed.map((f) => `\`${f}\``).join(', ')}` : ''}.`,
        `\`${tests.project}\` on both sides. After: ${side(tests.after)}. Before (${tests.before.mode}): ${side(tests.before)}. ${tests.changes.length} tests changed outcome.`,
        `Built with .NET SDK ${tests.sdk} on ${tests.runner}${tests.pinnedSdk?.version ? ` (the repo pins ${tests.pinnedSdk.version})` : ''}.`,
        `Reviewing agent: \`${model}\`, two calls (choose inputs, requirements and the expected symptom; explain the evidence). It cites evidence as pointers; every value quoted next to its words, the trace tables, the cause and effect tags, the test verdicts, the coverage and the rule-made decisions are computed by a script from the recorded runs.`,
      ],
      downgraded,
    },
    usage,
  };
  writeJson('analysis.json', analysis);
  const md = await render(analysis, { analysisDir: out });
  writeFileSync(resolve(out, 'comment.md'), md);
  log(`analyze: comment.md written (${md.length} chars), ${unverified.length} items unverified, ${downgraded.length} verdicts downgraded, ${analysis.confidence.length} confidence notes`);
}

// ---- replay ---------------------------------------------------------------------------------
// Re-runs one input on the code before and after the change and compares it with the recording,
// so anyone can re-check a finding without trusting the comment.
function replay() {
  if (!opt.scenario) throw new Error('replay needs --scenario <id>, and --run <workflow run id> or --from <local output dir>');
  const work = resolve(out, `replay-${opt.scenario}`);
  mkdirSync(work, { recursive: true });
  let src = opt.from ? resolve(opt.from) : null;
  if (!src) {
    if (!opt.run) throw new Error('replay needs --run <workflow run id> or --from <dir>');
    src = resolve(work, 'recorded');
    const slug = opt.slug ? ['-R', opt.slug] : [];
    for (const [name, dir] of [['plan', src], ['evidence', resolve(src, 'evidence')]]) {
      const r = spawnSync('gh', ['run', 'download', opt.run, ...slug, '-n', name, '-D', dir], { encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`downloading the ${name} artifact failed: ${r.stderr}`);
    }
  }
  // A workflow run's artifacts keep the probe files under evidence/; a hand-written review keeps them beside context.json.
  const recDir = existsSync(resolve(src, 'evidence', 'probe-after.json')) ? resolve(src, 'evidence') : src;
  const ctx = JSON.parse(readFileSync(resolve(src, 'context.json'), 'utf8'));
  const scenarios = JSON.parse(readFileSync(resolve(src, 'scenarios.json'), 'utf8')).filter((s) => s.id === opt.scenario);
  if (!scenarios.length) throw new Error(`no scenario ${opt.scenario} in ${src}`);
  const actualHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout.trim();
  if (actualHead !== ctx.head) throw new Error(`--repo is at ${actualHead.slice(0, 8)}; check out the reviewed commit ${ctx.head.slice(0, 8)} first`);
  const one = resolve(work, 'scenarios.json');
  writeFileSync(one, JSON.stringify(scenarios));

  console.log('Recorded evidence files (compare with the fingerprints in the comment footer):');
  for (const f of fingerprints([resolve(src, 'scenarios.json'), resolve(recDir, 'probe-before.json'), resolve(recDir, 'probe-after.json')])) console.log(`  ${f.sha256}  ${f.name}`);
  log(`replaying ${opt.scenario} on ${ctx.head.slice(0, 8)} and on its source reverted to ${ctx.mergeBase.slice(0, 8)} ...`);
  collectEvidence({ repo, adapter, mergeBase: ctx.mergeBase, head: ctx.head, scenariosFile: one, outDir: work, rollForwardSdk: opt['rollforward-sdk'], probeOnly: true });

  return import(new URL(`./adapters/${adapter.name}/handoffs.mjs`, import.meta.url)).then(({ handoffs }) => {
    const H = handoffs({ code: (s) => s });
    const get = (dir, side) => {
      try {
        return JSON.parse(readFileSync(resolve(dir, `probe-${side}.json`), 'utf8')).find((s) => s.id === opt.scenario);
      } catch {
        return undefined;
      }
    };
    let mismatches = 0;
    console.log(`\n${opt.scenario}`);
    for (const h of H) {
      const now = { before: get(work, 'before'), after: get(work, 'after') };
      const rec = { before: get(recDir, 'before'), after: get(recDir, 'after') };
      const same = ['before', 'after'].every((sd) => h.cell(now[sd]).key === h.cell(rec[sd]).key);
      if (!same) mismatches++;
      console.log(`  ${h.node.padEnd(28)} before: ${h.brief(now.before)}\n  ${''.padEnd(28)} after:  ${h.brief(now.after)}   ${same ? 'matches the recording' : 'DIFFERS FROM THE RECORDING'}`);
    }
    console.log(mismatches ? `\n${mismatches} hand-off(s) differ from the recording.` : '\nEvery hand-off matches the recording.');
  });
}
// ---- post -----------------------------------------------------------------------------------
function post() {
  const ctx = readJson('context.json');
  const gh = (args, input) => spawnSync('gh', args, { encoding: 'utf8', input });
  const me = process.env.REVIEW_MAP_COMMENT_AUTHOR ?? (gh(['api', 'user', '--jq', '.login']).stdout.trim() || 'github-actions[bot]');
  const list = gh(['api', '--paginate', `repos/${ctx.slug}/issues/${ctx.pr.number}/comments`, '--jq', `.[] | select(.user.login == "${me}") | select(.body | startswith("${MARKER}")) | .id`]);
  const existing = list.stdout.trim().split('\n').filter(Boolean).pop();
  const body = JSON.stringify({ body: readFileSync(resolve(out, 'comment.md'), 'utf8') });
  const r = existing
    ? gh(['api', '-X', 'PATCH', `repos/${ctx.slug}/issues/comments/${existing}`, '--input', '-', '--jq', '.html_url'], body)
    : gh(['api', '-X', 'POST', `repos/${ctx.slug}/issues/${ctx.pr.number}/comments`, '--input', '-', '--jq', '.html_url'], body);
  if (r.status !== 0) throw new Error(`posting the comment failed: ${r.stderr}`);
  log(`${existing ? 'updated' : 'posted'}: ${r.stdout.trim()}`);
}

const steps = { plan, evidence, analyze, post, replay };
if (step === 'all') {
  await plan();
  evidence();
  await analyze();
  post();
} else if (steps[step]) {
  await steps[step]();
} else {
  console.error('usage: node review.mjs <plan|evidence|analyze|post|all> [options]  (see the header of this file)');
  process.exit(2);
}
