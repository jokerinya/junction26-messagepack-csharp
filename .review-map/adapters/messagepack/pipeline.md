# The pipeline under review: MessagePack-CSharp source generator

Users mark their C# types with `[MessagePackObject]` and members with `[Key(n)]` or `[Key("name")]`. At build time a Roslyn source generator writes serialization code for those types; a Roslyn analyzer reports rule violations as build diagnostics. At run time the app serializes objects to MessagePack bytes, either with the generated formatters or, when none exists, with a dynamic fallback resolver built by reflection.

## Stages (nodes on the map)

| Stage | Code | Receives | Emits |
|---|---|---|---|
| Your types | user code | C# source of the project being compiled | type symbols |
| Referenced types | other assemblies | compiled metadata only, no source syntax | type symbols |
| TypeCollector (analysis) | `src/MessagePack.SourceGenerator/CodeAnalysis/TypeCollector.cs` | one target type plus the compilation | a `FullModel`: per type, which members are serialized with which keys; plus diagnostics through a callback |
| Analyzer | `src/MessagePack.SourceGenerator/Analyzers/MsgPack00xMessagePackAnalyzer.cs` | each attributed type | build diagnostics `MsgPack001`..`MsgPack0xx` (errors fail the build) |
| Generator and templates | `src/MessagePack.SourceGenerator/MessagePackGenerator.cs`, `Transforms/*` | the `FullModel` | C# source files: a resolver and one formatter per type |
| Generated code | compiled into the user's assembly | objects at run time | MessagePack bytes, and objects read back |

The generator calls TypeCollector with no diagnostics callback; the analyzer calls it with one. So a change in TypeCollector can affect diagnostics, generated code, or both.

## Hand-offs the probe records (ids used in traces)

| id | What is recorded |
|---|---|
| `model` | The model TypeCollector returns for each `[MessagePackObject]` type in the scenario, or the exception it throws |
| `diagnostics` | Generator and analyzer diagnostics, and whether the build fails (any error) |
| `generated` | The source files the generator emits (names and full text) |
| `rtDefault` | Serialize one real object with default options, show the wire bytes as JSON, deserialize, compare values |
| `rtGenerated` | The same with the generated resolver placed first (the setup trimmed and NativeAOT apps need) |

## Scenario format

A scenario is one concrete input to the pipeline. The probe compiles it and runs every hand-off on the code before and after the PR.

- `id`: short kebab-case id.
- `title`: one line saying what the input is and why it matters.
- `referencedSource`: C# for a separate assembly named `Lib` the project references, compiled to metadata (no source visible to the generator), or `null`. Use `namespace Lib;`.
- `projectSource`: C# for the project being compiled. Must use the file-scoped `namespace App;`. Do not declare a resolver or a `ProbeData` class; the probe appends `[GeneratedMessagePackResolver] partial class ProbeResolver` and a `ProbeData` class itself.
- `makeExpression`: one C# expression that builds a real object of a project type, with distinctive non-default values in every member (so a dropped value is visible).
- `describeExpression`: one C# expression of type `string` that prints every member's value from the object in a variable `o` of static type `object` (cast it). Must not throw when a member comes back null or default.

All code is compiled with C# latest against .NET 8 and the MessagePack package; nullable warnings are irrelevant. Keep scenarios small: one or two types each.
