import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('connection awaits the report check after Nice is ready and before Edufine and monitoring', () => {
  const controller = fs.readFileSync(join(root, 'PortalWorkflowController.cs'), 'utf8');
  const prepare = controller.split('public async Task PrepareApplicationTargetsAsync(')[1]
    .split('public async Task<IReadOnlyList<SessionSystemResult>> ExtendExpiringSessionsAsync(')[0];
  const callback = prepare.indexOf('await afterNiceReady(cancellationToken)');
  assert.ok(callback > prepare.indexOf('await WaitForNiceReadyAsync('));
  assert.ok(callback > prepare.indexOf('await TryCloseVisibleNiceNoticeDialogAsync('));
  assert.ok(callback < prepare.indexOf('"K-에듀파인을 미리 여는 중"'));

  const main = fs.readFileSync(join(root, 'MainForm.cs'), 'utf8');
  const connection = main.split('private async Task ConnectSelectedBrowserAsync()')[1]
    .split('catch (OperationCanceledException)')[0];
  assert.match(connection, /await controller\.PrepareApplicationTargetsAsync\([\s\S]*?afterNiceReady: token => CheckFieldTripReportsOnConnectAsync\(/);
  assert.ok(connection.indexOf('CheckFieldTripReportsOnConnectAsync(') < connection.indexOf('UpdateAutoRefreshTimer()'));

  const workflow = main.split('private async Task RunWorkflowAsync(')[1]
    .split('private async Task CheckPortalSessionsInBackgroundAsync(')[0];
  assert.doesNotMatch(workflow, /RefreshFieldTripReportsAsync\(\)/);
});

test('actual report monitor checks on connection, polls every ten minutes, and preserves cancellation and deduplication',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-report-monitoring-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'MainForm.FieldTripReports.cs'))}" Link="MainForm.FieldTripReports.cs" />
          <Compile Include="${xml(resolve(root, 'NotificationCenter.cs'))}" Link="NotificationCenter.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: ten-minute timer, priority startup, no setting-triggered queries, manual refresh, deduplication, gate skipping, failure isolation, session expiry, cancellation, stale connection/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-report-monitoring-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
var probeRoot = Path.Combine(Path.GetTempPath(), "oneclick-report-monitoring-data-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(probeRoot);
try
{
    var office = new EducationOffice();
    var controller = new PortalWorkflowController();
    MainForm Form(string name) => new(Path.Combine(probeRoot, name + ".json"));
    NiceFieldTripReportReader.Reset();
    var form = Form("initial");
    Check(form.TimerInterval == 600_000, "Report timer must be ten minutes.");
    form.WorkflowRunning = true;
    await form.CheckOnConnect(controller, office);
    Check(controller.Prepares == 1 && NiceFieldTripReportReader.Reads == 1,
        "Connection must prepare and query the report while connection workflow is running.");
    Check(string.Join(",", NiceFieldTripReportReader.Events) == "prepare,read",
        "Report preparation must finish before the query starts.");
    Check(form.PopupItems == 1 && form.EntryCount == 1, "Existing unsubmitted report did not alert on connection.");
    Check(form.ReportStatus.Contains("10분마다"), "User-facing status still shows the old polling interval.");
    Check(!form.Reading && form.GateCount == 1, "Connection read did not release its gate and reading flag.");
    form.WorkflowRunning = false;
    for (var i = 0; i < 5; i++) form.UpdateMonitoring();
    Check(form.TimerEnabled && NiceFieldTripReportReader.Reads == 1,
        "Starting/reapplying monitoring settings must not trigger immediate queries.");
    await form.ManualRefresh();
    Check(NiceFieldTripReportReader.Reads == 2, "Manual refresh must query immediately.");
    Check(form.PopupItems == 1 && form.EntryCount == 1, "Same report created a duplicate notification.");
    form.HoldGate();
    await form.ScheduledRefresh();
    Check(NiceFieldTripReportReader.Reads == 2 && form.GateCount == 0 && !form.Reading,
        "Scheduled poll must skip a busy gate without queuing or releasing someone else's gate.");
    form.ReleaseGate();
    form.WorkflowRunning = true;
    await form.ScheduledRefresh();
    Check(NiceFieldTripReportReader.Reads == 2, "Scheduled poll ran during a user workflow.");
    form.WorkflowRunning = false;
    await form.ScheduledRefresh();
    Check(NiceFieldTripReportReader.Reads == 3 && form.PopupItems == 1,
        "An eligible scheduled refresh must query without duplicating the same report.");
    form.ExpireNice();
    await form.ScheduledRefresh();
    Check(NiceFieldTripReportReader.Reads == 3, "Expired Nice session must not query the report.");
    form.Disconnect();
    Check(!form.TimerEnabled, "Disconnect did not stop report monitoring.");
    await form.ScheduledRefresh();
    Check(NiceFieldTripReportReader.Reads == 3, "Disconnected monitor queried the report.");

    // A first-check failure must leave the connection available for other systems.
    NiceFieldTripReportReader.Reset();
    var failed = Form("failure");
    var failingController = new PortalWorkflowController
        { PrepareHandler = _ => throw new InvalidOperationException("no report permission") };
    await failed.CheckOnConnect(failingController, office);
    Check(NiceFieldTripReportReader.Reads == 0 && failed.IsConnected && failed.GateCount == 1 && !failed.Reading,
        "Report preparation failure blocked the connection or leaked the operation gate.");
    var expiredController = new PortalWorkflowController
        { PrepareHandler = _ => throw new PortalSessionExpiredException() };
    var expiryPropagated = false;
    try { await failed.CheckOnConnect(expiredController, office); }
    catch (PortalSessionExpiredException) { expiryPropagated = true; }
    Check(expiryPropagated && failed.GateCount == 1 && !failed.Reading,
        "Nice session expiry must reach connection recovery while releasing monitor state.");

    // Cancellation belongs to the caller and must not be swallowed as a benign timeout.
    var canceled = Form("cancel");
    using var cancellation = new CancellationTokenSource();
    cancellation.Cancel();
    var cancelPropagated = false;
    try { await canceled.CheckOnConnect(controller, office, cancellation.Token); }
    catch (OperationCanceledException) { cancelPropagated = true; }
    Check(cancelPropagated && canceled.GateCount == 1 && !canceled.Reading,
        "Caller cancellation was swallowed or leaked connection read state.");

    NiceFieldTripReportReader.Reset();
    var readerEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var completeReader = new TaskCompletionSource<FieldTripReportReadResult>(TaskCreationOptions.RunContinuationsAsynchronously);
    NiceFieldTripReportReader.Handler = _ => { readerEntered.SetResult(); return completeReader.Task; };
    var stale = Form("stale");
    var staleRead = stale.CheckOnConnect(new PortalWorkflowController(), office);
    await readerEntered.Task;
    stale.ChangeConnectionGeneration();
    completeReader.SetResult(NiceFieldTripReportReader.Pending);
    await staleRead;
    Check(stale.PopupItems == 0 && stale.EntryCount == 0 && stale.GateCount == 1 && !stale.Reading,
        "A result from a previous connection was applied after the connection changed.");

    // A waiting connection check must revalidate generation before opening any menu.
    NiceFieldTripReportReader.Reset();
    var waiting = Form("waiting");
    waiting.HoldGate();
    var waitingController = new PortalWorkflowController();
    var waitingRead = waiting.CheckOnConnect(waitingController, office);
    waiting.ChangeConnectionGeneration();
    waiting.ReleaseGate();
    await waitingRead;
    Check(waitingController.Prepares == 0 && NiceFieldTripReportReader.Reads == 0 && waiting.GateCount == 1,
        "A stale queued connection check opened a report menu.");

    var changedDuringPreparation = Form("prepared-stale");
    var interruptedController = new PortalWorkflowController
    {
        PrepareHandler = _ => { changedDuringPreparation.ChangeConnectionGeneration(); return Task.CompletedTask; },
    };
    await changedDuringPreparation.CheckOnConnect(interruptedController, office);
    Check(interruptedController.Prepares == 1 && NiceFieldTripReportReader.Reads == 0
        && changedDuringPreparation.GateCount == 1 && !changedDuringPreparation.Reading,
        "Connection change during menu preparation must prevent a query on the previous connection.");

    Console.WriteLine("PASS: ten-minute timer, priority startup, no setting-triggered queries, manual refresh, deduplication, gate skipping, failure isolation, session expiry, cancellation, stale connection");
}
finally
{
    var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
    if (!Path.GetFullPath(probeRoot).StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(probeRoot).StartsWith("oneclick-report-monitoring-data-", StringComparison.Ordinal))
        throw new Exception("Probe cleanup path is outside the temporary test directory.");
    Directory.Delete(probeRoot, recursive: true);
}

// These stubs replace external browser and Windows UI surfaces only. The monitor and
// persistent notification engine above are linked directly from production source.
namespace System.Windows.Forms
{
    internal sealed class Timer
    {
        public int Interval { get; set; }
        public bool Enabled { get; private set; }
        public void Start() => Enabled = true;
        public void Stop() => Enabled = false;
    }
}

namespace BrowserThumbnailPrototype
{
    internal sealed record EducationOffice;
    internal static class EducationOfficeCatalog
    {
        public static EducationOffice GetByCode(string code) => new();
    }
    internal static class AppPreferences
    {
        public static string GetEducationOfficeCode() => "TEST";
    }
    internal static class AppLogger
    {
        public static void Info(string area, string message) { }
    }
    internal enum FieldTripReportReadState
    {
        Available, PageMissing, MultiplePages, ReportPageMissing, ScopeUnavailable, Busy, QueryFailed, SnapshotUnavailable,
    }
    internal sealed record FieldTripReportReadResult(IReadOnlyList<NotificationSourceItem>? Items,
        string? Scope, FieldTripReportReadState State, string? SourceId = null);
    internal static class NiceFieldTripReportReader
    {
        public static int Reads { get; private set; }
        public static List<string> Events { get; } = [];
        public static Func<CancellationToken, Task<FieldTripReportReadResult>>? Handler { get; set; }
        public static FieldTripReportReadResult Pending => new([new("REPORT-A", "")], "TEST/USER/SCHOOL", FieldTripReportReadState.Available);
        public static Task<FieldTripReportReadResult> ReadAsync(int port, EducationOffice office, CancellationToken token)
        {
            Reads++;
            Events.Add("read");
            return Handler?.Invoke(token) ?? Task.FromResult(Pending);
        }
        public static void Reset() { Reads = 0; Events.Clear(); Handler = null; }
    }
    internal sealed class PortalSessionExpiredException : Exception { }
    internal sealed class PortalWorkflowController
    {
        public int Prepares { get; private set; }
        public Func<CancellationToken, Task>? PrepareHandler { get; init; }
        public Task EnsureFieldTripReportReadyAsync(CancellationToken token)
        {
            Prepares++;
            NiceFieldTripReportReader.Events.Add("prepare");
            return PrepareHandler?.Invoke(token) ?? Task.CompletedTask;
        }
    }
    public sealed partial class MainForm
    {
        private bool _isClosing;
        private bool IsDisposed => false;
        private bool Disposing => false;
        private IntPtr _sourceWindow = new(99);
        private int? _devToolsPort = 9222;
        private int _connectionGeneration = 1;
        private bool _workflowRunning;
        private bool _studentNotificationPreview;
        private readonly SemaphoreSlim _portalOperationGate = new(1, 1);
        private readonly HashSet<string> _confirmedExpiredSystems = [];
        private readonly NotificationCenter _notificationCenter;
        public MainForm(string store) => _notificationCenter = new(store);
        internal int PopupItems { get; private set; }
        internal int EntryCount => _notificationCenter.Entries.Count;
        internal int TimerInterval => _fieldTripReportTimer.Interval;
        internal bool TimerEnabled => _fieldTripReportTimer.Enabled;
        internal bool Reading => _fieldTripReportReading;
        internal int GateCount => _portalOperationGate.CurrentCount;
        internal string ReportStatus => _fieldTripReportStatus;
        internal bool IsConnected => _sourceWindow != IntPtr.Zero && _devToolsPort is not null;
        internal bool WorkflowRunning { set => _workflowRunning = value; }
        internal void UpdateMonitoring() => UpdateFieldTripReportMonitoring();
        internal Task CheckOnConnect(PortalWorkflowController controller, EducationOffice office, CancellationToken token = default)
            => CheckFieldTripReportsOnConnectAsync(controller, _devToolsPort!.Value, office, token);
        internal Task ScheduledRefresh() => RefreshScheduledFieldTripReportsAsync();
        internal Task ManualRefresh() => RefreshFieldTripReportsAsync();
        internal void HoldGate() => _portalOperationGate.Wait();
        internal void ReleaseGate() => _portalOperationGate.Release();
        internal void ExpireNice() => _confirmedExpiredSystems.Add("나이스");
        internal void ChangeConnectionGeneration() => _connectionGeneration++;
        internal void Disconnect() { _connectionGeneration++; _sourceWindow = IntPtr.Zero; _devToolsPort = null; StopFieldTripReportMonitoring(); }
        private void SetConnectionStatus(string status) { }
        private void RefreshNotificationSourceStatus() { }
        private void ShowNewNotificationPopup(IReadOnlyList<PortalNotification> added) => PopupItems += added.Count;
    }
}
`;
