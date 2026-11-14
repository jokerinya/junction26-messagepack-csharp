// Output shapes for the two reviewing-agent calls, as zod schemas. They are sent to the API as JSON
// schemas (structured outputs), and every response is validated again here before it is used.

import { z } from 'zod';

export const Scenario = z.object({
  id: z.string(),
  title: z.string(),
  referencedSource: z.string().nullable(),
  projectSource: z.string(),
  makeExpression: z.string(),
  describeExpression: z.string(),
  why: z.string(),
  // Which requirements of the issue this scenario exercises, and whether it is the issue's own reproduction.
  covers: z.array(z.string()),
  reproducesIssue: z.boolean(),
});

// Chosen before anything runs, so the requirement list and the expected symptom are a prediction the
// recorded runs then confirm or not; the agent cannot pick them after seeing the results.
export const Plan = z.object({
  understanding: z.string(),
  requirements: z.array(z.object({ id: z.string(), statement: z.string(), primary: z.boolean() })),
  // How the reported bug shows up in a recording: at this hand-off, on the code before the PR, the value
  // contains one of these strings. An empty list means the issue describes no observable symptom.
  symptom: z.object({ handoff: z.string(), contains: z.array(z.string()), why: z.string() }),
  scenarios: z.array(Scenario),
});

// Fixed lists are enforced by the script (lib/finish.mjs, normalizeFixedLists), not by the grammar: enums
// inside nested arrays make the structured-output grammar too large for the API.
export const FIXED = {
  status: ['changed', 'affected', 'same'],
  severity: ['WARNING', 'CAUTION', 'IMPORTANT', 'NOTE'],
  reason: ['intent', 'trade-off', 'unreproduced', 'out-of-reach'],
  requirement: ['met', 'partly', 'not-met', 'not-shown'],
  claim: ['verified', 'partly', 'not-verified', 'contradicted'],
};
const Status = z.string();

// The agent never writes evidence values. It points at them, and the script resolves each pointer
// against the recorded runs, the test results or the code, and quotes what it finds (lib/verify.mjs).
// A pointer is one compact string, which keeps the structured-output grammar small:
//   run:<scenario>:<handoff>:<before|after|both>:<differs|same|any>
//   test:<test name>:<fails-before-passes-after|passes-both|fails-after|any>
//   code:<path>:<line>[-<line>]
const Refs = z.array(z.string());

export const Analysis = z.object({
  summary: z.array(z.object({ sentence: z.string(), refs: Refs })),
  nodes: z.array(z.object({ id: z.string(), label: z.string(), sub: z.string(), status: Status })),
  edges: z.array(z.object({ from: z.string(), to: z.string(), label: z.string(), changed: z.boolean() })),
  // The top of the comment: what the review found, what it refused to decide, and what it did not check.
  found: z.array(z.object({ statement: z.string(), severity: z.string(), refs: Refs })),
  decisions: z.array(
    z.object({
      question: z.string(),
      reason: z.string(),
      detail: z.string(),
      wouldSettleIt: z.string(),
      options: z.array(z.string()),
      refs: Refs,
    }),
  ),
  notChecked: z.array(z.object({ item: z.string(), reason: z.string(), riskIfWrong: z.string(), howToCheck: z.string() })),
  requirements: z.array(z.object({ id: z.string(), verdict: z.string(), note: z.string(), refs: Refs })),
  traces: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      story: z.string(),
      where: z.array(z.object({ handoff: z.string(), text: z.string() })),
    }),
  ),
  units: z.array(
    z.object({
      name: z.string(),
      status: Status,
      where: z.string(),
      receives: z.string(),
      emits: z.string(),
      change: z.string(),
      examples: z.array(z.object({ note: z.string(), refs: Refs })),
    }),
  ),
  claims: z.array(
    z.object({
      claim: z.string(),
      source: z.string(),
      verdict: z.string(),
      evidence: z.string(),
      refs: Refs,
    }),
  ),
});

/** JSON schema for structured outputs: every object closed, every property required. */
export function toApiSchema(schema) {
  const js = z.toJSONSchema(schema);
  delete js.$schema;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object' && node.properties) {
      node.additionalProperties = false;
      node.required = Object.keys(node.properties);
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else walk(v);
    }
  };
  walk(js);
  return js;
}

// The analysis is asked for in two parallel calls, because one schema with every section compiles to a
// structured-output grammar larger than the API accepts. Together they make one Analysis.
export const AnalysisTop = Analysis.pick({ summary: true, found: true, decisions: true, notChecked: true, requirements: true, claims: true });
export const AnalysisMap = Analysis.pick({ nodes: true, edges: true, traces: true, units: true });
