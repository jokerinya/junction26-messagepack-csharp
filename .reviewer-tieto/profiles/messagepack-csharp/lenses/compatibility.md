# Compatibility addendum: MessagePack-CSharp

- `src/MessagePack.Annotations/**` attributes are referenced by every consumer. Each addition is permanent API, so it goes to the api-owner.
- **Wire format:** existing types must serialize to the same bytes (key order, int vs. string keys, nil vs. omitted, union tags).
- **Generator output for existing valid projects** must not change, and must not add new warnings: consumers use `TreatWarningsAsErrors`.
- **Analyzer ids:** new ids are unique, listed in `AnalyzerReleases.Unshipped.md`, and documented in `doc/analyzers/MsgPackNNN.md` and `index.md`. Ids are never reused.
- **Roslyn host floor:** `MicrosoftCodeAnalysisVersion` for `IsAnalyzerProject` decides the `analyzers/roslyn<version>` package folder and the oldest supported VS/SDK. `[from review 2283-9df83c38]`
- **Diagnostics policy:** removing, suppressing or relocating existing diagnostics is a behaviour change for consumers, even when it fixes a crash. `[from review 2283-9df83c38]`
- AOT and trimming: no new reflection on runtime paths.
