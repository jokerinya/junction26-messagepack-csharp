// Everything that happens after the reviewing agent (or a human) has written an analysis, the same for
// both: the gate resolves its evidence pointers, and the script adds what it decides by rule. Used by
// `review.mjs analyze` and by `lib/verify.mjs` for hand-written analyses.

import {
  computedFound,
  ablationEffects,
  computedNotChecked,
  confidence,
  ownerResolver,
  reproduction,
  requirementTable,
  ruleDecisions,
  sensitivity,
} from './checks.mjs';
import { FIXED } from './schemas.mjs';
import { verifyAnalysis } from './verify.mjs';

/**
 * Enforces the fixed lists (severity, decision reason, verdicts, unit status) that the API schema leaves
 * as plain strings. Unknown values fall back to the weakest meaning; a decision whose reason is not on
 * the list is not shown as a decision at all.
 */
export function normalizeFixedLists(v) {
  const notes = [];
  const unverified = [];
  const fix = (value, list, fallback, what) => {
    const hit = list.find((x) => x.toLowerCase() === String(value ?? '').trim().toLowerCase());
    if (hit) return hit;
    notes.push(`${what}: "${value}" is not on the fixed list (${list.join(', ')}), so it is shown as ${fallback}`);
    return fallback;
  };
  for (const n of v.nodes ?? []) n.status = fix(n.status, FIXED.status, 'same', `node ${n.label}`);
  for (const u of v.units ?? []) {
    u.status = fix(u.status, FIXED.status, 'same', `unit ${u.name}`);
    if (!u.where) u.where = null;
  }
  for (const e of v.edges ?? []) if (!e.label) e.label = null;
  for (const f of v.found ?? []) if (!f.computed) f.severity = fix(f.severity, FIXED.severity, 'NOTE', 'finding severity');
  for (const r of v.requirements ?? []) r.verdict = fix(r.verdict, FIXED.requirement, 'not-shown', `${r.id} verdict`);
  for (const c of v.claims ?? []) c.verdict = fix(c.verdict, FIXED.claim, 'not-verified', 'claim verdict');
  v.decisions = (v.decisions ?? []).filter((d) => {
    if (d.computed || FIXED.reason.includes(String(d.reason).trim().toLowerCase())) {
      d.reason = String(d.reason).trim().toLowerCase();
      return true;
    }
    unverified.push({ section: 'Refused to decide', text: d.question, reasons: [`its reason "${d.reason}" is not on the fixed list (${FIXED.reason.join(', ')})`], quotes: [] });
    return false;
  });
  return { notes, unverified };
}

/**
 * @param a          the agent's (or a human's) analysis, in the Analysis shape
 * @param plan       { requirements, symptom, scenarios } as chosen before anything ran
 * @returns the verified parts to put into analysis.json
 */
export function finishAnalysis(a, { plan, issueRef, pr, tests, before, after, mutant, extraSides, handoffs, readCode, blob, ownersSetting, otherTestProjects }) {
  const v = structuredClone(a);
  const repro = reproduction({ plan, before, after, handoffs });

  // Rule-made items go in before the gate, marked computed, so the agent can neither word nor drop them.
  v.found = [...computedFound({ tests }), ...(v.found ?? [])];
  v.decisions = [...ruleDecisions({ repro, issueRef }), ...(v.decisions ?? [])];

  const fixed = normalizeFixedLists(v);
  const { results } = tests;
  const { unverified, downgraded } = verifyAnalysis(v, { before, after, results, handoffs, readCode, blob, extraSides });
  unverified.push(...fixed.unverified);
  downgraded.push(...fixed.notes);

  const table = requirementTable({ plan, verdicts: v.requirements ?? [], before, after, handoffs, repro });
  downgraded.push(...table.downgraded);

  const ran = after.filter((s) => !s.probeError).map((s) => s.id);
  const failedScenarios = (plan.scenarios ?? []).filter((s) => !ran.includes(s.id)).map((s) => s.id);
  const effects = ablationEffects({ tests, before, after, sides: extraSides ?? {}, handoffs });
  const notChecked = [...computedNotChecked({ tests, blob, requirements: table.rows, failedScenarios, otherTestProjects, effects }), ...(v.notChecked ?? [])];

  const owner = ownerResolver({ setting: ownersSetting, pr });
  for (const d of v.decisions) d.owner = owner(d.reason);

  // Every scenario a kept item cites gets a trace, so each quote can link to its full table.
  const cited = new Set(
    [...v.summary, ...v.found, ...v.decisions, ...table.rows, ...v.claims, ...v.units.flatMap((u) => u.examples)]
      .flatMap((x) => x.refs ?? [])
      .filter((r) => r.kind === 'run' && r.resolved?.ok)
      .map((r) => r.scenario),
  );
  // The agent gives traces as a list; a hand-written analysis as { evidence, adapter, cases }.
  const traceList = Array.isArray(v.traces) ? v.traces : (v.traces?.cases ?? []);
  const traceCases = traceList.filter((t) => (plan.scenarios ?? []).some((s) => s.id === t.id) || before.some((s) => s.id === t.id));
  for (const id of cited) {
    if (traceCases.some((t) => t.id === id)) continue;
    const s = (plan.scenarios ?? []).find((x) => x.id === id);
    if (s) traceCases.push({ id, title: s.title, story: s.why, where: [] });
  }

  const sens = sensitivity({ tests, after, mutant, handoffs });
  return {
    verified: v,
    unverified,
    downgraded,
    repro,
    requirements: table.rows,
    notChecked,
    traceCases,
    failedScenarios,
    sensitivity: sens,
    effects,
    confidence: confidence({ tests, failedScenarios, sensitivity: sens }),
  };
}
