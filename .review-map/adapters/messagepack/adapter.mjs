// Adapter for the MessagePack-CSharp source generator pipeline.
// An adapter is everything repo-specific: how to read the pipeline, how to probe it, how to show a hand-off.
// The rest of review-map (agent prompts, evidence runner, renderer, GitHub plumbing) is generic.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  name: 'messagepack',

  // Where upstream issues referenced in PR titles live. They are read for context, and never hyperlinked
  // from comments, so the upstream issue timeline does not get cross-reference entries.
  issueRepo: 'MessagePack-CSharp/MessagePack-CSharp',

  // Plain-language description of the pipeline, given to the reviewing agent.
  pipeline: readFileSync(join(here, 'pipeline.md'), 'utf8'),

  // A file counts as "source" (reverted for the before run) or "test".
  isSource: (path) => path.startsWith('src/'),
  isTest: (path) => path.startsWith('tests/'),
  // Files collapsed in the diff given to the agent (expected-output snapshots).
  isSnapshot: (path) => /\/Resources\//.test(path) && path.startsWith('tests/'),

  // The test project that runs the PR's tests and hosts the probe.
  testProject: 'tests/MessagePack.SourceGenerator.Tests/MessagePack.SourceGenerator.Tests.csproj',
  probeSource: join(here, 'ReviewMapProbe.cs'),
  probeTarget: 'tests/MessagePack.SourceGenerator.Tests/ReviewMapProbe.cs',
  probeFilter: 'FullyQualifiedName~ReviewMapProbe',

  // A known break, applied to the after code for one extra probe run, to show the probe can see a
  // difference when there is one. It drops the first member of every collected type from the model.
  // The line exists unchanged on the base and on all four challenge branches.
  mutation: {
    description: 'TypeCollector drops the first member of every type it collects',
    file: 'src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs',
    find: 'members: isIntKey ? intMembers.Values.Select(v => v.Info).ToArray() : stringMembers.Values.Select(v => v.Info).ToArray(),',
    replace: 'members: isIntKey ? intMembers.Values.Select(v => v.Info).Skip(1).ToArray() : stringMembers.Values.Select(v => v.Info).Skip(1).ToArray(),',
  },

  // Scenarios from branch 2283, shown to the agent as a worked example of the scenario format.
  exampleScenarios: JSON.parse(readFileSync(join(here, 'example-scenarios.json'), 'utf8')),
};
