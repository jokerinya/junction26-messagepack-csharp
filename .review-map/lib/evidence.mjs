// Runs the code under review and records what it does: the probe scenarios and the repo's own tests,
// once on the change ("after") and once with the change's source files reverted ("before").
// This is the only step that executes code from the pull request; it is given no secrets.
//
// Besides the two sides it records three things a script can judge without the reviewing agent:
//   - which of the PR's new tests pass on the old code too (they do not show the change works),
//   - which changed source lines actually ran on the after side (code coverage),
//   - whether the probe notices a known break (a fixed mutation of the after code, probe only).

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (repo, ...args) => {
  const r = sh('git', args, { cwd: repo });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

export function changedFiles(repo, mergeBase, head) {
  return git(repo, 'diff', '--name-status', '--no-renames', `${mergeBase}`, head)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, path] = l.split('\t');
      return { status, path };
    });
}

function parseTrx(file) {
  if (!existsSync(file)) return null;
  const xml = readFileSync(file, 'utf8');
  const results = {};
  for (const m of xml.matchAll(/<UnitTestResult\b[^>]*>/g)) {
    const name = /testName="([^"]*)"/.exec(m[0])?.[1];
    const outcome = /outcome="([^"]*)"/.exec(m[0])?.[1];
    if (name) results[name.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')] = outcome;
  }
  const values = Object.values(results);
  return {
    built: true,
    total: values.length,
    passed: values.filter((v) => v === 'Passed').length,
    failed: values.filter((v) => v === 'Failed').length,
    skipped: values.filter((v) => v === 'NotExecuted').length,
    results,
  };
}

const findFiles = (dir, suffix) => {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) found.push(...findFiles(p, suffix));
    else if (e.name.endsWith(suffix)) found.push(p);
  }
  return found;
};

/** Line hits per source file from Cobertura XML files: Map(normalisedPath -> Map(line -> hits)). */
function parseCobertura(files) {
  const byFile = new Map();
  for (const f of files) {
    const xml = readFileSync(f, 'utf8');
    for (const cls of xml.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
      const filename = /filename="([^"]*)"/.exec(cls[1])?.[1];
      if (!filename) continue;
      const key = filename.replace(/\\/g, '/');
      const lines = byFile.get(key) ?? new Map();
      for (const l of cls[2].matchAll(/<line\b([^>]*)\/?>/g)) {
        const n = Number(/number="(\d+)"/.exec(l[1])?.[1]);
        const hits = Number(/hits="(\d+)"/.exec(l[1])?.[1] ?? 0);
        if (n) lines.set(n, Math.max(lines.get(n) ?? 0, hits));
      }
      byFile.set(key, lines);
    }
  }
  return byFile;
}

function dotnetTest(repo, adapter, { filter, env = {}, resultsDir, trxName, coverage, log }) {
  const args = ['test', adapter.testProject, '-v', 'q', '--filter', filter];
  if (resultsDir) args.push('--results-directory', resultsDir);
  if (trxName) args.push('--logger', `trx;LogFileName=${trxName}`);
  if (coverage) args.push('--collect', 'Code Coverage;Format=cobertura');
  const r = sh('dotnet', args, { cwd: repo, env: { ...process.env, ...env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' } });
  writeFileSync(log, `${r.stdout}\n${r.stderr}`);
  const buildFailed = /Build FAILED|error CS\d+|error MSB\d+/.test(r.stdout) && !/Passed!|Failed!/.test(r.stdout);
  return { status: r.status, buildFailed };
}

function runProbe(repo, adapter, scenariosFile, outDir, label, { coverage = false } = {}) {
  const probeOut = resolve(outDir, `probe-${label}.json`);
  rmSync(probeOut, { force: true });
  const resultsDir = resolve(outDir, `cov-probe-${label}`);
  rmSync(resultsDir, { recursive: true, force: true });
  const r = dotnetTest(repo, adapter, {
    filter: adapter.probeFilter,
    env: { REVIEW_MAP_SCENARIOS: resolve(scenariosFile), REVIEW_MAP_PROBE_OUT: probeOut },
    resultsDir: coverage ? resultsDir : undefined,
    coverage,
    log: resolve(outDir, `probe-${label}.log`),
  });
  return {
    probe: existsSync(probeOut) ? 'ok' : r.buildFailed ? 'build failed' : 'no output',
    coverageFiles: coverage ? findFiles(resultsDir, '.cobertura.xml') : [],
  };
}

function runTests(repo, adapter, outDir, label, { coverage = false } = {}) {
  const trxDir = resolve(outDir, `trx-${label}`);
  rmSync(trxDir, { recursive: true, force: true });
  const r = dotnetTest(repo, adapter, {
    filter: `${adapter.probeFilter.replace('~', '!~')}`,
    resultsDir: trxDir,
    trxName: 'tests.trx',
    coverage,
    log: resolve(outDir, `tests-${label}.log`),
  });
  const trx = findFiles(trxDir, '.trx')[0];
  return {
    tests: (trx && parseTrx(trx)) || { built: false, reason: r.buildFailed ? 'build failed' : `dotnet test exited ${r.status}` },
    coverageFiles: coverage ? findFiles(trxDir, '.cobertura.xml') : [],
  };
}

/** Lines the PR added or changed in each source file (line numbers on the head side), and lines it removed. */
function changedLines(repo, mergeBase, head, paths) {
  const added = new Map();
  let removed = 0;
  if (!paths.length) return { added, removed };
  const diff = git(repo, 'diff', '-U0', '--no-renames', mergeBase, head, '--', ...paths);
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line.startsWith('+++ b/') ? line.slice(6) : null;
      if (file) added.set(file, added.get(file) ?? []);
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h && file) {
      removed += h[1] === undefined ? 1 : Number(h[1]);
      const start = Number(h[2]);
      const n = h[3] === undefined ? 1 : Number(h[3]);
      for (let i = 0; i < n; i++) added.get(file).push(start + i);
    }
  }
  return { added, removed };
}

const ranges = (nums) => {
  const out = [];
  for (const n of [...nums].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else out.push([n, n]);
  }
  return out;
};

/** Changed source lines that the coverage tool counts as executable, and which of them ran. */
function changedLineCoverage({ repo, mergeBase, head, src, probeFiles, testFiles }) {
  const paths = src.filter((f) => f.status !== 'D' && f.path.endsWith('.cs')).map((f) => f.path);
  const { added, removed } = changedLines(repo, mergeBase, head, paths);
  if (!probeFiles.length && !testFiles.length) return { measured: false, reason: 'the coverage collector produced no report', removedLines: removed };
  const probe = parseCobertura(probeFiles);
  const tests = parseCobertura(testFiles);
  const lookup = (map, path) => {
    for (const [k, v] of map) if (k === path || k.endsWith('/' + path)) return v;
    return null;
  };
  const files = [];
  for (const [path, lines] of added) {
    const p = lookup(probe, path);
    const t = lookup(tests, path);
    if (!p && !t) {
      files.push({ path, inReport: false, changed: lines.length, executable: 0, byProbe: 0, byTests: 0, unreached: [] });
      continue;
    }
    const exec = lines.filter((n) => p?.has(n) || t?.has(n));
    const hit = (m, n) => (m?.get(n) ?? 0) > 0;
    const unreached = exec.filter((n) => !hit(p, n) && !hit(t, n));
    files.push({
      path,
      inReport: true,
      changed: lines.length,
      executable: exec.length,
      byProbe: exec.filter((n) => hit(p, n)).length,
      byTests: exec.filter((n) => hit(t, n)).length,
      reached: exec.length - unreached.length,
      unreached: ranges(unreached),
    });
  }
  const sum = (k) => files.reduce((s, f) => s + (f[k] ?? 0), 0);
  return {
    measured: true,
    executable: sum('executable'),
    reached: sum('reached'),
    byProbe: sum('byProbe'),
    byTests: sum('byTests'),
    removedLines: removed,
    files,
  };
}

// ---- per-hunk builds: the PR minus one part, to show which part causes which effect -------------

/** The PR's source hunks with their old and new lines (diff -U0). Added and deleted files are one hunk each. */
function sourceHunks(repo, mergeBase, head, src) {
  const hunks = [];
  for (const f of src.filter((x) => x.path.endsWith('.cs'))) {
    if (f.status === 'A' || f.status === 'D') {
      hunks.push({ file: f.path, whole: f.status, newStart: 1, newCount: 0, oldStart: 1, oldCount: 0 });
      continue;
    }
    const diff = git(repo, 'diff', '-U0', '--no-renames', mergeBase, head, '--', f.path);
    let cur = null;
    for (const line of diff.split('\n')) {
      const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (h) {
        cur = { file: f.path, oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]), oldLines: [], newLines: [] };
        hunks.push(cur);
      } else if (cur && line.startsWith('-') && !line.startsWith('---')) cur.oldLines.push(line.slice(1));
      else if (cur && line.startsWith('+') && !line.startsWith('+++')) cur.newLines.push(line.slice(1));
    }
  }
  return hunks.map((h, i) => ({ ...h, id: `H${i + 1}` }));
}

const hunkLabel = (h) => (h.whole ? `${h.file.split('/').pop()} (${h.whole === 'A' ? 'new file' : 'deleted file'})` : `${h.file.split('/').pop()} ${h.newCount <= 1 ? h.newStart : `${h.newStart}–${h.newStart + h.newCount - 1}`}`);

/**
 * Writes the head version of every file the group touches with the group's hunks reverted, and returns,
 * per file, a map from a line of the written file to its line in the head file (null for reverted lines).
 */
function writeAblation(repo, head, mergeBase, group) {
  const maps = {};
  for (const file of [...new Set(group.map((h) => h.file))]) {
    const hs = group.filter((h) => h.file === file);
    const whole = hs.find((h) => h.whole);
    const target = join(repo, file);
    if (whole?.whole === 'A') {
      rmSync(target, { force: true });
      maps[file] = null;
      continue;
    }
    if (whole?.whole === 'D') {
      writeFileSync(target, git(repo, 'show', `${mergeBase}:${file}`) + '\n');
      maps[file] = null;
      continue;
    }
    const lines = git(repo, 'show', `${head}:${file}`).split('\n');
    // Each entry: the line text and the head line number it came from (null when it is a reverted old line).
    let out = lines.map((t, i) => ({ t, n: i + 1 }));
    for (const h of [...hs].sort((a, b) => b.newStart - a.newStart)) {
      const at = h.newCount === 0 ? h.newStart : h.newStart - 1; // a pure deletion re-inserts after line newStart
      out.splice(at, h.newCount, ...h.oldLines.map((t) => ({ t, n: null })));
    }
    writeFileSync(target, out.map((x) => x.t).join('\n'));
    maps[file] = out.map((x) => x.n);
  }
  return maps;
}

/** Compiler errors in a build log, mapped to the PR hunk whose head lines they fall in. */
export function errorsToHunks(log, repo, hunks, maps) {
  const found = [];
  const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
  const root = norm(resolve(repo)) + '/';
  for (const m of log.matchAll(/^\s*(.+?\.cs)\((\d+),\d+\): error (CS\d+): ([^\r\n[]*)/gm)) {
    let p = norm(m[1]);
    if (p.startsWith(root)) p = p.slice(root.length);
    const file = hunks.find((h) => norm(h.file) === p || p.endsWith('/' + norm(h.file)))?.file ?? p;
    const line = Number(m[2]);
    const map = maps[file];
    const headLine = map ? map[line - 1] : map === undefined ? line : null;
    const hunk = headLine == null ? null : hunks.find((h) => h.file === file && !h.whole && headLine >= h.newStart && headLine < h.newStart + Math.max(h.newCount, 1));
    found.push({ file, line, code: m[3], message: m[4].trim(), hunk: hunk?.id ?? null });
  }
  const seen = new Set();
  return found.filter((e) => !seen.has(`${e.file}:${e.line}:${e.code}`) && seen.add(`${e.file}:${e.line}:${e.code}`));
}

/**
 * For each source hunk, builds the PR without it and runs the probe. A hunk other changed lines depend on
 * cannot be removed alone: the compiler errors name the lines that need it, and the hunks holding those
 * lines join the group, until the build passes. Leaves every file as it was in head.
 */
function ablate({ repo, adapter, mergeBase, head, src, scenariosFile, outDir, touched, maxHunks = 12, maxRuns = 12 }) {
  const hunks = sourceHunks(repo, mergeBase, head, src);
  if (!hunks.length) return { ran: false, reason: 'the PR changes no source file' };
  if (hunks.length > maxHunks) return { ran: false, reason: `the PR has ${hunks.length} source hunks; per-hunk builds run for up to ${maxHunks}`, hunks: hunks.length };
  const restore = () => {
    for (const f of new Set(hunks.map((h) => h.file))) {
      const r = sh('git', ['checkout', head, '--', f], { cwd: repo });
      if (r.status !== 0) rmSync(join(repo, f), { force: true });
    }
  };
  for (const h of hunks) touched.add(h.file);
  const groups = [];
  let runs = 0;
  try {
    for (const start of hunks) {
      let set = [start];
      for (let round = 0; round < 4; round++) {
        const key = set.map((h) => h.id).sort().join('+');
        const known = groups.find((g) => g.id === key);
        if (known) break;
        if (runs >= maxRuns) {
          groups.push({ id: key, hunks: set.map((h) => h.id), build: 'not run', reason: `limit of ${maxRuns} builds reached` });
          break;
        }
        runs++;
        restore();
        const maps = writeAblation(repo, head, mergeBase, set);
        const run = runProbe(repo, adapter, scenariosFile, outDir, `without-${key}`);
        if (run.probe === 'ok') {
          groups.push({ id: key, hunks: set.map((h) => h.id), build: 'ok', probe: 'ok' });
          break;
        }
        const log = existsSync(resolve(outDir, `probe-without-${key}.log`)) ? readFileSync(resolve(outDir, `probe-without-${key}.log`), 'utf8') : '';
        const errors = errorsToHunks(log, repo, hunks, maps);
        const add = [...new Set(errors.map((e) => e.hunk).filter((id) => id && !set.some((h) => h.id === id)))];
        if (!add.length || round === 3) {
          groups.push({ id: key, hunks: set.map((h) => h.id), build: run.probe === 'build failed' ? 'failed' : run.probe, errors: errors.slice(0, 3) });
          break;
        }
        set = [...set, ...hunks.filter((h) => add.includes(h.id))].sort((a, b) => hunks.indexOf(a) - hunks.indexOf(b));
      }
    }
  } finally {
    restore();
  }
  return {
    ran: true,
    hunks: hunks.map((h) => ({ id: h.id, file: h.file, label: hunkLabel(h), newStart: h.newStart, newCount: h.newCount, oldCount: h.oldCount, whole: h.whole ?? null, added: (h.newLines ?? []).slice(0, 40), removed: (h.oldLines ?? []).slice(0, 40), moreLines: Math.max(0, (h.newLines ?? []).length - 40) + Math.max(0, (h.oldLines ?? []).length - 40) })),
    groups,
    runs,
  };
}

/** Test methods the PR adds, read from the added lines of its test files. */
function newTestMethods(repo, mergeBase, head, tests) {
  const paths = tests.filter((f) => f.status !== 'D' && f.path.endsWith('.cs')).map((f) => f.path);
  if (!paths.length) return [];
  const diff = git(repo, 'diff', '-U0', '--no-renames', mergeBase, head, '--', ...paths);
  const names = new Set();
  let pendingAttr = false;
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) {
      pendingAttr = false;
      continue;
    }
    const t = line.slice(1).trim();
    if (/^\[(Fact|Theory|SkippableFact|CombinatorialData|InlineData|MemberData)\b/.test(t)) pendingAttr = pendingAttr || /^\[(Fact|Theory|SkippableFact)\b/.test(t);
    const m = /^(?:public|internal|private)?\s*(?:async\s+)?(?:Task|ValueTask|void)\s+(\w+)\s*\(/.exec(t);
    if (m && pendingAttr) {
      names.add(m[1]);
      pendingAttr = false;
    }
  }
  return [...names];
}

/** For each new test: does it show the change works (fails before, passes after)? */
function classifyNewTests(methods, before, after, beforeMode) {
  const methodOf = (name) => name.split('(')[0].split('.').pop();
  const rows = [];
  for (const [name, outcomeAfter] of Object.entries(after.results ?? {})) {
    if (!methods.includes(methodOf(name))) continue;
    const outcomeBefore = before.results?.[name] ?? null;
    let verdict;
    if (outcomeAfter !== 'Passed') verdict = 'fails-after';
    else if (outcomeBefore === null) verdict = beforeMode === 'tests-reverted' ? 'not-run-before' : 'missing-before';
    else if (outcomeBefore === 'Passed') verdict = 'passes-both';
    else verdict = 'discriminates';
    rows.push({ name, before: outcomeBefore, after: outcomeAfter, verdict });
  }
  return rows.sort((x, y) => x.verdict.localeCompare(y.verdict) || x.name.localeCompare(y.name));
}

/**
 * Runs the probe and the tests on both sides and writes probe-after.json, probe-before.json,
 * probe-mutant.json and tests.json into outDir. Leaves the repository exactly as it found it.
 * probeOnly skips the tests, coverage and the mutation (used by `review.mjs replay`).
 */
export function collectEvidence({ repo, adapter, mergeBase, head, scenariosFile, outDir, rollForwardSdk = false, probeOnly = false }) {
  mkdirSync(outDir, { recursive: true });
  const files = changedFiles(repo, mergeBase, head);
  const src = files.filter((f) => adapter.isSource(f.path));
  const tests = files.filter((f) => adapter.isTest(f.path));
  const touched = new Set();
  const gj = join(repo, 'global.json');
  const pinnedSdk = existsSync(gj) ? JSON.parse(readFileSync(gj, 'utf8')).sdk ?? null : null;

  const revert = (list) => {
    for (const f of list) {
      touched.add(f.path);
      if (f.status === 'A') rmSync(join(repo, f.path), { force: true });
      else git(repo, 'checkout', mergeBase, '--', f.path);
    }
  };
  const restore = () => {
    for (const p of touched) {
      const r = sh('git', ['checkout', head, '--', p], { cwd: repo });
      if (r.status !== 0) sh('git', ['rm', '-q', '--cached', '--ignore-unmatch', p], { cwd: repo });
    }
    sh('git', ['reset', '-q'], { cwd: repo });
    sh('git', ['checkout', head, '--', 'global.json'], { cwd: repo });
    rmSync(join(repo, adapter.probeTarget), { force: true });
  };

  try {
    if (rollForwardSdk) writeFileSync(gj, readFileSync(gj, 'utf8').replace('"rollForward": "patch"', '"rollForward": "latestMajor"'));
    // The SDK the builds below actually use: asked inside the repo, where its global.json applies.
    const sdk = sh('dotnet', ['--version'], { cwd: repo }).stdout.trim() || 'unknown';
    copyFileSync(adapter.probeSource, join(repo, adapter.probeTarget));

    if (probeOnly) {
      const after = runProbe(repo, adapter, scenariosFile, outDir, 'after');
      revert(src);
      let before = runProbe(repo, adapter, scenariosFile, outDir, 'before');
      if (before.probe === 'build failed') {
        revert(tests);
        before = runProbe(repo, adapter, scenariosFile, outDir, 'before');
      }
      return { probe: { after: after.probe, before: before.probe }, sdk };
    }

    // After, with code coverage on, so the changed lines that ran can be counted.
    const afterProbe = runProbe(repo, adapter, scenariosFile, outDir, 'after', { coverage: true });
    const afterTests = runTests(repo, adapter, outDir, 'after', { coverage: true });
    const coverage = changedLineCoverage({ repo, mergeBase, head, src, probeFiles: afterProbe.coverageFiles, testFiles: afterTests.coverageFiles });

    // A known break, to show the probe can see one: the adapter's fixed mutation of the after code.
    let mutation = { applied: false, reason: 'the adapter declares no mutation' };
    if (adapter.mutation) {
      const m = adapter.mutation;
      const file = join(repo, m.file);
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (!text.includes(m.find)) mutation = { applied: false, description: m.description, reason: `the line to mutate was not found in ${m.file}` };
      else {
        touched.add(m.file);
        writeFileSync(file, text.replace(m.find, m.replace));
        const run = runProbe(repo, adapter, scenariosFile, outDir, 'mutant');
        git(repo, 'checkout', head, '--', m.file);
        mutation = { applied: true, description: m.description, file: m.file, probe: run.probe };
      }
    }

    // The PR minus one part at a time, probe only, to show which part of the change causes which effect.
    const ablation = ablate({ repo, adapter, mergeBase, head, src, scenariosFile, outDir, touched });

    // Before: revert only the source files, so the PR's new tests run against the old code.
    // If that does not build (the tests use something the PR added), revert the tests as well.
    revert(src);
    let beforeProbe = runProbe(repo, adapter, scenariosFile, outDir, 'before');
    let beforeTests = runTests(repo, adapter, outDir, 'before');
    let mode = 'source files reverted, the PR\'s tests kept';
    let modeId = 'tests-kept';
    if (beforeProbe.probe === 'build failed' || !beforeTests.tests.built) {
      revert(tests);
      beforeProbe = runProbe(repo, adapter, scenariosFile, outDir, 'before');
      beforeTests = runTests(repo, adapter, outDir, 'before');
      mode = 'source and test files reverted (the PR\'s tests do not compile against the old code)';
      modeId = 'tests-reverted';
    }
    const after = afterTests.tests;
    const before = beforeTests.tests;

    const names = new Set([...Object.keys(after.results ?? {}), ...Object.keys(before.results ?? {})]);
    const changes = [...names]
      .map((name) => ({ name, before: before.results?.[name] ?? null, after: after.results?.[name] ?? null }))
      .filter((c) => c.before !== c.after)
      .sort((x, y) => (x.after === 'Passed') - (y.after === 'Passed') || x.name.localeCompare(y.name));
    const strip = (t) => (t.built ? { built: true, total: t.total, passed: t.passed, failed: t.failed, skipped: t.skipped } : t);
    const summary = {
      project: adapter.testProject,
      after: strip(after),
      before: { ...strip(before), mode, modeId },
      changes,
      newTests: classifyNewTests(newTestMethods(repo, mergeBase, head, tests), before, after, modeId),
      modifiedTestFiles: tests.filter((f) => f.status === 'M').map((f) => f.path),
      probe: { after: afterProbe.probe, before: beforeProbe.probe },
      coverage,
      mutation,
      ablation,
      sdk,
      pinnedSdk,
      rollForwardSdk,
      changedFiles: files,
      results: { before: before.results ?? {}, after: after.results ?? {} },
    };
    writeFileSync(resolve(outDir, 'tests.json'), JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    restore();
  }
}
