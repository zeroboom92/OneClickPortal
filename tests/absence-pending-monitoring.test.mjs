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

test('absence monitoring is bounded, serialized and uses the pending-specific daily notification API', () => {
  const source = fs.readFileSync(join(root, 'MainForm.AbsenceReports.cs'), 'utf8');
  assert.equal((source.match(/TimeSpan\.FromSeconds\(25\)/g) ?? []).length, 2);
  assert.match(source, /AbsenceReportIntervalMinutes = 10/);
  assert.match(source, /ObservePendingAbsenceReports\(items, result\.Scope\)/);
  assert.doesNotMatch(source, /ObserveItems|ObserveCount|ObservePendingFieldTripReports/);
  assert.doesNotMatch(source, /PortalWorkflowController|ActivateTarget|Maximize|Navigate|Click\w*Menu/);
  assert.doesNotMatch(source, /exception\.(Message|StackTrace|ToString)|SourceId|\.Summary/);
  assert.match(source, /WaitAsync\(0, cancellation\.Token\)/);
  assert.match(source, /catch \(PortalSessionExpiredException\) \{ throw; \}/);
  assert.match(source, /catch \(OperationCanceledException\) when \(!cancellationToken\.IsCancellationRequested\)/);
});

test('the real connection, refresh, lifecycle and notification UI include pending absence reports', () => {
  const main = fs.readFileSync(join(root, 'MainForm.cs'), 'utf8');
  const connection = main.split('private async Task ConnectSelectedBrowserAsync()')[1]
    .split('catch (OperationCanceledException)')[0];
  assert.match(connection, /afterNiceReady: async token =>\s*\{\s*await CheckFieldTripReportsOnConnectAsync\([\s\S]*?await CheckAbsenceReportsOnConnectAsync\(_devToolsPort\.Value, educationOffice, token\);\s*\}/);
  assert.ok(connection.indexOf('CheckAbsenceReportsOnConnectAsync(') < connection.indexOf('UpdateAutoRefreshTimer()'));
  const controller = fs.readFileSync(join(root, 'PortalWorkflowController.cs'), 'utf8');
  const prepare = controller.split('public async Task PrepareApplicationTargetsAsync(')[1]
    .split('public async Task<IReadOnlyList<SessionSystemResult>> ExtendExpiringSessionsAsync(')[0];
  assert.ok(prepare.indexOf('await afterNiceReady(cancellationToken)') > prepare.indexOf('await WaitForNiceReadyAsync('));
  assert.ok(prepare.indexOf('await afterNiceReady(cancellationToken)') < prepare.indexOf('"K-에듀파인을 미리 여는 중"'));
  assert.match(main, /_absenceReportTimer\.Tick \+= async \(_, _\) => await RefreshScheduledAbsenceReportsAsync\(\)/);
  assert.match(main, /await RefreshFieldTripReportsAsync\(\);\s*await RefreshAbsenceReportsAsync\(\);\s*await RefreshApprovalBadgeAsync\(\)/);
  assert.match(main, /UpdateFieldTripReportMonitoring\(\);\s*UpdateAbsenceReportMonitoring\(\)/);
  assert.match(main, /_absenceReportTimer\.Dispose\(\)/);
  const disconnect = main.split('private void DisconnectBrowser()')[1]
    .split('private void CheckSourceWindow()')[0];
  assert.match(disconnect, /StopAbsenceReportMonitoring\(\)/);
  assert.ok((main.match(/CancelAbsenceReportReadForExpiredSession\(\)/g) ?? []).length >= 3,
    'Connection, workflow and session monitoring must all cancel reads after confirmed Nice expiry.');

  const notifications = fs.readFileSync(join(root, 'MainForm.Notifications.cs'), 'utf8');
  assert.match(notifications, /NotificationKind\.AbsencePending or NotificationKind\.FieldTripReport\s*=> !_confirmedExpiredSystems\.Contains\("나이스"\)/);
  assert.match(notifications, /else if \(kind == NotificationKind\.AbsencePending\) _ = RunWorkflowAsync\(PortalTaskKind\.AbsenceReportManagement\)/);
  assert.match(notifications, /_absenceReportCancellationSource\?\.Cancel\(\)/);
  assert.match(notifications, /_absenceReportStatus/);
  const center = fs.readFileSync(join(root, 'NotificationCenterForm.cs'), 'utf8');
  assert.match(center, /NotificationKind\.AbsencePending => \$"결석신고서 접수대기 \{entry\.ItemCount:N0\}건"/);
});

test('actual absence monitor alerts for all initial pending items and protects daily history across reads and reconnects',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-absence-monitoring-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'MainForm.AbsenceReports.cs'))}" Link="MainForm.AbsenceReports.cs" />
          <Compile Include="${xml(resolve(root, 'NotificationCenter.cs'))}" Link="NotificationCenter.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: initial three pending, same-day persistence, new items, manual and scheduled gate, unavailable results, errors, expired session, cancellation, stale generation, overlapping reconnect, simulation isolation/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-absence-monitoring-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
var probeRoot = Path.Combine(Path.GetTempPath(), "oneclick-absence-monitoring-data-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(probeRoot);
try
{
    var office = new EducationOffice();
    MainForm Form(string name) => new(Path.Combine(probeRoot, name + ".json"));
    NiceAbsencePendingReader.Reset();
    var form = Form("initial");
    form.WorkflowRunning = true;
    await form.CheckOnConnect(office);
    Check(NiceAbsencePendingReader.Reads == 1 && NiceAbsencePendingReader.RefreshRequested,
        "Connection must run an initial refreshing read even during connection setup.");
    Check(form.Entries.Count == 1 && form.PopupItems == 1 && form.Entries[0].ItemCount == 3
        && form.Entries[0].Kind == NotificationKind.AbsencePending,
        "All three already-pending applications must create one generic count alert on the first connection.");
    Check(form.Entries[0].Title == "결석신고서 접수대기" && form.Entries[0].Message.Contains("3건"),
        "Initial pending alert has the wrong label or count.");
    Check(!File.ReadAllText(Path.Combine(probeRoot, "initial.json")).Contains("PRIVATE"),
        "Raw student names, identifiers or source scopes leaked into persistent history.");
    Check(form.ReportStatus.Contains("3건") && form.ReportStatus.Contains("10분마다")
        && form.TimerInterval == 600_000 && !form.Reading && form.GateCount == 1,
        "Connection did not retain a count summary, ten-minute timer or release its read state.");
    form.WorkflowRunning = false;
    for (var index = 0; index < 5; index++) form.UpdateMonitoring();
    Check(form.TimerEnabled && NiceAbsencePendingReader.Reads == 1,
        "Repeated settings updates must start a timer without issuing immediate reads.");
    await form.ManualRefresh();
    await form.ScheduledRefresh();
    Check(NiceAbsencePendingReader.Reads == 3 && form.PopupItems == 1 && form.Entries.Count == 1,
        "Repeated manual and scheduled snapshots duplicated same-day pending alerts.");
    var reconnect = Form("initial");
    await reconnect.CheckOnConnect(office);
    Check(reconnect.PopupItems == 0 && reconnect.Entries.Count == 1,
        "A reconnect or app restart duplicated persisted same-day pending applications.");
    reconnect.ClearReadHistory();
    await reconnect.ManualRefresh();
    Check(reconnect.PopupItems == 0 && reconnect.Entries.Count == 0,
        "Clearing visible history must not erase same-day pending deduplication.");
    NiceAbsencePendingReader.Handler = _ => Task.FromResult(NiceAbsencePendingReader.Pending with
        { Items = [new("PRIVATE-REPORT-A", ""), new("PRIVATE-REPORT-B", ""), new("PRIVATE-REPORT-C", ""), new("PRIVATE-REPORT-D", "")] });
    await reconnect.ManualRefresh();
    Check(reconnect.Entries.Count == 1 && reconnect.Entries[0].ItemCount == 1 && reconnect.PopupItems == 1,
        "A newly pending application after the initial snapshot must alert separately the same day.");

    NiceAbsencePendingReader.Reset();
    var gate = Form("gate");
    gate.HoldGate();
    await gate.ScheduledRefresh();
    Check(NiceAbsencePendingReader.Reads == 0 && !gate.Reading && gate.GateCount == 0,
        "A scheduled tick must skip a busy gate without releasing another operation's ownership.");
    var manual = gate.ManualRefresh();
    Check(!manual.IsCompleted && NiceAbsencePendingReader.Reads == 0 && gate.Reading,
        "Manual refresh must wait for active portal work.");
    gate.ReleaseGate();
    await manual;
    Check(NiceAbsencePendingReader.Reads == 1 && gate.GateCount == 1 && !gate.Reading,
        "Manual refresh failed to run after the gate became available.");
    gate.WorkflowRunning = true;
    await gate.ManualRefresh();
    await gate.ScheduledRefresh();
    Check(NiceAbsencePendingReader.Reads == 1, "Monitoring ran during an interactive workflow.");
    gate.WorkflowRunning = false;
    gate.HoldGate();
    var waitingManual = gate.ManualRefresh();
    gate.WorkflowRunning = true;
    gate.ReleaseGate();
    await waitingManual;
    Check(NiceAbsencePendingReader.Reads == 1 && !gate.Reading && gate.GateCount == 1,
        "A queued refresh failed to recheck interactive workflow state.");

    foreach (var state in Enum.GetValues<AbsencePendingReadState>().Where(value => value != AbsencePendingReadState.Available))
    {
        NiceAbsencePendingReader.Reset();
        NiceAbsencePendingReader.Handler = _ => Task.FromResult(NiceAbsencePendingReader.Pending with { State = state });
        var unavailable = Form("unavailable-" + state);
        await unavailable.CheckOnConnect(office);
        await unavailable.ManualRefresh();
        await unavailable.ScheduledRefresh();
        Check(unavailable.PopupItems == 0 && unavailable.Entries.Count == 0 && unavailable.GateCount == 1 && !unavailable.Reading,
            "An incomplete, unauthenticated, busy or unauthorized result created an alert or leaked state: " + state);
    }
    foreach (var invalid in new[]
    {
        NiceAbsencePendingReader.Pending with { Items = null },
        NiceAbsencePendingReader.Pending with { Scope = null },
        NiceAbsencePendingReader.Pending with { Scope = " " },
        NiceAbsencePendingReader.Pending with { Items = [] },
    })
    {
        NiceAbsencePendingReader.Reset();
        NiceAbsencePendingReader.Handler = _ => Task.FromResult(invalid);
        var empty = Form(Guid.NewGuid().ToString("N"));
        await empty.CheckOnConnect(office);
        Check(empty.PopupItems == 0 && empty.Entries.Count == 0, "Unavailable or empty data created pending alerts.");
    }

    NiceAbsencePendingReader.Reset();
    NiceAbsencePendingReader.Handler = _ => throw new InvalidOperationException("PRIVATE page data");
    var failed = Form("failure");
    await failed.CheckOnConnect(office);
    Check(failed.IsConnected && failed.GateCount == 1 && !failed.Reading && failed.PopupItems == 0,
        "A pending-read failure blocked connection setup or leaked operation state.");
    await failed.ManualRefresh();
    await failed.ScheduledRefresh();
    Check(!AppLogger.Messages.Any(value => value.Contains("PRIVATE")), "Page exception data leaked into logging.");
    NiceAbsencePendingReader.Handler = _ => throw new PortalSessionExpiredException();
    var expiryPropagated = false;
    try { await failed.CheckOnConnect(office); }
    catch (PortalSessionExpiredException) { expiryPropagated = true; }
    Check(expiryPropagated && failed.GateCount == 1 && !failed.Reading,
        "Connection session expiry must reach existing session recovery and release read state.");
    await failed.ManualRefresh();
    Check(failed.ReportStatus.Contains("재로그인") && failed.GateCount == 1 && !failed.Reading,
        "Background session expiry must require login without creating notifications or leaking state.");

    NiceAbsencePendingReader.Reset();
    var expired = Form("expired");
    expired.ExpireNice();
    await expired.ManualRefresh();
    await expired.ScheduledRefresh();
    await expired.CheckOnConnect(office);
    Check(NiceAbsencePendingReader.Reads == 0 && expired.PopupItems == 0 && expired.ReportStatus.Contains("재로그인"),
        "A known expired session must not issue additional pending reads.");
    expired.Disconnect();
    Check(!expired.TimerEnabled && expired.ReportStatus.Contains("브라우저 연결 후"), "Disconnect failed to stop monitoring.");
    await expired.ManualRefresh();
    Check(NiceAbsencePendingReader.Reads == 0, "A disconnected monitor queried a source.");

    var canceled = Form("cancel");
    using var cancellation = new CancellationTokenSource();
    cancellation.Cancel();
    var callerCanceled = false;
    try { await canceled.CheckOnConnect(office, cancellation.Token); }
    catch (OperationCanceledException) { callerCanceled = true; }
    Check(callerCanceled && canceled.GateCount == 1 && !canceled.Reading,
        "Explicit connection cancellation was swallowed or leaked read state.");

    foreach (var mode in new[] { "connection", "manual", "scheduled" })
    foreach (var invalidate in new[] { "generation", "expiry", "disconnect" })
    {
        NiceAbsencePendingReader.Reset();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource<AbsencePendingReadResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        NiceAbsencePendingReader.Handler = _ => { entered.SetResult(); return completed.Task; };
        var stale = Form(mode + "-" + invalidate);
        var read = mode == "connection" ? stale.CheckOnConnect(office)
            : mode == "manual" ? stale.ManualRefresh() : stale.ScheduledRefresh();
        await entered.Task;
        if (invalidate == "generation") stale.ChangeConnectionGeneration();
        else if (invalidate == "expiry") stale.ExpireNice();
        else stale.Disconnect();
        completed.SetResult(NiceAbsencePendingReader.Pending);
        await read;
        Check(stale.PopupItems == 0 && stale.Entries.Count == 0 && stale.GateCount == 1 && !stale.Reading,
            "A stale or expired read applied its result or leaked ownership: " + mode + "/" + invalidate);
        if (invalidate == "expiry") Check(stale.ReportStatus.Contains("재로그인"), "A late result replaced the expired-session status.");
        if (invalidate == "disconnect") Check(stale.ReportStatus.Contains("브라우저 연결 후"), "A late result replaced the disconnected status.");
    }

    NiceAbsencePendingReader.Reset();
    var queued = Form("queued-connection");
    queued.HoldGate();
    var queuedRead = queued.CheckOnConnect(office);
    queued.ChangeConnectionGeneration();
    queued.ReleaseGate();
    await queuedRead;
    Check(NiceAbsencePendingReader.Reads == 0 && queued.GateCount == 1 && !queued.Reading,
        "A queued initial read used an obsolete connection after waiting for the gate.");

    NiceAbsencePendingReader.Reset();
    var previousEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var nextEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var previousResult = new TaskCompletionSource<AbsencePendingReadResult>(TaskCreationOptions.RunContinuationsAsynchronously);
    var nextResult = new TaskCompletionSource<AbsencePendingReadResult>(TaskCreationOptions.RunContinuationsAsynchronously);
    NiceAbsencePendingReader.Handler = _ =>
    {
        if (NiceAbsencePendingReader.Reads == 1) { previousEntered.SetResult(); return previousResult.Task; }
        nextEntered.SetResult(); return nextResult.Task;
    };
    var overlapping = Form("overlapping");
    var previousRead = overlapping.CheckOnConnect(office);
    await previousEntered.Task;
    overlapping.ChangeConnectionGeneration();
    var nextRead = overlapping.CheckOnConnect(office);
    previousResult.SetResult(NiceAbsencePendingReader.Pending);
    await previousRead;
    await nextEntered.Task;
    Check(overlapping.Reading && overlapping.HasReadCancellation && overlapping.GateCount == 0 && overlapping.PopupItems == 0,
        "The previous connection cleared the newer connection's read ownership.");
    nextResult.SetResult(NiceAbsencePendingReader.Pending);
    await nextRead;
    Check(!overlapping.Reading && !overlapping.HasReadCancellation && overlapping.GateCount == 1
        && overlapping.PopupItems == 1 && overlapping.Entries[0].ItemCount == 3,
        "The current overlapping connection did not produce exactly one pending summary or release state.");

    NiceAbsencePendingReader.Reset();
    var preview = Form("preview");
    preview.StudentPreview = true;
    await preview.CheckOnConnect(office);
    await preview.ManualRefresh();
    Check(preview.PopupItems == 0 && preview.Entries.Count == 0 && NiceAbsencePendingReader.Reads == 2,
        "Real pending applications contaminated the explicit synthetic notification preview.");

    Console.WriteLine("PASS: initial three pending, same-day persistence, new items, manual and scheduled gate, unavailable results, errors, expired session, cancellation, stale generation, overlapping reconnect, simulation isolation");
}
finally
{
    var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
    if (!Path.GetFullPath(probeRoot).StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(probeRoot).StartsWith("oneclick-absence-monitoring-data-", StringComparison.Ordinal))
        throw new Exception("Probe cleanup path is outside the temporary test directory.");
    Directory.Delete(probeRoot, recursive: true);
}

// Only external browser and native UI surfaces are stubbed. The production monitor
// and persistent notification engine are linked directly into this executable.
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
        public static readonly List<string> Messages = [];
        public static void Info(string area, string message) => Messages.Add(area + ": " + message);
    }
    internal enum AbsencePendingReadState
    {
        Available, PageMissing, MultiplePages, ScopeUnavailable, Busy, QueryFailed, SnapshotUnavailable, NotAuthorized,
    }
    internal sealed record AbsencePendingReadResult(IReadOnlyList<NotificationSourceItem>? Items,
        string? Scope, AbsencePendingReadState State, string? SourceId = null);
    internal static class NiceAbsencePendingReader
    {
        public static int Reads { get; private set; }
        public static bool RefreshRequested { get; private set; }
        public static Func<CancellationToken, Task<AbsencePendingReadResult>>? Handler { get; set; }
        public static AbsencePendingReadResult Pending => new(
            [new("PRIVATE-REPORT-A", "PRIVATE-STUDENT-A"), new("PRIVATE-REPORT-B", "PRIVATE-STUDENT-B"), new("PRIVATE-REPORT-C", "PRIVATE-STUDENT-C")],
            "PRIVATE-OFFICE/PRIVATE-ACCOUNT/PRIVATE-SCHOOL", AbsencePendingReadState.Available);
        public static Task<AbsencePendingReadResult> ReadAsync(int port, EducationOffice office, CancellationToken token, bool refresh = true)
        {
            Reads++;
            RefreshRequested = refresh;
            return Handler?.Invoke(token) ?? Task.FromResult(Pending);
        }
        public static void Reset() { Reads = 0; Handler = null; RefreshRequested = false; }
    }
    internal sealed class PortalSessionExpiredException : Exception { }
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
        internal IReadOnlyList<PortalNotification> Entries => _notificationCenter.Entries;
        internal int PopupItems { get; private set; }
        internal int TimerInterval => _absenceReportTimer.Interval;
        internal bool TimerEnabled => _absenceReportTimer.Enabled;
        internal bool Reading => _absenceReportReading;
        internal bool HasReadCancellation => _absenceReportCancellationSource is not null;
        internal int GateCount => _portalOperationGate.CurrentCount;
        internal string ReportStatus => _absenceReportStatus;
        internal bool IsConnected => _sourceWindow != IntPtr.Zero && _devToolsPort is not null;
        internal bool WorkflowRunning { set => _workflowRunning = value; }
        internal bool StudentPreview { set => _studentNotificationPreview = value; }
        internal void UpdateMonitoring() => UpdateAbsenceReportMonitoring();
        internal Task CheckOnConnect(EducationOffice office, CancellationToken token = default)
            => CheckAbsenceReportsOnConnectAsync(_devToolsPort!.Value, office, token);
        internal Task ScheduledRefresh() => RefreshScheduledAbsenceReportsAsync();
        internal Task ManualRefresh() => RefreshAbsenceReportsAsync();
        internal void HoldGate() => _portalOperationGate.Wait();
        internal void ReleaseGate() => _portalOperationGate.Release();
        internal void ExpireNice() { _confirmedExpiredSystems.Add("나이스"); CancelAbsenceReportReadForExpiredSession(); }
        internal void ChangeConnectionGeneration() => _connectionGeneration++;
        internal void ClearReadHistory() { _notificationCenter.MarkAllRead(); _notificationCenter.ClearRead(); }
        internal void Disconnect() { _connectionGeneration++; _sourceWindow = IntPtr.Zero; _devToolsPort = null; StopAbsenceReportMonitoring(); }
        private void SetConnectionStatus(string status) { }
        private void RefreshNotificationSourceStatus() { }
        private void ShowNewNotificationPopup(IReadOnlyList<PortalNotification> added) => PopupItems += added.Count;
    }
}
`;
