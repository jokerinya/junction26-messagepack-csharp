#pragma warning disable
// Review-map probe for the MessagePack source generator pipeline. NOT part of any pull request under review.
// The evidence runner copies it into tests/MessagePack.SourceGenerator.Tests, runs it once on the code
// before the change and once after, and removes it again.
//
// Scenarios are not hard-coded: they are read from the JSON file named by REVIEW_MAP_SCENARIOS, which the
// reviewing agent writes after reading the diff. For each scenario the probe records what crossed each
// hand-off of the pipeline:
//   1. the model that TypeCollector returns        (analysis stage)
//   2. the diagnostics the analyzer reports        (what the build says)
//   3. the source files the generator emits        (templates stage)
//   4. the bytes and values at run time            (generated code actually executing)
// and writes everything to REVIEW_MAP_PROBE_OUT. A scenario that fails is recorded, never fatal.

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MessagePack;
using MessagePack.Resolvers;
using MessagePack.SourceGenerator.Analyzers;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.Diagnostics;
using Microsoft.CodeAnalysis.Testing;
using Xunit;
using MpAnalysis = MessagePack.SourceGenerator.CodeAnalysis;

public class ReviewMapProbe
{
    public sealed class Scenario
    {
        public string Id { get; set; } = "";
        public string Title { get; set; } = "";
        public string? ReferencedSource { get; set; }
        public string ProjectSource { get; set; } = "";
        public string MakeExpression { get; set; } = "";
        public string DescribeExpression { get; set; } = "";
    }

    [Fact]
    public async Task Dump()
    {
        string? outPath = Environment.GetEnvironmentVariable("REVIEW_MAP_PROBE_OUT");
        string? scenariosPath = Environment.GetEnvironmentVariable("REVIEW_MAP_SCENARIOS");
        if (string.IsNullOrEmpty(outPath) || string.IsNullOrEmpty(scenariosPath))
        {
            return;
        }

        var scenarios = JsonSerializer.Deserialize<List<Scenario>>(File.ReadAllText(scenariosPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;
        ImmutableArray<MetadataReference> framework = await ReferenceAssemblies.Net.Net80.ResolveAsync(LanguageNames.CSharp, CancellationToken.None);
        List<MetadataReference> baseRefs = framework.Concat(ReferencesHelper.GetReferences(ReferencesSet.MessagePack)).ToList();
        var results = new List<object>();

        foreach (Scenario s in scenarios)
        {
            try
            {
                results.Add(await RunScenario(s, baseRefs));
            }
            catch (Exception ex)
            {
                results.Add(new { id = s.Id, title = s.Title, referencedSource = s.ReferencedSource, projectSource = s.ProjectSource, probeError = ex.GetType().Name + ": " + ex.Message.Split('\n')[0].Trim() });
            }
        }

        File.WriteAllText(outPath, JsonSerializer.Serialize(results, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static async Task<object> RunScenario(Scenario s, List<MetadataReference> baseRefs)
    {
        var parse = CSharpParseOptions.Default.WithLanguageVersion(LanguageVersion.Latest);
        var refs = new List<MetadataReference>(baseRefs);
        byte[]? libImage = null;
        if (!string.IsNullOrWhiteSpace(s.ReferencedSource))
        {
            var lib = CSharpCompilation.Create("Lib", new[] { CSharpSyntaxTree.ParseText(s.ReferencedSource, parse) }, baseRefs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            using var ms = new MemoryStream();
            var emit = lib.Emit(ms);
            if (!emit.Success)
            {
                return new { id = s.Id, title = s.Title, referencedSource = s.ReferencedSource, projectSource = s.ProjectSource, probeError = "Referenced assembly did not compile: " + string.Join(" | ", emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(3).Select(d => d.Id + " " + d.GetMessage())) };
            }

            libImage = ms.ToArray();
            refs.Add(MetadataReference.CreateFromImage(libImage));
        }

        string usage = s.ProjectSource
            + "\n[MessagePack.GeneratedMessagePackResolver]\npartial class ProbeResolver { }\n"
            + "public static class ProbeData\n{\n    public static object Make() => " + s.MakeExpression + ";\n    public static string Describe(object o) => " + s.DescribeExpression + ";\n}\n";
        var app = CSharpCompilation.Create("App", new[] { CSharpSyntaxTree.ParseText(usage, parse, path: "App.cs") }, refs, new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        // Hand-off 1: the model out of TypeCollector, one call per [MessagePackObject] type, as the generator does it.
        var model = new List<object>();
        if (MpAnalysis.ReferenceSymbols.TryCreate(app, out MpAnalysis.ReferenceSymbols? referenceSymbols))
        {
            foreach (INamedTypeSymbol type in SourceTypes(app.Assembly.GlobalNamespace).Where(t => t.GetAttributes().Any(a => a.AttributeClass?.Name == "MessagePackObjectAttribute")))
            {
                try
                {
                    MpAnalysis.FullModel? m = MpAnalysis.TypeCollector.Collect(app, new MpAnalysis.AnalyzerOptions { IsGeneratingSource = true }, referenceSymbols, null, type, CancellationToken.None);
                    model.Add(new
                    {
                        target = type.ToDisplayString(),
                        exception = (string?)null,
                        objects = m?.ObjectInfos.Select(o => new
                        {
                            type = o.DataType.ToString(),
                            members = o.Members.Select(mem => $"{mem.Name} (key {(o.IsIntKey ? mem.IntKey.ToString() : "\"" + mem.StringKey + "\"")}, {mem.ShortTypeName})").ToList(),
                        }).ToList(),
                        closedGenerics = m?.GenericInfos.Select(g => g.DataType.ToString()).ToList(),
                    });
                }
                catch (Exception ex)
                {
                    model.Add(new { target = type.ToDisplayString(), exception = ex.GetType().Name, objects = (object?)null, closedGenerics = (object?)null });
                }
            }
        }

        // Hand-off 3: the files the generator emits.
        GeneratorDriver driver = CSharpGeneratorDriver.Create(new MessagePack.SourceGenerator.MessagePackGenerator().AsSourceGenerator())
            .WithUpdatedParseOptions(parse)
            .RunGeneratorsAndUpdateCompilation(app, out Compilation withGenerated, out _);
        GeneratorDriverRunResult run = driver.GetRunResult();
        string? generatorException = run.Results.Select(r => r.Exception).FirstOrDefault(e => e is not null)?.GetType().Name;
        var generated = run.Results.SelectMany(r => r.GeneratedSources.IsDefault ? ImmutableArray<GeneratedSourceResult>.Empty : r.GeneratedSources)
            .Select(g => new { hintName = g.HintName, text = g.SourceText.ToString() })
            .ToList();

        // Hand-off 2: what the analyzer reports.
        var analyzers = ImmutableArray.Create<DiagnosticAnalyzer>(new MsgPack00xMessagePackAnalyzer());
        ImmutableArray<Diagnostic> analyzerDiagnostics = await app.WithAnalyzers(analyzers).GetAnalyzerDiagnosticsAsync();

        // C# errors in the scenario itself (as opposed to diagnostics from the code under review).
        var sourceErrors = withGenerated.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).Take(5).Select(d => d.Id + " " + d.GetMessage()).ToList();

        // Hand-off 4: run the compiled result on one real object.
        object runtime;
        try
        {
            runtime = RunTime(s.Id, withGenerated, libImage);
        }
        catch (Exception ex)
        {
            runtime = new { built = true, error = Unwrap(ex) };
        }

        return new
        {
            id = s.Id,
            title = s.Title,
            referencedSource = s.ReferencedSource,
            projectSource = s.ProjectSource,
            model,
            generatorException,
            generatorDiagnostics = run.Diagnostics.Select(Describe).ToList(),
            analyzerDiagnostics = analyzerDiagnostics.Select(Describe).ToList(),
            sourceErrors,
            generated,
            runtime,
        };
    }

    private static object RunTime(string id, Compilation compilation, byte[]? libImage)
    {
        using var ms = new MemoryStream();
        var emit = compilation.Emit(ms);
        if (!emit.Success)
        {
            return new { built = false, buildErrors = emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(3).Select(d => d.Id + ": " + d.GetMessage()).ToList() };
        }

        var alc = new AssemblyLoadContext("review-map-" + id + "-" + Guid.NewGuid().ToString("N"), isCollectible: false);
        Assembly? lib = libImage is null ? null : alc.LoadFromStream(new MemoryStream(libImage));
        alc.Resolving += (_, name) => name.Name == "Lib" ? lib : null;
        ms.Position = 0;
        Assembly appAssembly = alc.LoadFromStream(ms);

        Type data = appAssembly.GetTypes().First(t => t.Name == "ProbeData");
        object original = data.GetMethod("Make")!.Invoke(null, null)!;
        Func<object, string> describe = o => (string)data.GetMethod("Describe")!.Invoke(null, new[] { o })!;

        Type? resolverType = appAssembly.GetTypes().FirstOrDefault(t => t.Name == "ProbeResolver");
        object? generatedResolver = resolverType?.GetField("Instance", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null)
            ?? resolverType?.GetProperty("Instance", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)?.GetValue(null);

        var configs = new List<object>
        {
            Attempt("default options", MessagePackSerializerOptions.Standard, original, describe),
        };
        if (generatedResolver is IFormatterResolver r)
        {
            configs.Add(Attempt("generated resolver first", MessagePackSerializerOptions.Standard.WithResolver(CompositeResolver.Create(r, StandardResolver.Instance)), original, describe));
        }

        return new { built = true, generatedResolverPresent = generatedResolver is not null, valuesIn = describe(original), configs };
    }

    private static object Attempt(string name, MessagePackSerializerOptions options, object original, Func<object, string> describe)
    {
        try
        {
            byte[] bytes = MessagePackSerializer.Serialize(original.GetType(), original, options);
            string wire = MessagePackSerializer.ConvertToJson(bytes, options);
            object back = MessagePackSerializer.Deserialize(original.GetType(), bytes, options)!;
            return new { name, error = (string?)null, wire, byteCount = bytes.Length, valuesOut = describe(back) };
        }
        catch (Exception ex)
        {
            return new { name, error = Unwrap(ex), wire = (string?)null, byteCount = 0, valuesOut = (string?)null };
        }
    }

    private static string Unwrap(Exception ex)
    {
        while (ex.InnerException is not null)
        {
            ex = ex.InnerException;
        }

        return ex.GetType().Name + ": " + ex.Message.Split('\n')[0].Trim();
    }

    private static IEnumerable<INamedTypeSymbol> SourceTypes(INamespaceSymbol ns)
    {
        foreach (INamedTypeSymbol t in ns.GetTypeMembers())
        {
            yield return t;
        }

        foreach (INamespaceSymbol child in ns.GetNamespaceMembers())
        {
            foreach (INamedTypeSymbol t in SourceTypes(child))
            {
                yield return t;
            }
        }
    }

    private static object Describe(Diagnostic d) => new
    {
        id = d.Id,
        severity = d.Severity.ToString(),
        message = d.GetMessage().Split('\n')[0].Trim(),
        location = d.Location.IsInSource ? d.Location.GetLineSpan().Path + ":" + (d.Location.GetLineSpan().StartLinePosition.Line + 1) : "(none)",
    };
}
