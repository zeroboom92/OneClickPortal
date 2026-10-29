import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

function method(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `Production method was not found: ${signature}`);
  const opening = source.indexOf('{', start);
  let depth = 1;
  for (let index = opening + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  assert.fail(`Production method has no closing brace: ${signature}`);
}

test('actual browser presentation helper activates, maximizes and focuses the target window and propagates failures',
  { timeout: 120_000 }, async () => {
    const source = await readFile(resolve(root, 'PortalWorkflowController.cs'), 'utf8');
    const helper = method(source, 'private static async Task PrepareBrowserForUserAsync(');
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-window-presentation-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
      </Project>`);
      // Execute the production helper unchanged. Only the browser transport is
      // simulated; no browser, logged-in portal or native window is manipulated.
      await writeFile(join(directory, 'Presentation.cs'), `namespace BrowserThumbnailPrototype;
        internal sealed partial class PortalWorkflowController { ${helper} }`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout,
        /PASS: minimized and restored windows, different target owner, awaited command order, cancellation, activation failure, maximization failure, focus failure, confirmation failure/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-window-presentation-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

test('successful browser handoff does not maximize the originally connected window over the activated target', async () => {
  const source = await readFile(resolve(root, 'MainForm.cs'), 'utf8');
  const branch = source.match(/else if\s*\(result\.KeepActivatedBrowser\)\s*\{([^}]*)\}/)?.[1];
  assert.ok(branch, 'The successful target-window handoff branch is missing.');
  assert.match(branch, /RestoreSourceWindowOpacity\(\)\s*;/);
  assert.doesNotMatch(branch,
    /ShowSourceWindowMaximized|RestoreSourceWindow\(|SetForegroundWindow|ShowWindow|MinimizeSourceWindow|_sourceWindow/,
    'A successful target-window handoff must not change the originally connected HWND.');
});

test('explicit report and student-management navigation present the target again after the background query', async () => {
  for (const [file, signature] of [
    ['PortalWorkflowController.FieldTripReports.cs', 'private async Task<WorkflowResult> OpenFieldTripReportManagementAsync('],
    ['PortalWorkflowController.StudentManagement.cs', 'private async Task<WorkflowResult> OpenStudentManagementAsync('],
  ]) {
    const source = await readFile(resolve(root, file), 'utf8');
    const body = method(source, signature);
    const query = body.indexOf('await QueryStudentManagementAsync(');
    const present = body.indexOf('await PrepareBrowserForUserAsync(session, cancellationToken)', query);
    const success = body.indexOf('return new WorkflowResult(', query);
    assert.ok(query >= 0 && query < present && present < success,
      `${file}: the completed background query must be followed by target-window presentation before success.`);
    assert.match(body.slice(success), /KeepActivatedBrowser:\s*true/);
    assert.match(body.slice(success), /ForegroundWindow:\s*session\.PresentedWindowHandle/);
  }
});

test('every activated workflow returns its confirmed target HWND and final handoff checks it after cleanup', async () => {
  let returns = 0;
  for (const file of ['PortalWorkflowController.cs', 'PortalWorkflowController.FieldTripReports.cs',
    'PortalWorkflowController.StudentManagement.cs', 'PortalWorkflowController.Overviews.cs']) {
    const source = await readFile(resolve(root, file), 'utf8');
    for (const result of source.matchAll(/return new WorkflowResult\([^;]*?KeepActivatedBrowser:\s*true\);/g)) {
      returns++;
      assert.match(result[0], /ForegroundWindow:\s*session\.PresentedWindowHandle/,
        `${file}: successful browser handoff omitted its confirmed HWND.`);
    }
  }
  assert.equal(returns, 9, 'The nine explicit browser handoffs must remain covered.');
  const source = await readFile(resolve(root, 'MainForm.cs'), 'utf8');
  const workflow = method(source, 'private async Task RunWorkflowAsync(');
  assert.match(workflow, /BrowserForeground\.EnsureWindowForegroundAsync\(\s*result\.ForegroundWindow,/);
  const stableCheck = workflow.indexOf('await BrowserForeground.EnsureWindowForegroundAsync(');
  const recordSuccess = workflow.indexOf('presentedBrowser = result;');
  assert.ok(stableCheck >= 0 && recordSuccess > stableCheck,
    'Cancellation or failure during stable confirmation must not record a successful handoff.');
  const resumeDock = workflow.indexOf('autoHidePause?.Dispose();');
  assert.ok(resumeDock >= 0 && resumeDock < stableCheck,
    'Dock resumption must happen before the awaited stable foreground check.');
  const cleanup = workflow.indexOf('_portalOperationGate.Release()');
  assert.ok(cleanup > recordSuccess,
    'The workflow gate must prevent another action from interleaving with foreground confirmation.');
  const finalCheck = workflow.lastIndexOf('BrowserForeground.ReadForegroundBrowserWindow(');
  assert.ok(cleanup >= 0 && finalCheck > cleanup,
    'Final native foreground validation must occur after workflow/gate cleanup.');
  assert.match(workflow.slice(finalCheck), /presentedBrowser\.ForegroundWindow/);
});

const probe = String.raw`
using BrowserThumbnailPrototype;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
async Task<T> ThrowsAsync<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T error) { return error; }
    throw new Exception("Expected " + typeof(T).Name + " was not thrown.");
}
void Completed(Scenario scenario)
{
    Check(scenario.Events.SequenceEqual(new[] { "activate:22", "maximize:22", "focus:22", "confirm:22" }),
        "The target window must be activated, maximized, focused and confirmed, exactly once in order.");
    Check(scenario.Presented && scenario.TargetWindowState == "maximized" && scenario.ForegroundWindow == 22,
        "Successful presentation left the target minimized, restored or in the background.");
    Check(scenario.OriginalWindowState == "minimized",
        "Presentation restored the original window instead of the window owning the target tab.");
    Check(scenario.Tokens.All(token => token == scenario.Cancellation.Token),
        "Presentation changed or dropped the caller cancellation token.");
    Check(scenario.ConfirmedHandle == new IntPtr(22), "The target HWND was not confirmed before reporting success.");
}

foreach (var initialState in new[] { "minimized", "normal", "maximized" })
{
    using var scenario = new Scenario { TargetWindowState = initialState };
    await new PortalWorkflowController().RunProbeAsync(new DevToolsSession(scenario), scenario);
    Completed(scenario);
}

// A fake transport command deliberately stays pending. Later commands, and the
// caller's success signal, must not run until each actual production await ends.
using (var scenario = new Scenario { PauseCommands = true })
{
    var pending = new PortalWorkflowController().RunProbeAsync(new DevToolsSession(scenario), scenario);
    foreach (var step in new[] { "activate", "maximize", "focus", "confirm" })
    {
        var expectedCount = Array.IndexOf(new[] { "activate", "maximize", "focus", "confirm" }, step) + 1;
        await scenario.Started.Reader.ReadAsync();
        Check(scenario.Events.Count == expectedCount && scenario.Events[^1] == step + ":22"
            && !scenario.Presented && !pending.IsCompleted,
            "Presentation advanced or reported success before " + step + " completed.");
        scenario.Release.Writer.TryWrite(true);
    }
    await pending;
    Completed(scenario);
}

// Pre-cancellation and cancellation between all four commands must prevent the
// next side effect and must never turn an incomplete handoff into a success.
foreach (var cancelAfter in new[] { "before", "activate", "maximize", "focus", "confirm" })
{
    using var scenario = new Scenario { CancelAfter = cancelAfter };
    if (cancelAfter == "before") scenario.Cancellation.Cancel();
    var error = await ThrowsAsync<OperationCanceledException>(() =>
        new PortalWorkflowController().RunProbeAsync(new DevToolsSession(scenario), scenario));
    var count = cancelAfter == "before" ? 0 : Array.IndexOf(new[] { "activate", "maximize", "focus", "confirm" }, cancelAfter) + 1;
    Check(error.CancellationToken == scenario.Cancellation.Token && scenario.Events.Count == count
        && !scenario.Presented && scenario.OriginalWindowState == "minimized",
        "Cancellation was lost, an extra command ran, or incomplete presentation was reported as success.");
}

foreach (var step in new[] { "activate", "maximize", "focus", "confirm" })
{
    var failure = new InvalidOperationException("Simulated " + step + " failure.");
    using var scenario = new Scenario { FailAt = step, Failure = failure };
    var actual = await ThrowsAsync<BrowserForegroundException>(() =>
        new PortalWorkflowController().RunProbeAsync(new DevToolsSession(scenario), scenario));
    var count = Array.IndexOf(new[] { "activate", "maximize", "focus", "confirm" }, step) + 1;
    Check(ReferenceEquals(actual.InnerException, failure) && scenario.Events.Count == count && !scenario.Presented,
        "Failed " + step + " lost its cause, continued to another command or marked the browser presented.");
    Check(scenario.OriginalWindowState == "minimized", "A failed command changed the original window.");
    if (step == "maximize")
        Check(scenario.TargetWindowState == "minimized" && scenario.ForegroundWindow == 0,
            "A failed maximization was followed by focus or treated as a visible window.");
}

using (var scenario = new Scenario { FailAt = "confirm", Failure = new BrowserForegroundException("Already classified foreground refusal.") })
{
    var actual = await ThrowsAsync<BrowserForegroundException>(() =>
        new PortalWorkflowController().RunProbeAsync(new DevToolsSession(scenario), scenario));
    Check(ReferenceEquals(actual, scenario.Failure) && !scenario.Presented && scenario.ConfirmedHandle == IntPtr.Zero,
        "A classified foreground refusal was wrapped again or marked as presented.");
}

Console.WriteLine("PASS: minimized and restored windows, different target owner, awaited command order, cancellation, activation failure, maximization failure, focus failure, confirmation failure");

namespace BrowserThumbnailPrototype
{
    internal sealed class BrowserForegroundException(string message, Exception? inner = null) : InvalidOperationException(message, inner);
    internal sealed class Scenario : IDisposable
    {
        public string OriginalWindowState { get; set; } = "minimized";
        public string TargetWindowState { get; set; } = "minimized";
        public int ForegroundWindow { get; set; }
        public bool Presented { get; set; }
        public IntPtr ConfirmedHandle { get; set; }
        public bool PauseCommands { get; init; }
        public string? CancelAfter { get; init; }
        public string? FailAt { get; init; }
        public Exception? Failure { get; init; }
        public List<string> Events { get; } = new();
        public List<CancellationToken> Tokens { get; } = new();
        public CancellationTokenSource Cancellation { get; } = new();
        public System.Threading.Channels.Channel<bool> Started { get; } = System.Threading.Channels.Channel.CreateUnbounded<bool>();
        public System.Threading.Channels.Channel<bool> Release { get; } = System.Threading.Channels.Channel.CreateUnbounded<bool>();
        public void Dispose() => Cancellation.Dispose();
    }

    internal sealed class DevToolsSession(Scenario state)
    {
        public IntPtr PresentedWindowHandle { get; private set; }
        public Task ActivateTargetAsync(CancellationToken cancellationToken) => ExecuteAsync("activate", cancellationToken);
        public Task MaximizeTargetWindowAsync(CancellationToken cancellationToken) => ExecuteAsync("maximize", cancellationToken);
        public Task BringToFrontAsync(CancellationToken cancellationToken) => ExecuteAsync("focus", cancellationToken);
        public async Task ConfirmForegroundWindowAsync(CancellationToken cancellationToken)
        {
            await ExecuteAsync("confirm", cancellationToken);
            PresentedWindowHandle = state.ConfirmedHandle = new IntPtr(22);
        }
        private async Task ExecuteAsync(string step, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            // The connected HWND is 11. This session's target belongs to HWND 22.
            // Operations follow session ownership, even when the two windows differ.
            state.Events.Add(step + ":22");
            state.Tokens.Add(cancellationToken);
            if (state.PauseCommands)
            {
                state.Started.Writer.TryWrite(true);
                await state.Release.Reader.ReadAsync(cancellationToken);
            }
            if (state.FailAt == step) throw state.Failure!;
            if (step == "maximize") state.TargetWindowState = "maximized";
            if (step == "focus") state.ForegroundWindow = 22;
            if (state.CancelAfter == step) state.Cancellation.Cancel();
            cancellationToken.ThrowIfCancellationRequested();
        }
    }

    internal sealed partial class PortalWorkflowController
    {
        public async Task RunProbeAsync(DevToolsSession session, Scenario scenario)
        {
            await PrepareBrowserForUserAsync(session, scenario.Cancellation.Token);
            scenario.Presented = true;
        }
    }
}
`;
