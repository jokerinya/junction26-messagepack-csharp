# Verifiability addendum: MessagePack-CSharp

- Generator and analyzer tests live in `tests/MessagePack.SourceGenerator.Tests` (Roslyn test harness) and `tests/MessagePack.SourceGenerator.ExecutionTests` (compiled and run).
- **Referenced-assembly scenarios** only reproduce with a real metadata reference (for example `MetadataReference.CreateFromImage`). A same-compilation or `AdditionalProjects` test does not reproduce them. `[from review 2283-9df83c38]`
- Asserting only that a resolver hint name exists does not prove the formatter round-trips. Prefer an execution test that serializes and deserializes.
- Commands: `dotnet test <project> --filter "FullyQualifiedName~<Class>.<Method>"`. Deletion proof: revert the production files to the merge base and re-run the same filter.
