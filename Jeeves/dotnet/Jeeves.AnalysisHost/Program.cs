using System.Text.Json;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.FlowAnalysis;
using Microsoft.CodeAnalysis.Operations;

namespace Jeeves.AnalysisHost;

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private static string root = "";
    private static CSharpCompilation? compilation;
    private static string loadedProject = "";
    private const int MaximumFileBytes = 16 * 1024 * 1024;

    private static string SafeFile(string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative) || relative.Contains('\\') ||
            relative.Split('/').Any(part => part is "" or "." or "..")) throw new InvalidOperationException("invalid_relative_path");
        var current = root;
        foreach (var part in relative.Split('/'))
        {
            current = Path.Combine(current, part);
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("symlink_not_allowed");
        }
        if (new FileInfo(current).Length > MaximumFileBytes) throw new InvalidOperationException("file_size_limit");
        return current;
    }

    private static bool IsFunction(SyntaxNode node) => node is BaseMethodDeclarationSyntax or LocalFunctionStatementSyntax or AnonymousFunctionExpressionSyntax or AccessorDeclarationSyntax;
    private static bool HasBody(SyntaxNode node) => node switch
    {
        BaseMethodDeclarationSyntax method => method.Body != null || method.ExpressionBody != null,
        LocalFunctionStatementSyntax local => local.Body != null || local.ExpressionBody != null,
        AccessorDeclarationSyntax accessor => accessor.Body != null || accessor.ExpressionBody != null,
        AnonymousFunctionExpressionSyntax => true,
        _ => false
    };

    private static string MaskComments(SyntaxNode syntax, string source)
    {
        var output = source.ToCharArray();
        foreach (var trivia in syntax.DescendantTrivia(descendIntoTrivia: false))
        {
            if (!trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) && !trivia.IsKind(SyntaxKind.MultiLineCommentTrivia) &&
                !trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) && !trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia)) continue;
            for (var offset = trivia.FullSpan.Start; offset < trivia.FullSpan.End; offset++)
                if (output[offset] is not ('\r' or '\n' or '\u2028' or '\u2029')) output[offset] = ' ';
        }
        return new string(output);
    }

    private static object Analyze(JsonElement request)
    {
        var relative = request.GetProperty("file").GetString()!;
        var source = File.ReadAllText(SafeFile(relative));
        var tree = CSharpSyntaxTree.ParseText(source, path: relative);
        var syntax = tree.GetRoot();
        if (request.GetProperty("method").GetString() == "comments")
            return new { ranges = syntax.DescendantTrivia(descendIntoTrivia: false).Where(trivia => trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineCommentTrivia) || trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) || trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia)).Select(trivia => new { start = trivia.FullSpan.Start, end = trivia.FullSpan.End }).ToArray() };
        if (request.GetProperty("method").GetString() == "trace")
        {
            var offset = request.GetProperty("start").GetInt32();
            if (offset < 0 || offset >= source.Length) throw new InvalidOperationException("invalid_source_span");
            var selected = syntax.FindToken(offset).Parent!;
            var localCompilation = CSharpCompilation.Create("LocalTrace", [tree], [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)], new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            var localModel = localCompilation.GetSemanticModel(tree);
            var symbol = localModel.GetSymbolInfo(selected).Symbol;
            var definitions = symbol?.DeclaringSyntaxReferences.Take(30).Select(reference =>
            {
                var declaration = reference.GetSyntax();
                return new { file = relative, start = declaration.SpanStart, end = declaration.Span.End, kind = declaration.Kind().ToString(), relationship = declaration is ParameterSyntax ? "parameter_boundary" : "declaration_candidate" };
            }).ToArray();
            var owner = selected.Ancestors().FirstOrDefault(IsFunction) ?? syntax;
            var writes = owner.DescendantNodes().OfType<AssignmentExpressionSyntax>().Where(assignment => symbol != null && SymbolEqualityComparer.Default.Equals(localModel.GetSymbolInfo(assignment.Left).Symbol, symbol)).Take(30)
                .Select(assignment => new { file = relative, start = assignment.SpanStart, end = assignment.Span.End, valueStart = assignment.Right.SpanStart, valueEnd = assignment.Right.Span.End, relationship = "write_candidate_not_proven_reaching" }).ToArray();
            var guards = selected.Ancestors().OfType<IfStatementSyntax>().Take(30).Select(statement => new { file = relative, start = statement.Condition.SpanStart, end = statement.Condition.Span.End, relationship = "enclosing_condition_not_sanitizer_proof" }).ToArray();
            return new { expression = new { file = relative, start = selected.SpanStart, end = selected.Span.End }, definitions, writes, guards, capability = "semantic_partial", completion = "partial", reasons = new[] { "isolated_file_symbol_binding", "reaching_writes_and_project_conditions_not_proven" } };
        }
        if (request.GetProperty("method").GetString() == "read")
        {
            var start = request.GetProperty("start").GetInt32();
            var end = request.GetProperty("end").GetInt32();
            if (start < 0 || end <= start || end > source.Length || end - start > 65536) throw new InvalidOperationException("invalid_source_span");
            return new { text = MaskComments(syntax, source)[start..end], capability = "syntax_only" };
        }
        if (request.GetProperty("method").GetString() == "locate")
        {
            var start = request.GetProperty("start").GetInt32(); var end = request.GetProperty("end").GetInt32();
            return new { found = syntax.DescendantNodes().Any(node => node.SpanStart == start && node.Span.End == end) };
        }
        if (request.GetProperty("method").GetString() == "local")
        {
            var start = request.GetProperty("start").GetInt32(); var end = request.GetProperty("end").GetInt32();
            var declaration = syntax.DescendantNodes().FirstOrDefault(node => node.SpanStart == start && node.Span.End == end && IsFunction(node));
            var localCompilation = CSharpCompilation.Create("LocalEvidence", [tree], [MetadataReference.CreateFromFile(typeof(object).Assembly.Location)], new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            var localModel = localCompilation.GetSemanticModel(tree);
            ControlFlowGraph? graph = declaration == null ? null : localModel.GetOperation(declaration) switch
            {
                IMethodBodyOperation methodBody => ControlFlowGraph.Create(methodBody),
                IConstructorBodyOperation constructorBody => ControlFlowGraph.Create(constructorBody),
                _ => null
            };
            var blocks = graph?.Blocks.Take(100).Select(block => new
            {
                block.Ordinal, kind = block.Kind.ToString(), block.IsReachable,
                operations = block.Operations.Take(50).Select(operation => new { kind = operation.Kind.ToString(), start = operation.Syntax.SpanStart, end = operation.Syntax.Span.End }).ToArray(),
                branch = block.BranchValue == null ? null : new { start = block.BranchValue.Syntax.SpanStart, end = block.BranchValue.Syntax.Span.End },
                fallThrough = block.FallThroughSuccessor?.Destination?.Ordinal,
                conditional = block.ConditionalSuccessor?.Destination?.Ordinal
            }).ToArray();
            return new { blocks, capability = "semantic_partial", completion = "partial", reasons = new[] { "isolated_file_control_flow", "project_conditions_and_dependencies_not_loaded", "not_interprocedural_dataflow", "bounded_blocks_and_operations" } };
        }
        if (request.GetProperty("method").GetString() == "framework")
        {
            var usings = syntax.DescendantNodes().OfType<UsingDirectiveSyntax>().Select(item => item.Name?.ToString()).Where(item => item != null).ToArray();
            var facts = syntax.DescendantNodes().OfType<AttributeSyntax>().Where(attribute =>
                attribute.Name.ToString().Contains("Trigger", StringComparison.Ordinal) || attribute.Name.ToString() is "Function" or "FunctionName" or "Authorize" or "AllowAnonymous" or "HttpGet" or "HttpPost" or "Route")
                .Take(100).Select(attribute => new { kind = "framework_attribute_candidate", name = attribute.Name.ToString(), start = attribute.SpanStart, end = attribute.Span.End }).ToArray();
            return new { modelVersion = "dotnet-framework-v1", basis = "declared", usings, facts, completion = "partial", reasons = new[] { "attribute_identity_requires_project_resolution", "middleware_order_and_runtime_policy_unknown" } };
        }
        var calls = new List<object>(); var registrations = new List<object>();
        foreach (var node in syntax.DescendantNodes().Where(node => node is InvocationExpressionSyntax or ObjectCreationExpressionSyntax))
        {
            if (calls.Count >= 20000) throw new InvalidOperationException("resource_limited");
            var expression = node is InvocationExpressionSyntax call ? call.Expression.ToString() : ((ObjectCreationExpressionSyntax)node).Type.ToString();
            var name = node is InvocationExpressionSyntax invocation ? invocation.Expression switch
            {
                MemberAccessExpressionSyntax member => member.Name.Identifier.ValueText,
                IdentifierNameSyntax identifier => identifier.Identifier.ValueText,
                _ => "<computed>"
            } : ((ObjectCreationExpressionSyntax)node).Type.ToString();
            var parent = node.Ancestors().FirstOrDefault(candidate => IsFunction(candidate) && HasBody(candidate));
            var id = $"{relative}:{node.SpanStart}-{node.Span.End}";
            calls.Add(new { id, file = relative, start = node.SpanStart, end = node.Span.End,
                callerId = parent == null ? null : $"{relative}:{parent.SpanStart}-{parent.Span.End}", name,
                expression = expression[..Math.Min(expression.Length, 1024)], data = new { resolution = "unresolved", kind = "call" } });
            if (name.StartsWith("Map", StringComparison.Ordinal) || name.StartsWith("Add", StringComparison.Ordinal) || name == "Use")
                registrations.Add(new { id, file = relative, start = node.SpanStart, kind = "dotnet_registration_candidate",
                    data = new { name, basis = "syntax_only", limitation = "Receiver type, middleware order and DI selection require semantic context." } });
        }
        return new { calls, registrations, diagnostics = tree.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).Select(_ => "parse_error").Distinct().ToArray(), capability = "syntax_only" };
    }

    private static IEnumerable<string> SourceFiles(string directory)
    {
        foreach (var entry in Directory.EnumerateFileSystemEntries(directory))
        {
            if ((File.GetAttributes(entry) & FileAttributes.ReparsePoint) != 0) continue;
            if (Directory.Exists(entry))
            {
                if (Path.GetFileName(entry) is "bin" or "obj" or "node_modules" or ".git") continue;
                foreach (var file in SourceFiles(entry)) yield return file;
            }
            else if (entry.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) yield return entry;
        }
    }

    private static object Resolve(JsonElement request)
    {
        var project = request.GetProperty("project").GetString()!;
        if (project != loadedProject || compilation == null)
        {
            var projectFile = SafeFile(project);
            // Declarative inspection only. Never evaluate MSBuild, restore target
            // packages or execute analyzers/source generators in the host process.
            using var reader = XmlReader.Create(projectFile, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            var xml = XDocument.Load(reader);
            var files = SourceFiles(Path.GetDirectoryName(projectFile)!).Take(2001).ToArray();
            if (files.Length > 2000) throw new InvalidOperationException("resource_limited");
            var trees = files.Select(file => CSharpSyntaxTree.ParseText(File.ReadAllText(SafeFile(Path.GetRelativePath(root, file).Replace('\\', '/'))), path: file)).ToArray();
            var reference = MetadataReference.CreateFromFile(typeof(object).Assembly.Location);
            compilation = CSharpCompilation.Create("Snapshot", trees, [reference], new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
            loadedProject = project;
        }
        if (request.GetProperty("method").GetString() == "callers") return FindCallers(request);
        var sourceFile = SafeFile(request.GetProperty("file").GetString()!);
        var tree = compilation.SyntaxTrees.FirstOrDefault(tree => tree.FilePath == sourceFile) ?? throw new InvalidOperationException("file_not_in_project");
        var start = request.GetProperty("start").GetInt32();
        var node = tree.GetRoot().DescendantNodes().FirstOrDefault(node => node.SpanStart == start && node is InvocationExpressionSyntax or ObjectCreationExpressionSyntax)
            ?? throw new InvalidOperationException("call_site_not_found");
        var model = compilation.GetSemanticModel(tree);
        var info = model.GetSymbolInfo(node);
        var symbols = info.Symbol == null ? info.CandidateSymbols : [info.Symbol];
        var targets = symbols.SelectMany(symbol => symbol.DeclaringSyntaxReferences).Select(reference =>
        {
            var declaration = reference.GetSyntax();
            var relative = Path.GetRelativePath(root, declaration.SyntaxTree.FilePath).Replace('\\', '/');
            return new { id = $"{relative}:{declaration.SpanStart}-{declaration.Span.End}", file = relative,
                start = declaration.SpanStart, end = declaration.Span.End, implementation = HasBody(declaration), basis = "compiler_resolved_candidate" };
        }).Distinct().Take(100).ToArray();
        return new { targets, capability = "semantic_partial", completion = "partial",
            reasons = new[] { "declarative_project_membership", "build_conditions_not_evaluated", "package_references_not_loaded", "dynamic_dispatch_not_exhaustive" } };
    }

    private static object FindCallers(JsonElement request)
    {
        var targetId = request.GetProperty("targetId").GetString();
        var limit = request.GetProperty("limit").GetInt32();
        if (limit < 1 || limit > 50) throw new InvalidOperationException("invalid_caller_request");
        string? cursorFile = null; var cursorOrdinal = -1;
        if (request.TryGetProperty("cursor", out var cursor) && cursor.ValueKind == JsonValueKind.Object)
        {
            cursorFile = cursor.GetProperty("file").GetString(); cursorOrdinal = cursor.GetProperty("ordinal").GetInt32();
        }
        var rows = new List<object>(); var examined = 0; var unresolved = 0; var fileCount = 0;
        string? lastFile = cursorFile; var lastOrdinal = cursorOrdinal;
        object Page(bool exhausted) => new { rows, examined, unresolved, exhausted,
            cursor = exhausted || lastFile == null ? null : new { file = lastFile, ordinal = lastOrdinal },
            capability = "semantic_partial", completion = "partial",
            reasons = new[] { "unsearched_projects_and_external_consumers", "build_conditions_not_evaluated", "package_references_not_loaded", "dynamic_dispatch_not_exhaustive" } };
        foreach (var tree in compilation!.SyntaxTrees.OrderBy(tree => tree.FilePath, StringComparer.Ordinal))
        {
            var relative = Path.GetRelativePath(root, tree.FilePath).Replace('\\', '/');
            if (cursorFile != null && StringComparer.Ordinal.Compare(relative, cursorFile) < 0) continue;
            if (fileCount++ >= 10) return Page(false);
            var semantic = compilation.GetSemanticModel(tree); var ordinal = 0;
            foreach (var node in tree.GetRoot().DescendantNodes().Where(node => node is InvocationExpressionSyntax or ObjectCreationExpressionSyntax))
            {
                var current = ordinal++;
                if (relative == cursorFile && current <= cursorOrdinal) continue;
                if (examined >= 500 || rows.Count >= limit) return Page(false);
                examined++; lastFile = relative; lastOrdinal = current;
                var info = semantic.GetSymbolInfo(node);
                var symbols = info.Symbol == null ? info.CandidateSymbols : [info.Symbol];
                var references = symbols.SelectMany(symbol => symbol.DeclaringSyntaxReferences).ToArray();
                if (references.Length == 0) unresolved++;
                if (!references.Any(reference => $"{Path.GetRelativePath(root, reference.SyntaxTree.FilePath).Replace('\\', '/')}:{reference.Span.Start}-{reference.Span.End}" == targetId)) continue;
                var owner = node.Ancestors().FirstOrDefault(candidate => IsFunction(candidate) && HasBody(candidate));
                var arguments = node is InvocationExpressionSyntax call ? call.ArgumentList.Arguments : ((ObjectCreationExpressionSyntax)node).ArgumentList?.Arguments ?? default;
                rows.Add(new { id = $"{relative}:{node.SpanStart}-{node.Span.End}", file = relative, start = node.SpanStart, end = node.Span.End,
                    callerId = owner == null ? null : $"{relative}:{owner.SpanStart}-{owner.Span.End}", targetId, basis = "compiler_resolved_candidate",
                    arguments = arguments.Take(100).Select(argument => new { start = argument.Expression.SpanStart, end = argument.Expression.Span.End }).ToArray() });
            }
            lastFile = relative; lastOrdinal = Math.Max(-1, ordinal - 1);
        }
        return Page(true);
    }

    private static async Task Main()
    {
        string? line;
        while ((line = await Console.In.ReadLineAsync()) != null)
        {
            int id = 0;
            try
            {
                if (line.Length > 1024 * 1024) throw new InvalidOperationException("request_size_limit");
                using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 64 });
                var request = document.RootElement; id = request.GetProperty("id").GetInt32();
                var requestedRoot = Path.GetFullPath(request.GetProperty("root").GetString()!);
                if (root != requestedRoot) { root = requestedRoot; compilation = null; loadedProject = ""; }
                var method = request.GetProperty("method").GetString();
                var result = method is "resolve" or "callers" ? Resolve(request) : Analyze(request);
                var output = JsonSerializer.Serialize(new { id, value = result }, JsonOptions);
                if (output.Length > 8 * 1024 * 1024) throw new InvalidOperationException("result_size_limit");
                await Console.Out.WriteLineAsync(output);
            }
            catch (Exception error)
            {
                var code = error is InvalidOperationException && error.Message.All(character => char.IsAsciiLetterLower(character) || character == '_') ? error.Message : "csharp_analysis_failed";
                await Console.Out.WriteLineAsync(JsonSerializer.Serialize(new { id, error = code }, JsonOptions));
            }
        }
    }
}