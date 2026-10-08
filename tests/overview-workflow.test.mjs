import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('actual overview workflow restores the browser and dispatches each action at most once',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-overview-flow-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'PortalWorkflowController.Overviews.cs'))}" Link="PortalWorkflowController.Overviews.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: budget readiness regression, existing tab, menu fallback, one query, disappearing query, uncertain dispatch, transport error, script error, cancellation, missing menu, expiry/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-overview-flow-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

// Only the transport and the other controller partial are replaced. The production
// OpenEdufineOverviewAsync and its one-shot click implementation execute unchanged.
// Selector correctness is covered separately by the rendered-DOM fixtures.
const probe = String.raw`
using System.Text.Json;
using BrowserThumbnailPrototype;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
async Task<T> ThrowsAsync<T>(Func<Task<WorkflowResult>> run, string message) where T : Exception
{
    try { await run(); }
    catch (T error) { return error; }
    throw new Exception(message);
}
void Shown(Scenario scenario, WorkflowResult result, string label)
{
    Check(result.KeepActivatedBrowser && scenario.Shown, label + ": browser was not displayed.");
    Check(scenario.Events.Count(e => e == "show") == 1, label + ": browser restoration was repeated.");
    Check(scenario.Disposed, label + ": transport was not disposed.");
}

var normal = new Scenario { Ready = true, QueryAvailable = true };
var normalResult = await new PortalWorkflowController(normal).RunProbeAsync(approval: false);
Shown(normal, normalResult, "Normal budget");
Check(normal.Events.Count(e => e == "click:Query") == 1, "Budget must query exactly once.");
Check(normal.Events.IndexOf("click:Query") < normal.Events.IndexOf("show"), "Query must precede showing its result.");
Check(normal.Waits.Count == 1 && normal.Waits[0].Kind == ExpressionKind.Query
    && normal.Waits[0].Timeout <= TimeSpan.FromSeconds(5), "Budget waited beyond the bounded query lookup.");

// Regression: the real page can have a usable query button while the old broad
// readiness predicate stays false forever. It must still query and show the browser.
var differentLayout = new Scenario { Ready = false, QueryAvailable = true };
var layoutResult = await new PortalWorkflowController(differentLayout).RunProbeAsync(approval: false);
Shown(differentLayout, layoutResult, "Unrecognized budget layout");
Check(differentLayout.Events.Count(e => e == "click:Query") == 1, "Readiness blocked a usable budget query.");
Check(!differentLayout.Waits.Any(w => w.Kind == ExpressionKind.Ready), "The old budget readiness gate returned.");

var unavailable = new Scenario { Ready = false, QueryAvailable = false };
var unavailableResult = await new PortalWorkflowController(unavailable).RunProbeAsync(approval: false);
Shown(unavailable, unavailableResult, "Query unavailable");
Check(unavailable.Events.All(e => e != "click:Query"), "A missing query button was clicked.");
Check(unavailable.SessionChecks == 2, "Condition timeout did not recheck session expiry.");

var disappeared = new Scenario { QueryAvailable = true, QueryDisappearsOnLocate = true };
var disappearedResult = await new PortalWorkflowController(disappeared).RunProbeAsync(approval: false);
Shown(disappeared, disappearedResult, "Query disappeared before click");
Check(disappeared.Events.Count(e => e == "locate:Query") == 1
    && disappeared.Events.All(e => e != "click:Query"), "A disappearing query was retried or clicked.");

var existingTab = new Scenario { TabAvailable = true, Ready = false };
var tabResult = await new PortalWorkflowController(existingTab).RunProbeAsync(approval: true);
Shown(existingTab, tabResult, "Existing approval tab");
Check(existingTab.Events.Count(e => e == "locate:Tab") == 1
    && existingTab.Events.Count(e => e == "click:Tab") == 1, "Approval did not activate its tab once.");
Check(existingTab.Events.All(e => e != "evaluate:Tab"), "Approval repeated its tab probe before the one-shot click.");
Check(existingTab.Waits.Count == 0, "Existing tab still waits for grid readiness.");
Check(existingTab.Events.All(e => !e.StartsWith("job:") && !e.StartsWith("top:") && e != "click:Menu"),
    "Successful approval tab activation fell back to menu navigation.");

var missingTab = new Scenario { TabAvailable = false, Ready = false };
var menuResult = await new PortalWorkflowController(missingTab).RunProbeAsync(approval: true);
Shown(missingTab, menuResult, "Approval menu fallback");
Check(missingTab.Events.Count(e => e == "click:Menu") == 1
    && missingTab.Events.All(e => e != "click:Tab"), "A missing approval tab did not use one menu navigation.");
Check(missingTab.Waits.Count == 0, "Approval menu navigation still waits for grid readiness.");

foreach (var kind in new[] { ExpressionKind.Query, ExpressionKind.Tab })
{
    var uncertain = new Scenario { TabAvailable = true, QueryAvailable = true, ErrorAfterClick = kind };
    await ThrowsAsync<DevToolsCommandTimeoutException>(
        () => new PortalWorkflowController(uncertain).RunProbeAsync(approval: kind == ExpressionKind.Tab),
        "A transport timeout after dispatch was swallowed.");
    Check(uncertain.Events.Count(e => e == "click:" + kind) == 1, "An uncertain click was retransmitted.");
    Check(uncertain.Disposed, "Transport was leaked after an uncertain click.");
    if (kind == ExpressionKind.Tab)
        Check(uncertain.Events.All(e => e != "click:Menu"), "An uncertain tab click retried through a menu.");
}

foreach (var error in new TimeoutException[] {
    new DevToolsCommandTimeoutException("Simulated query transport timeout."),
    new TimeoutException("Simulated query predicate failure.", new InvalidOperationException("Script failed."))
})
{
    var broken = new Scenario { QueryAvailable = true };
    broken.EvaluationErrors[ExpressionKind.Query] = error;
    var actual = await ThrowsAsync<TimeoutException>(
        () => new PortalWorkflowController(broken).RunProbeAsync(approval: false),
        "A transport/script error was disguised as a missing query button.");
    Check(ReferenceEquals(error, actual), "The original transport/script error was not preserved.");
    Check(broken.Events.All(e => e != "click:Query"), "Query dispatched after a transport/script error.");
    Check(broken.Disposed, "Transport was leaked after a predicate error.");
}

var expired = new Scenario { QueryAvailable = false, ExpireOnSessionCheck = 2 };
await ThrowsAsync<PortalSessionExpiredException>(
    () => new PortalWorkflowController(expired).RunProbeAsync(approval: false),
    "An expired session was disguised as a missing query button.");
Check(expired.Events.All(e => e != "click:Query") && expired.Disposed,
    "Expired-session handling dispatched a query or leaked the transport.");

var cancelled = new Scenario { QueryAvailable = true };
var cancellation = new OperationCanceledException("Simulated cancelled query lookup.", new CancellationToken(true));
cancelled.EvaluationErrors[ExpressionKind.Query] = cancellation;
var cancellationResult = await ThrowsAsync<OperationCanceledException>(
    () => new PortalWorkflowController(cancelled).RunProbeAsync(approval: false),
    "Cancellation was disguised as a missing query button.");
Check(ReferenceEquals(cancellationResult, cancellation)
    && cancelled.Events.All(e => e != "click:Query") && cancelled.Disposed,
    "Cancellation was changed, caused a query, or leaked the transport.");

foreach (var approval in new[] { true, false })
{
    var missingMenuError = new TimeoutException("Simulated missing navigation menu.");
    var missingMenu = new Scenario { ErrorOnMenu = missingMenuError, QueryAvailable = true };
    var menuError = await ThrowsAsync<TimeoutException>(
        () => new PortalWorkflowController(missingMenu).RunProbeAsync(approval),
        "A missing menu was disguised as successful navigation.");
    Check(ReferenceEquals(menuError, missingMenuError) && !missingMenu.Shown && missingMenu.Disposed,
        "Missing-menu failure showed a success screen or leaked the transport.");
    Check(missingMenu.Events.Count(e => e == "click:Menu") == 1
        && missingMenu.Events.All(e => e != "click:Query"), "A missing menu was retried or caused a query.");
}

Console.WriteLine("PASS: budget readiness regression, existing tab, menu fallback, one query, disappearing query, uncertain dispatch, transport error, script error, cancellation, missing menu, expiry");

namespace BrowserThumbnailPrototype
{
    internal enum ExpressionKind { Ready, Tab, Query }

    internal sealed class Scenario
    {
        public bool Ready { get; init; }
        public bool TabAvailable { get; init; }
        public bool QueryAvailable { get; init; }
        public bool QueryDisappearsOnLocate { get; init; }
        public int ExpireOnSessionCheck { get; init; } = int.MaxValue;
        public int SessionChecks { get; set; }
        public ExpressionKind? ErrorAfterClick { get; init; }
        public Exception? ErrorOnMenu { get; init; }
        public Dictionary<ExpressionKind, Exception> EvaluationErrors { get; } = new();
        public List<string> Events { get; } = new();
        public List<(ExpressionKind Kind, TimeSpan Timeout)> Waits { get; } = new();
        public bool Shown { get; set; }
        public bool Disposed { get; set; }

        public bool Available(ExpressionKind kind) => kind switch
        {
            ExpressionKind.Ready => Ready,
            ExpressionKind.Tab => TabAvailable,
            ExpressionKind.Query => QueryAvailable,
            _ => throw new InvalidOperationException("Unknown expression kind.")
        };
    }

    internal sealed record WorkflowResult(string Message, IntPtr ForegroundWindow = default, bool KeepActivatedBrowser = false);
    internal sealed record EducationOffice(string EdufineDomain, Uri EdufineUri);
    internal sealed record DevToolsTarget(string Id);
    internal sealed record EdufineSessionState(bool Expired);
    internal sealed class PortalSessionExpiredException(string systemName, string message) : InvalidOperationException(message);
    internal sealed class DevToolsCommandTimeoutException(string message) : TimeoutException(message);
    internal static class AppLogger { public static void Info(string area, string message) { } }

    internal sealed class DevToolsSession : IAsyncDisposable
    {
        public static Scenario Current { get; set; } = null!;
        public Scenario State { get; }
        private ExpressionKind? _pendingClick;
        private DevToolsSession(Scenario state) { State = state; }
        public static Task<DevToolsSession> ConnectAsync(int port, string id, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Current.Events.Add("connect");
            return Task.FromResult(new DevToolsSession(Current));
        }
        public Task ActivateTargetAsync(CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            State.Events.Add("activate");
            return Task.CompletedTask;
        }
        public Task<bool> EvaluateBooleanAsync(string expression, bool userGesture = false,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var kind = PortalWorkflowController.Classify(expression);
            State.Events.Add("evaluate:" + kind);
            if (State.EvaluationErrors.TryGetValue(kind, out var error)) throw error;
            return Task.FromResult(State.Available(kind));
        }
        public Task<JsonElement> EvaluateAsync(string expression, bool userGesture = false,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var kind = PortalWorkflowController.Classify(expression);
            State.Events.Add("locate:" + kind);
            if (State.EvaluationErrors.TryGetValue(kind, out var error)) throw error;
            _pendingClick = kind;
            var available = State.Available(kind) && !(kind == ExpressionKind.Query && State.QueryDisappearsOnLocate);
            return Task.FromResult(JsonSerializer.SerializeToElement(available
                ? new { x = 24, y = 30 } : null));
        }
        public Task ClickAsync(double x, double y, CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var kind = _pendingClick ?? throw new InvalidOperationException("Click had no located element.");
            _pendingClick = null;
            State.Events.Add("click:" + kind);
            if (State.ErrorAfterClick == kind) throw new DevToolsCommandTimeoutException("Simulated uncertain click result.");
            return Task.CompletedTask;
        }
        public ValueTask DisposeAsync()
        {
            State.Disposed = true;
            State.Events.Add("dispose");
            return ValueTask.CompletedTask;
        }
    }

    internal sealed partial class PortalWorkflowController
    {
        private readonly int _devToolsPort = 0;
        private readonly EducationOffice _educationOffice = new("example.invalid", new Uri("https://example.invalid/"));
        private readonly Action<string> _reportProgress = _ => { };
        private readonly Scenario _scenario;
        private static readonly string[] ApprovalNames = ["결재대기", "결재대기문서"];
        private static readonly string[] BudgetNames = ["사업별예산현황", "사업관리카드(담당)", "사업관리카드(현액)", "사업관리카드"];

        public PortalWorkflowController(Scenario scenario) { _scenario = scenario; }
        public Task<WorkflowResult> RunProbeAsync(bool approval)
        {
            DevToolsSession.Current = _scenario;
            return OpenEdufineOverviewAsync(approval, CancellationToken.None);
        }
        public static ExpressionKind Classify(string expression)
        {
            if (expression.Contains(EdufineBudgetQueryScript(BudgetNames), StringComparison.Ordinal)) return ExpressionKind.Query;
            if (expression.Contains(EdufineOverviewTabScript(ApprovalNames), StringComparison.Ordinal)) return ExpressionKind.Tab;
            if (expression == OverviewReadyScript(ApprovalNames, true)
                || expression == OverviewReadyScript(BudgetNames, false)) return ExpressionKind.Ready;
            throw new InvalidOperationException("Unexpected script in overview transport fake.");
        }
        private Task<DevToolsTarget> EnsureApplicationTargetAsync(string domain, string label, string name, Uri uri,
            CancellationToken cancellationToken) => Task.FromResult(new DevToolsTarget("probe"));
        private static Task WaitForEdufineReadyAsync(DevToolsSession session, CancellationToken cancellationToken)
            => Task.CompletedTask;
        private static Task<EdufineSessionState> ReadEdufineSessionStateAsync(DevToolsSession session,
            CancellationToken cancellationToken)
        {
            session.State.SessionChecks++;
            return Task.FromResult(new EdufineSessionState(session.State.SessionChecks >= session.State.ExpireOnSessionCheck));
        }
        private Task PrepareActivatedTargetForBackgroundAsync(CancellationToken cancellationToken)
        {
            _scenario.Events.Add("background");
            return Task.CompletedTask;
        }
        private static Task TryCloseVisibleEdufineNoticeAsync(DevToolsSession session, CancellationToken cancellationToken)
            => Task.CompletedTask;
        private static Task PrepareBrowserForUserAsync(DevToolsSession session, CancellationToken cancellationToken)
        {
            session.State.Events.Add("show");
            session.State.Shown = true;
            return Task.CompletedTask;
        }
        private static Task SelectEdufineJobAsync(DevToolsSession session, string name, CancellationToken cancellationToken)
        {
            session.State.Events.Add("job:" + name);
            return Task.CompletedTask;
        }
        private static Task ClickEdufineTopMenuAsync(DevToolsSession session, string name, CancellationToken cancellationToken)
        {
            session.State.Events.Add("top:" + name);
            return Task.CompletedTask;
        }
        private static Task ClickElementCenterAsync(DevToolsSession session, string expression, string errorMessage,
            TimeSpan timeout, CancellationToken cancellationToken)
        {
            session.State.Events.Add("click:Menu");
            if (session.State.ErrorOnMenu is Exception error) throw error;
            return Task.CompletedTask;
        }
        private static async Task WaitForConditionAsync(DevToolsSession session, string expression, TimeSpan timeout,
            CancellationToken cancellationToken, string? errorMessage = null)
        {
            var kind = Classify(expression);
            session.State.Waits.Add((kind, timeout));
            session.State.Events.Add("wait:" + kind);
            if (!await session.EvaluateBooleanAsync(expression, cancellationToken: cancellationToken))
                throw new TimeoutException(errorMessage ?? "Simulated condition deadline.");
        }
    }
}
`;
