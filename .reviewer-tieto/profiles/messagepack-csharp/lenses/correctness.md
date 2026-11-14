# Correctness addendum: MessagePack-CSharp

**Runtime (`src/MessagePack/**`)**
- `MessagePackReader` is a `ref struct` with a position. Passing it **by value** to a helper loses the read progress.
- Every header count read must be consumed exactly. An array or map header of N needs N elements (or `Skip()`), or the stream is corrupt for whatever follows.
- Serialize and deserialize stay symmetric: same key order, int vs. string keys, nil handling.
- `ReadOnlySequence` spanning several segments; empty input; the end of a buffer.

**Source generator and analyzers (`src/MessagePack.SourceGenerator/**`)**
- Symbols are compared with `SymbolEqualityComparer.Default`, never `==`.
- Generic types: open vs. closed, nested generics, type parameters from the containing type, constraints.
- Symbols from metadata (referenced assemblies) have no `DeclaringSyntaxReferences`. Never index them without a check, and never assume a diagnostic location exists. `[from review 2283-9df83c38]`
- Declaring syntax can be a property, a **positional record parameter** or a field. A cast to only one syntax kind loses the others. `[from review 2283-9df83c38]`
- Incremental pipeline models must be equatable: no `ISymbol` or `Compilation` stored in models.
- Generated code is fully qualified (`global::`), compiles under `#nullable enable`, and escapes C# keywords.
- `.tt` templates and their generated `.cs` stay in sync.
