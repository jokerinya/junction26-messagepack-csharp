#!/usr/bin/env node
// Finishes a hand-written analysis exactly the way `review.mjs analyze` finishes the agent's (lib/finish.mjs):
// the gate resolves its evidence pointers, and the script adds what it decides by rule.
//   node scripts/finish.mjs analyses/2283.source.json --repo <checkout> [--owners <REVIEW_MAP_OWNERS>]
// The source file carries what the plan step would have produced: `plan.requirements`, `plan.symptom`,
// and per scenario `plan.scenarios[id] = { covers, reproducesIssue }`.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ablationSides, fingerprints } from '../lib/checks.mjs';
import { finishAnalysis } from '../lib/finish.mjs';

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const opt = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const file = resolve(process.argv[2]);
const target = resolve(opt('out') ?? file.replace(/\.source\.json$/, '.json'));
const src = JSON.parse(readFileSync(file, 'utf8'));
const dir = resolve(dirname(file), src.traces.evidence);
const load = (f) => (existsSync(resolve(dir, f)) ? JSON.parse(readFileSync(resolve(dir, f), 'utf8')) : []);
const repo = resolve(opt('repo'));
const head = src.pr.headFull;
const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const readCode = (p) => {
  const r = git('show', `${head}:${p}`);
  return r.status === 0 ? r.stdout : null;
};
const here = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib');
const { handoffs } = await import(pathToFileURL(resolve(here, '..', 'adapters', src.traces.adapter, 'handoffs.mjs')).href);
const adapter = (await import(pathToFileURL(resolve(here, '..', 'adapters', src.traces.adapter, 'adapter.mjs')).href)).default;
const H = handoffs({ code });
const tests = load('tests.json');
const before = load('probe-before.json');
const after = load('probe-after.json');
const plan = {
  requirements: src.plan?.requirements ?? [],
  symptom: src.plan?.symptom ?? { handoff: 'model', contains: [], why: '' },
  scenarios: load('scenarios.json').map((s) => ({ ...s, ...(src.plan?.scenarios?.[s.id] ?? { covers: [], reproducesIssue: false }) })),
};
const changed = (tests.changedFiles ?? []).map((f) => f.path);
const otherTestProjects = git('ls-tree', '-r', '--name-only', head)
  .stdout.split('\n')
  .filter((p) => adapter.isTest(p) && p.endsWith('.csproj') && p !== adapter.testProject)
  .map((p) => ({ path: p, name: p.split('/').pop().replace(/\.csproj$/, ''), touched: changed.some((c) => c.startsWith(p.slice(0, p.lastIndexOf('/') + 1))) }));

const fin = finishAnalysis(src, {
  plan,
  issueRef: src.pr.issueRef ?? null,
  pr: { reviewers: [], assignees: [] },
  tests,
  before,
  after,
  mutant: load('probe-mutant.json'),
  extraSides: { ...Object.fromEntries((src.traces.variants ?? []).map((v) => [v.side, { label: v.label, runs: load(v.file) }])), ...ablationSides(tests, load) },
  handoffs: H,
  readCode,
  blob: src.pr.blob,
  ownersSetting: opt('owners') ?? process.env.REVIEW_MAP_OWNERS,
  otherTestProjects,
});
const { results, ...testSummary } = tests;
const v = fin.verified;
const outA = {
  ...v,
  traces: { ...src.traces, cases: fin.traceCases },
  confidence: fin.confidence,
  notChecked: fin.notChecked,
  requirements: fin.requirements,
  reproduction: fin.repro,
  tests: testSummary,
  unverified: fin.unverified,
  sensitivity: fin.sensitivity,
  effects: fin.effects,
  integrity: {
    files: fingerprints(['scenarios.json', 'probe-before.json', 'probe-after.json', 'probe-mutant.json', 'tests.json', ...(src.traces.variants ?? []).map((x) => x.file), ...(tests.ablation?.groups ?? []).filter((g) => g.probe === 'ok').map((g) => `probe-without-${g.id}.json`)].map((f) => resolve(dir, f))),
    artifact: null,
    replay: src.replay ?? null,
  },
  method: { ...src.method, downgraded: fin.downgraded },
};
delete outA.plan;
writeFileSync(target, JSON.stringify(outA, null, 2));
console.log(`${target}: ${fin.unverified.length} unverified, ${fin.downgraded.length} downgraded, ${fin.confidence.length} confidence notes, reproduction ${fin.repro.status}`);
