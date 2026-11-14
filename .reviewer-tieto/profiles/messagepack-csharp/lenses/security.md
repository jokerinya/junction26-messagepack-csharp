# Security addendum: MessagePack-CSharp

MessagePack-CSharp turns **untrusted bytes** into objects in many applications, and its generator writes code into their builds.

**Untrusted input (runtime)**
- Lengths and counts from the payload (`ReadArrayHeader`, `ReadMapHeader`, string or bin lengths) are checked against the remaining bytes **before** allocating.
- Recursion goes through `MessagePackSecurity.DepthStep`.
- Collections built from input use the collision-resistant comparers under `UntrustedData`.
- LZ4: the declared uncompressed size is bounded.
- Integer overflow in size arithmetic.

**Type loading:** type names from the payload (`Typeless`, `Type.GetType`, `Activator`) only resolve from an allow-list.

**Unsafe memory:** `unsafe`, `Unsafe.*`, `MemoryMarshal`, `stackalloc` have bounds proven before access, and `stackalloc` sizes are capped.

**Generator and analyzers:** identifiers and literals copied into generated source are escaped. No file, network or environment access.

**Build:** the analyzer packages ship from `analyzers/roslyn<version>/`. A Roslyn version change in `Directory.Packages.props` changes which compiler hosts can load the generator. Treat it as a supply-chain **and** compatibility change. `[from review 2283-9df83c38]`

**Severity:** high when reachable by deserializing attacker-controlled bytes, or by code injection into generated source.
