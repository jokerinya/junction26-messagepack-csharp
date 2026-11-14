// Judgements the script makes on its own from the recorded evidence, with no reviewing agent involved:
// how far the run can be trusted (confidence), whether the probe notices a known break (sensitivity),
// what the human should look at regardless of what the agent says (computed attention items), and
// fingerprints of the evidence files (integrity).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

const code = (s) => '`' + String(s).replace(/`/g, "'") + '`';

/** Does the SDK that ran satisfy the global.json pin and its rollForward policy? */
export function sdkSatisfies(actual, pin) {
  if (!pin?.version || !actual) return true;
  const [aM, am, ap] = actual.split(/[.-]/).map(Number);
  const [pM, pm, pp] = pin.version.split(/[.-]/).map(Number);
  const band = (n) => Math.floor(n / 100);
  const atLeast = aM > pM || (aM === pM && (am > pm || (am === pm && ap >= pp)));
  switch (pin.rollForward ?? 'patch') {
    case 'disable':
      return actual === pin.version;
    case 'patch':
    case 'latestPatch':
      return aM === pM && am === pm && band(ap) === band(pp) && ap >= pp;
    case 'feature':
    case 'latestFeature':
      return aM === pM && am === pm && ap >= pp;
    case 'minor':
    case 'latestMinor':
      return aM === pM && atLeast;
    default:
      return atLeast;
  }
}

/** Reasons to trust this run less, shown at the top of the comment. Empty when the run is clean. */
export function confidence({ tests, failedScenarios, sensitivity }) {
  const out = [];
  const pin = tests.pinnedSdk;
  if (pin?.version && !sdkSatisfies(tests.sdk, pin)) {
    out.push(`Built with .NET SDK ${tests.sdk}, but the repo pins ${pin.version} (rollForward ${pin.rollForward ?? 'patch'})${tests.rollForwardSdk ? '; the pin was overridden for this run' : ''}. Compiler and analyzer behaviour can differ between SDKs.`);
  }
  if (tests.before?.modeId === 'tests-reverted') {
    out.push("The PR's tests do not compile against the old code, so the before side ran the old tests. Test outcomes before and after are not the same tests, and the new tests' value cannot be judged.");
  }
  for (const side of ['before', 'after']) if (tests.probe?.[side] !== 'ok') out.push(`The probe did not run on the ${side} side (${tests.probe?.[side] ?? 'not recorded'}), so the traces have no ${side} values.`);
  for (const side of ['before', 'after']) if (tests[side] && !tests[side].built) out.push(`The tests did not run on the ${side} side (${tests[side].reason}).`);
  if (failedScenarios.length) out.push(`${failedScenarios.length} chosen input(s) could not run: ${failedScenarios.map(code).join(', ')}.`);
  if (!tests.coverage?.measured) out.push(`Which changed lines ran is unknown: ${tests.coverage?.reason ?? 'coverage was not recorded'}.`);
  if (!sensitivity?.ran) out.push(`The probe's ability to see a break was not checked: ${sensitivity?.reason ?? 'no mutation run'}.`);
  else if (!sensitivity.detected) out.push(`With a known break (${sensitivity.description}) the probe showed no difference in any scenario, so "no difference" in this review means little.`);
  return out;
}

/** Runs the adapter's fixed mutation result against the after side: which scenarios and hand-offs light up. */
export function sensitivity({ tests, after, mutant, handoffs }) {
  const m = tests.mutation;
  if (!m?.applied) return { ran: false, reason: m?.reason ?? 'no mutation recorded' };
  if (m.probe !== 'ok' || !mutant.length) return { ran: false, description: m.description, reason: `the probe did not run on the mutated code (${m.probe})` };
  const rows = [];
  for (const f of after) {
    const x = mutant.find((s) => s.id === f.id);
    if (!x || f.probeError || x.probeError) continue;
    rows.push({ id: f.id, handoffs: handoffs.filter((h) => h.cell(f).key !== h.cell(x).key).map((h) => h.node) });
  }
  const hit = rows.filter((r) => r.handoffs.length);
  const where = [...new Set(hit.flatMap((r) => r.handoffs))];
  return { ran: true, description: m.description, file: m.file, scenarios: rows.length, detected: hit.length, where, rows };
}

// ---- which part of the change causes what (per-hunk builds) -------------------------------------

/** Recorded runs of the PR minus each hunk group, as extra sides that evidence pointers can cite. */
export function ablationSides(tests, load) {
  const ab = tests.ablation;
  if (!ab?.ran) return {};
  const label = (g) => `without ${g.hunks.map((id) => ab.hunks.find((h) => h.id === id)?.label ?? id).join(' + ')}`;
  return Object.fromEntries(ab.groups.filter((g) => g.probe === 'ok').map((g) => [`without-${g.id}`, { label: label(g), runs: load(`probe-without-${g.id}.json`) }]));
}

/**
 * For each hunk group: at the hand-offs where the PR changes something, does removing the group bring the
 * before value back (needed), leave the after value (not needed), or give a third value (partly)? Also
 * where removing it changes a hand-off the PR itself leaves alone.
 */
export function ablationEffects({ tests, before, after, sides, handoffs }) {
  const ab = tests.ablation;
  if (!ab?.ran) return { ran: false, reason: ab?.reason ?? 'per-hunk builds were not run', groups: [] };
  const groups = ab.groups.map((g) => {
    const side = sides[`without-${g.id}`];
    const hunks = g.hunks.map((id) => ab.hunks.find((h) => h.id === id)).filter(Boolean);
    const out = { id: g.id, side: `without-${g.id}`, hunks, build: g.build, errors: g.errors ?? [], needed: [], partly: [], notNeeded: [], sideEffects: [] };
    if (!side) return out;
    for (const f of after) {
      const b = before.find((x) => x.id === f.id);
      const w = side.runs.find((x) => x.id === f.id);
      if (!b || !w || b.probeError || f.probeError || w.probeError) continue;
      for (const h of handoffs) {
        const kb = h.cell(b).key;
        const ka = h.cell(f).key;
        const kw = h.cell(w).key;
        const at = { scenario: f.id, handoff: h.id, node: h.node };
        if (kb === ka) {
          if (kw !== ka) out.sideEffects.push(at);
        } else if (kw === kb) out.needed.push(at);
        else if (kw === ka) out.notNeeded.push(at);
        else out.partly.push(at);
      }
    }
    return out;
  });
  return { ran: true, groups, runs: ab.runs };
}

// ---- what the script finds, refuses to decide, and leaves unchecked, by rule ----------------------

const testShort = (name) => code(name.split('(')[0].split('.').pop());

/** Findings the script derives from the test runs; the reviewing agent cannot word or remove them. */
export function computedFound({ tests }) {
  const items = [];
  const all = tests.newTests ?? [];
  const weak = all.filter((t) => t.verdict === 'passes-both');
  if (weak.length) {
    items.push({
      severity: 'WARNING',
      statement: `${weak.length} of ${all.length} new tests also pass on the old code, so they do not test this change: ${weak.map((t) => testShort(t.name)).join(', ')}.`,
      computed: true,
    });
  }
  const broken = all.filter((t) => t.verdict === 'fails-after');
  if (broken.length) items.push({ severity: 'CAUTION', statement: `${broken.length} new tests fail on this PR: ${broken.map((t) => testShort(t.name)).join(', ')}.`, computed: true });
  return items;
}

/**
 * Was the issue's reported bug visible on the code before the PR? The symptom was stated in the plan,
 * before anything ran; here it is looked up in the recording of each scenario marked as the issue's
 * reproduction.
 */
export function reproduction({ plan, before, after = [], handoffs }) {
  const symptom = plan.symptom ?? { contains: [] };
  const repros = (plan.scenarios ?? []).filter((s) => s.reproducesIssue);
  if (!symptom.contains?.length) return { status: 'no-symptom', symptom, rows: [] };
  if (!repros.length) return { status: 'no-repro', symptom, rows: [] };
  const h = handoffs.find((x) => x.id === symptom.handoff);
  if (!h) return { status: 'bad-symptom', symptom, rows: [], reason: `the plan names no hand-off called ${code(symptom.handoff)}` };
  const rows = repros.map((s) => {
    const b = before.find((x) => x.id === s.id);
    if (!b || b.probeError) return { id: s.id, ran: false, seen: false };
    const has = (x) => {
      const text = `${h.brief(x)}\n${h.cell(x).show}`.toLowerCase();
      return symptom.contains.find((c) => text.includes(c.toLowerCase())) ?? null;
    };
    const hit = has(b);
    // "Fixed" also needs the symptom gone on the after side.
    const f = after.find((x) => x.id === s.id);
    const afterRan = Boolean(f && !f.probeError);
    return { id: s.id, ran: true, seen: Boolean(hit), match: hit, value: h.brief(b), afterRan, seenAfter: afterRan ? Boolean(has(f)) : null, afterValue: afterRan ? h.brief(f) : null };
  });
  const status = rows.some((r) => r.seen) ? 'reproduced' : rows.some((r) => r.ran) ? 'unreproduced' : 'not-run';
  return { status, symptom, node: h.node, rows };
}

/** Decisions the script opens by rule, independent of the reviewing agent's judgement. */
export function ruleDecisions({ repro, issueRef }) {
  if (!issueRef) return [];
  const what = issueRef ? `the issue ${code(issueRef)}` : 'the reported bug';
  const symptomText = repro.symptom?.contains?.map(code).join(' or ');
  const base = { reason: 'unreproduced', computed: true, refs: [] };
  if (repro.status === 'unreproduced') {
    const shown = repro.rows.filter((r) => r.ran).map((r) => `${code(r.id)} shows ${code(r.value)} at ${repro.node}`).join('; ');
    return [{
      ...base,
      question: `Does this PR fix ${what}?`,
      detail: `The plan predicted the bug would show as ${symptomText} at ${repro.node} on the code before the PR. The issue's reproduction does not show it there (${shown}), so the review cannot say the PR fixes it.`,
      wouldSettleIt: "The reporter's own reproduction, or a scenario that shows the reported symptom on the base code.",
      options: ['Ask the reporter for their exact project or repro', 'Accept the PR as fixing a related crash, and keep the issue open'],
      refs: repro.rows.filter((r) => r.ran).map((r) => `run:${r.id}:${repro.symptom.handoff}:before:any`),
    }];
  }
  if (repro.status === 'no-repro' || repro.status === 'not-run' || repro.status === 'bad-symptom') {
    return [{
      ...base,
      question: `Does this PR fix ${what}?`,
      detail: repro.status === 'no-repro' ? "No scenario reproduces the issue's own report, so the review cannot say the PR fixes it." : repro.status === 'not-run' ? "The issue's reproduction did not run on the code before the PR." : `The expected symptom could not be checked: ${repro.reason}.`,
      wouldSettleIt: "A scenario that shows the reported symptom on the base code, or the reporter's confirmation.",
      options: ['Add the reporter\'s reproduction and re-run the review', 'Confirm with the reporter'],
    }];
  }
  return [];
}

/**
 * The requirement table: each requirement from the plan, the scenarios that cover it with what they
 * recorded, and the reviewing agent's verdict after the gate. Rules applied here:
 *   - a requirement no scenario covers (or none that ran) gets "not shown";
 *   - when the issue was not reproduced, a primary requirement cannot be "met".
 */
export function requirementTable({ plan, verdicts, before, after, handoffs, repro }) {
  const downgraded = [];
  const rows = (plan.requirements ?? []).map((r) => {
    const covers = (plan.scenarios ?? [])
      .filter((s) => s.covers?.includes(r.id))
      .map((s) => {
        const b = before.find((x) => x.id === s.id);
        const f = after.find((x) => x.id === s.id);
        const ran = Boolean(b && f && !b.probeError && !f.probeError);
        return { id: s.id, ran, differs: ran ? handoffs.filter((h) => h.cell(b).key !== h.cell(f).key).map((h) => h.node.split(' ')[0]) : [] };
      });
    const v = verdicts.find((x) => x.id === r.id) ?? { verdict: 'not-shown', note: 'The reviewing agent gave no verdict.', refs: [] };
    let { verdict, note } = v;
    let rule = null;
    if (!covers.some((c) => c.ran)) {
      rule = covers.length ? 'the scenarios that cover it did not run' : 'no scenario covers it';
    } else if (r.primary && verdict === 'met' && repro && !['reproduced', 'no-symptom'].includes(repro.status)) {
      rule = 'the reported bug was never reproduced on the code before the PR';
    } else if (r.primary && verdict === 'met' && repro?.status === 'reproduced' && !repro.rows.some((x) => x.seen && x.seenAfter === false)) {
      rule = 'the reported symptom is still there after the PR';
    }
    if (rule && verdict !== 'not-shown') {
      downgraded.push(`${r.id} "${r.statement}": marked ${verdict}, but ${rule}, so it is shown as not shown`);
      verdict = 'not-shown';
    }
    return { id: r.id, statement: r.statement, primary: r.primary, covers, verdict, note, refs: v.refs ?? [], rule };
  });
  return { rows, downgraded };
}

/** Not-checked items the script derives: coverage gaps, uncovered requirements, scenarios and test projects that did not run. */
export function computedNotChecked({ tests, blob, requirements, failedScenarios, otherTestProjects, effects }) {
  const items = [];
  const link = (h) => (h.whole ? code(h.file) : `[${h.label}](${blob}/${h.file}#L${h.newStart}${h.newCount > 1 ? `-L${h.newStart + h.newCount - 1}` : ''})`);
  for (const g of effects?.groups ?? []) {
    if (g.build !== 'ok') {
      items.push({
        item: `What ${g.hunks.map(link).join(' + ')} does on its own`,
        reason: `the PR without ${g.hunks.length > 1 ? 'these parts' : 'this part'} did not build${g.errors[0] ? ` (${code(`${g.errors[0].code}: ${g.errors[0].message}`.slice(0, 120))})` : ''}`,
        riskIfWrong: 'its effect cannot be separated from the rest of the change',
        howToCheck: 'read these hunks together with the code that uses them',
        computed: true,
      });
    } else if (!g.needed.length && !g.partly.length && !g.sideEffects.length) {
      items.push({
        item: `What ${g.hunks.map(link).join(' + ')} does`,
        reason: 'removing it from the PR changes nothing in any input that ran, so no input shows what it does (the lines may still run, with the same result either way)',
        riskIfWrong: 'whatever this part changes is not shown anywhere in this review',
        howToCheck: 'add an input whose result differs with and without these lines, or a test that fails without them',
        computed: true,
      });
    }
  }
  const c = tests.coverage;
  if (c?.measured) {
    const gaps = c.files.flatMap((f) =>
      f.inReport ? f.unreached.map(([a, b]) => `[${f.path.split('/').pop()} ${a === b ? a : `${a}–${b}`}](${blob}/${f.path}#L${a}${b > a ? `-L${b}` : ''})`) : [`${code(f.path)} (not in the coverage report)`],
    );
    if (gaps.length) {
      items.push({
        item: `${c.executable - c.reached} of ${c.executable} changed lines: ${gaps.join(', ')}`,
        reason: 'no scenario and no test ran them (code coverage)',
        riskIfWrong: 'whatever those lines do is not shown anywhere in this review',
        howToCheck: 'add a scenario that reaches them, or a test, and re-run the review',
        computed: true,
      });
    }
  } else {
    items.push({ item: 'Which changed lines ran', reason: c?.reason ?? 'coverage was not recorded', riskIfWrong: 'untested lines go unnoticed', howToCheck: 're-run with code coverage', computed: true });
  }
  for (const r of requirements.filter((x) => x.rule && x.rule !== 'the reported bug was never reproduced on the code before the PR')) {
    items.push({
      item: `${r.id}: ${r.statement}`,
      reason: r.rule,
      riskIfWrong: r.primary ? 'this is the bug the issue reports' : 'this part of the issue may not be met',
      howToCheck: 'add a scenario that covers it and re-run the review',
      computed: true,
    });
  }
  if (failedScenarios.length) {
    items.push({ item: `Scenarios ${failedScenarios.map(code).join(', ')}`, reason: 'they could not run', riskIfWrong: 'what they were meant to show is unknown', howToCheck: 'fix the scenario code and re-run', computed: true });
  }
  if (otherTestProjects.length) {
    const touched = otherTestProjects.filter((p) => p.touched);
    items.push({
      item: `${otherTestProjects.length} other test projects: ${otherTestProjects.map((p) => code(p.name) + (p.touched ? ' (changed by this PR)' : '')).join(', ')}`,
      reason: `only ${code(tests.project.split('/').pop())} was run`,
      riskIfWrong: touched.length ? 'this PR changes files in some of them, so their results matter' : 'a regression elsewhere in the library would go unnoticed',
      howToCheck: `dotnet test ${touched[0]?.path ?? otherTestProjects[0].path}`,
      computed: true,
    });
  }
  return items;
}

/**
 * Who owns a refused decision. Only people a human named get an @-mention: the REVIEW_MAP_OWNERS
 * setting ("alice,bob" or "intent=alice,trade-off=bob,default=carol"), then the PR's requested
 * reviewers and assignees. The PR author is not used: here that is the agent's operator, not a reviewer.
 */
export function ownerResolver({ setting, pr }) {
  const map = {};
  const plain = [];
  for (const part of String(setting ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const [k, v] = part.includes('=') ? part.split('=').map((x) => x.trim()) : [null, part];
    const login = v.replace(/^@/, '');
    if (k) map[k] = login;
    else plain.push(login);
  }
  const fromPr = [...(pr?.reviewers ?? []), ...(pr?.assignees ?? [])];
  return (reason) => {
    const login = map[reason] ?? map.default ?? plain[0] ?? fromPr[0];
    if (login) return { login, source: map[reason] || map.default || plain[0] ? 'REVIEW_MAP_OWNERS' : 'PR reviewers' };
    return { login: null, source: 'unassigned' };
  };
}

export function fingerprints(files) {
  return files.filter((f) => existsSync(f)).map((f) => ({ name: basename(f), sha256: createHash('sha256').update(readFileSync(f)).digest('hex') }));
}
