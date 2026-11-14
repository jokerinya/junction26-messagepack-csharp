// The gate between the reviewing agent and the comment. The agent cites evidence as pointers (a hand-off
// of a scenario that ran, a test, a range of code lines); this module resolves every pointer against the
// recorded files and quotes what it finds. Items whose pointers do not resolve, or resolve to something
// other than what the agent said they would show, are moved out of the main sections into "unverified".
// Hand-written analyses go through the same gate with `node scripts/finish.mjs`.

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';
const short = (s, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** Outcome pattern of one test across the two sides. */
export function testPattern(before, after) {
  if (after !== 'Passed') return 'fails-after';
  if (before === 'Passed') return 'passes-both';
  if (before == null) return 'new-not-run-before';
  return 'fails-before-passes-after';
}

const RUN_EXPECTS = ['differs', 'same', 'any'];
const TEST_EXPECTS = ['fails-before-passes-after', 'passes-both', 'fails-after', 'any'];

/** Turns a compact pointer string (see lib/schemas.mjs) into an object; objects pass through. */
export function parseRef(r) {
  if (typeof r !== 'string') return r;
  const bad = (why) => ({ kind: 'invalid', text: r, why });
  const [kind, ...rest] = r.trim().split(':');
  if (kind === 'run') {
    if (rest.length !== 4) return bad('expected run:<scenario>:<handoff>:<side>:<expects>');
    const [scenario, handoff, side, expects] = rest;
    if (!RUN_EXPECTS.includes(expects)) return bad(`expects must be one of ${RUN_EXPECTS.join(', ')}`);
    return { kind, scenario, handoff, side, expects };
  }
  if (kind === 'test') {
    if (rest.length < 2) return bad('expected test:<name>:<expects>');
    const expects = rest.pop();
    if (!TEST_EXPECTS.includes(expects)) return bad(`expects must be one of ${TEST_EXPECTS.join(', ')}`);
    return { kind, test: rest.join(':'), expects };
  }
  if (kind === 'code') {
    const m = /^(\d+)(?:-(\d+))?$/.exec(rest.pop() ?? '');
    if (!m || !rest.length) return bad('expected code:<path>:<line>[-<line>]');
    return { kind, path: rest.join(':'), startLine: Number(m[1]), endLine: Number(m[2] ?? m[1]) };
  }
  return bad('unknown kind');
}

/** Parses every pointer in an analysis in place. */
export function normalizeRefs(a) {
  const items = [
    ...(a.summary ?? []),
    ...(a.found ?? []),
    ...(a.decisions ?? []),
    ...(a.requirements ?? []),
    ...(a.claims ?? []),
    ...(a.units ?? []).flatMap((u) => u.examples ?? []),
  ];
  for (const x of items) if (Array.isArray(x.refs)) x.refs = x.refs.map(parseRef);
  return a;
}

/**
 * Resolves every ref in the analysis. Mutates `a`: each ref gets `resolved: { ok, reason?, quote, anchor? }`,
 * failing items are removed from their section and returned in `unverified`, and claim verdicts that
 * only rest on reading the code become `code-only`.
 */
export function verifyAnalysis(a, { before, after, results, handoffs, readCode, blob, extraSides = {} }) {
  const H = Object.fromEntries(handoffs.map((h) => [h.id, h]));
  const find = (side, id) => side.find((s) => s.id === id);
  const usable = (s) => s && !s.probeError;
  const testNames = [...new Set([...Object.keys(results?.after ?? {}), ...Object.keys(results?.before ?? {})])];

  const resolveRaw = (r) => {
    if (r.kind === 'invalid') return { ok: false, reason: `malformed pointer ${code(r.text)}: ${r.why}` };
    if (r.kind === 'run') {
      const h = H[r.handoff];
      const anchor = `trace-${r.scenario}`;
      if (!h) return { ok: false, reason: `no hand-off called ${code(r.handoff)}` };
      // An extra recorded side, such as a what-if build of the PR with one part removed.
      const extra = extraSides[r.side];
      if (extra) {
        const s = find(extra.runs, r.scenario);
        if (!usable(s)) return { ok: false, reason: `scenario ${code(r.scenario)} has no usable ${extra.label} recording` };
        return { ok: true, anchor, quote: `${code(r.scenario)} ${h.node}, ${extra.label}: ${code(short(h.brief(s)))}`, data: { kind: 'run', scenario: r.scenario, node: h.node, side: 'extra', label: extra.label, value: h.brief(s) } };
      }
      if (!['before', 'after', 'both'].includes(r.side)) return { ok: false, reason: `no recorded side called ${code(r.side)}` };
      const b = find(before, r.scenario);
      const f = find(after, r.scenario);
      const need = r.side === 'both' ? [b, f] : [r.side === 'before' ? b : f];
      if (!b && !f) return { ok: false, reason: `scenario ${code(r.scenario)} did not run` };
      if (!need.every(usable)) return { ok: false, reason: `scenario ${code(r.scenario)} has no usable ${r.side === 'both' ? 'before and after' : r.side} recording` };
      const label = `${code(r.scenario)} ${h.node}`;
      if (r.side !== 'both') {
        const s = r.side === 'before' ? b : f;
        return { ok: true, anchor, quote: `${label}, ${r.side}: ${code(short(h.brief(s)))}`, data: { kind: 'run', scenario: r.scenario, node: h.node, side: r.side, value: h.brief(s) } };
      }
      const differs = h.cell(b).key !== h.cell(f).key;
      const quote = differs ? `${label}: before ${code(short(h.brief(b)))} → after ${code(short(h.brief(f)))}` : `${label}: ${code(short(h.brief(f)))} on both sides`;
      if (r.expects === 'differs' && !differs) return { ok: false, anchor, quote, reason: `cited as a difference, but ${h.node} is identical before and after` };
      if (r.expects === 'same' && differs) return { ok: false, anchor, quote, reason: `cited as unchanged, but ${h.node} differs before and after` };
      return { ok: true, anchor, quote, data: { kind: 'run', scenario: r.scenario, node: h.node, side: 'both', differs, before: h.brief(b), after: h.brief(f) } };
    }
    if (r.kind === 'test') {
      let matches = testNames.filter((n) => n === r.test);
      if (!matches.length) matches = testNames.filter((n) => n.endsWith('.' + r.test) || n.split('(')[0].endsWith('.' + r.test) || n.split('(')[0] === r.test);
      if (!matches.length) return { ok: false, reason: `no test called ${code(r.test)} ran` };
      const patterns = [...new Set(matches.map((n) => testPattern(results.before?.[n], results.after?.[n])))];
      const n = matches[0];
      const name = matches.length > 1 ? `${code(short(r.test, 70))} (${matches.length} cases)` : code(short(n.split('.').slice(-2).join('.'), 80));
      const quote = `test ${name}: before ${results.before?.[n] ?? 'did not exist'} → after ${results.after?.[n] ?? 'did not exist'}${patterns.length > 1 ? ' (cases differ)' : ''}`;
      if (r.expects !== 'any' && !(patterns.length === 1 && patterns[0] === r.expects)) {
        return { ok: false, quote, reason: `cited as ${r.expects}, but the recorded outcome is ${patterns.join(' / ')}` };
      }
      return { ok: true, quote, data: { kind: 'test', name: matches.length > 1 ? `${r.test} (${matches.length} cases)` : n.split('(')[0].split('.').slice(-2).join('.'), before: results.before?.[n] ?? 'did not exist', after: results.after?.[n] ?? 'did not exist' } };
    }
    if (r.kind === 'code') {
      const text = readCode?.(r.path);
      if (text == null) return { ok: false, reason: `${code(r.path)} does not exist in the reviewed commit` };
      const lines = text.split('\n');
      const start = Math.round(r.startLine);
      const end = Math.max(start, Math.round(r.endLine));
      if (start < 1 || end > lines.length) return { ok: false, reason: `${code(r.path)} has ${lines.length} lines, not ${start}–${end}` };
      const first = lines.slice(start - 1, end).find((l) => l.trim()) ?? '';
      const where = `${r.path.split('/').pop()} ${start === end ? `line ${start}` : `lines ${start}–${end}`}`;
      const url = blob ? `${blob}/${r.path}#L${start}${end > start ? `-L${end}` : ''}` : null;
      return { ok: true, quote: `${url ? `[${where}](${url})` : where}: ${code(short(first.trim(), 100))}`, data: { kind: 'code', path: r.path, where, url, start, lines: lines.slice(start - 1, Math.min(end, start + 11)).map((l) => l.replace(/\r$/, '')) } };
    }
    return { ok: false, reason: 'unknown evidence kind' };
  };

  // A short label for the compact evidence links at the top of the comment.
  const resolveRef = (r) => {
    const res = resolveRaw(r);
    if (!res.ok) return res;
    if (r.kind === 'run') {
      const num = (H[r.handoff]?.node ?? r.handoff).split(' ')[0];
      const side = r.side === 'both' ? '' : ` ${extraSides[r.side]?.label ?? r.side}`;
      res.short = `[${code(r.scenario)} ${num}${side}](#user-content-${res.anchor})`;
    } else if (r.kind === 'test') res.short = `test ${code(r.test.split('(')[0].split('.').pop())}`;
    else res.short = res.quote.split(': ')[0];
    return res;
  };

  normalizeRefs(a);
  const unverified = [];
  const check = (item, section, text, { allowEmpty = false } = {}) => {
    const refs = item.refs ?? [];
    for (const r of refs) r.resolved = resolveRef(r);
    const failing = refs.filter((r) => !r.resolved.ok);
    if ((!refs.length && !allowEmpty) || failing.length) {
      unverified.push({
        section,
        text,
        reasons: refs.length ? failing.map((r) => r.resolved.reason) : ['cites no evidence'],
        quotes: refs.filter((r) => r.resolved.quote).map((r) => r.resolved.quote),
      });
      return false;
    }
    return true;
  };

  a.summary = (a.summary ?? []).filter((s) => check(s, 'Summary', s.sentence));
  const downgraded = [];
  const observed = (x) => (x.refs ?? []).some((r) => r.kind !== 'code' && r.resolved?.ok);
  // Script-computed items carry their own evidence and are not the agent's words.
  a.found = (a.found ?? []).filter((x) => {
    if (x.computed) return true;
    if (!check(x, 'Found', x.statement)) return false;
    // Only a run or a test can make a finding a warning; code reading alone cannot.
    if (['WARNING', 'CAUTION'].includes(x.severity) && !observed(x)) {
      downgraded.push(`"${short(x.statement, 120)}": marked ${x.severity}, but no run or test shows it, so it is shown as a note`);
      x.severity = 'NOTE';
    }
    return true;
  });
  a.decisions = (a.decisions ?? []).filter((x) => {
    if (!x.computed) return check(x, 'Refused to decide', x.question, { allowEmpty: true });
    for (const r of x.refs ?? []) r.resolved = resolveRef(r);
    return true;
  });
  // Requirement verdicts stay in the table; a verdict the evidence does not back becomes "not shown".
  for (const r of a.requirements ?? []) {
    for (const ref of r.refs ?? []) ref.resolved = resolveRef(ref);
    const failing = (r.refs ?? []).filter((x) => !x.resolved.ok);
    if (r.verdict !== 'not-shown' && (failing.length || !observed(r))) {
      downgraded.push(`${r.id}: marked ${r.verdict}, but ${failing.length ? `its evidence did not resolve (${failing.map((x) => x.resolved.reason).join('; ')})` : 'no run or test shows it'}, so it is shown as not shown`);
      r.verdict = 'not-shown';
    }
  }
  for (const u of a.units ?? []) u.examples = (u.examples ?? []).filter((x) => check(x, `Unit ${u.name}`, x.note));
  a.claims = (a.claims ?? []).filter((c) => {
    // An honest "not verified" without evidence stays in the claims table.
    const ok = check(c, 'Claims', `"${c.claim}" (${c.verdict})`, { allowEmpty: c.verdict === 'not-verified' });
    if (ok && c.verdict !== 'not-verified' && !c.refs.some((r) => r.kind !== 'code')) {
      downgraded.push(`"${short(c.claim, 120)}": marked ${c.verdict}, but its evidence is only code reading, so it is shown as "holds in the code, not run"`);
      c.verdict = 'code-only';
    }
    return ok;
  });
  return { unverified, downgraded };
}
