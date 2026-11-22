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

test('Nice approval monitor uses a one-minute request schedule and bounded read-only reader work', () => {
  const monitor = fs.readFileSync(join(root, 'MainForm.NiceApprovals.cs'), 'utf8');
  assert.match(monitor, /Interval = 5 \* 1000/);
  assert.match(monitor, /_niceApprovalPolling\.IsDue\(Environment\.TickCount64, edufineActive: false\)/);
  assert.match(monitor, /TimeSpan\.FromSeconds\(25\)/);
  assert.match(monitor, /WaitAsync\(0, cancellation\.Token\)/);
  assert.match(monitor, /ObserveCount\(NotificationKind\.NiceApproval, count, result\.Scope\)/);
  assert.doesNotMatch(monitor, /PortalWorkflowController|ActivateTarget|Navigate|Click\w*Menu|exception\.(Message|StackTrace|ToString)|result\.SourceId/);
  const update = monitor.split('private void UpdateNiceApprovalMonitoring()')[1].split('private void StopNiceApprovalMonitoring()')[0];
  assert.doesNotMatch(update, /AppPreferences\.IsPortalAutoRefreshEnabled|ReadAsync|RefreshNiceApprovals/);
});

test('real Nice approval timer, connection, refresh, expiry, teardown, tooltip and navigation are wired', () => {
  const main = fs.readFileSync(join(root, 'MainForm.cs'), 'utf8');
  const notifications = fs.readFileSync(join(root, 'MainForm.Notifications.cs'), 'utf8');
  assert.match(main, /_niceApprovalTimer\.Tick \+= async \(_, _\) => await RefreshScheduledNiceApprovalsAsync\(\)/);
  assert.match(main, /_niceApprovalTimer\.Dispose\(\)/);
  assert.ok((main.match(/StopNiceApprovalMonitoring\(\)/g) ?? []).length >= 4,
    'Form shutdown, disposal, manual disconnect and lost-window paths must stop monitoring.');
  assert.ok((main.match(/CancelNiceApprovalReadForExpiredSession\(\)/g) ?? []).length >= 3,
    'Connection, workflows and session checks must cancel reads on confirmed Nice expiry.');
  const connection = main.split('private async Task ConnectSelectedBrowserAsync()')[1]
    .split('catch (OperationCanceledException)')[0];
  assert.ok(connection.indexOf('await CheckNiceApprovalsOnConnectAsync(') > connection.indexOf('await controller.PrepareApplicationTargetsAsync('));
  assert.ok(connection.indexOf('await CheckNiceApprovalsOnConnectAsync(') < connection.indexOf('UpdateAutoRefreshTimer()'));
  const refresh = main.split('_refreshButton.Click += async')[1].split('connectionControls.Controls.Add(_refreshButton')[0];
  assert.match(refresh, /await RefreshNiceApprovalsAsync\(\)/);
  const timers = main.split('private void UpdateAutoRefreshTimer()')[1].split('private void PositionAtBottomRight()')[0];
  assert.match(timers, /UpdateNiceApprovalMonitoring\(\)/);
  const disconnect = main.split('private void DisconnectBrowser()')[1].split('private void CheckSourceWindow()')[0];
  assert.match(disconnect, /StopNiceApprovalMonitoring\(\)/);
  const reset = notifications.split('private void ResetNotificationObservations()')[1].split('private void ShowNewNotificationPopup(')[0];
  assert.match(reset, /_niceApprovalCancellationSource\?\.Cancel\(\)/);
  assert.match(reset, /_notificationCenter\.ResetObservations\(\)/);
  assert.match(notifications, /NotificationKind\.NiceApproval => !_confirmedExpiredSystems\.Contains\("나이스"\)/);
  assert.match(notifications, /else if \(kind == NotificationKind\.NiceApproval\) _ = RunWorkflowAsync\(PortalTaskKind\.NiceApproval\)/);
  assert.match(notifications, /_niceApprovalStatus/);
  assert.match(notifications, /에듀파인·나이스 결재대기/);
});

test('actual Nice approval partial monitor serializes reads, retries busy ticks and suppresses stale or failed results',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-nice-approval-monitoring-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>${['MainForm.NiceApprovals.cs', 'ApprovalPollingSchedule.cs', 'NotificationCenter.cs', 'AppRelease.cs']
          .map(name => `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('')}</ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', project, '--configuration', 'Release', '--nologo'],
        { timeout: 100_000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /PASS: one-minute schedule, busy retry, immediate connection, manual gate, independent baseline, failed reads, cancellation, stale connection, expired session, preview suppression/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-nice-approval-monitoring-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Reflection;

void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
var probeRoot = Path.Combine(Path.GetTempPath(), "oneclick-nice-approval-monitoring-data-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(probeRoot);
try
{
    MainForm Form(string name) => new(Path.Combine(probeRoot, name + ".json"));
    NiceApprovalReader.Reset();
    var initial = Form("initial");
    initial.WorkflowRunning = true;
    await initial.CheckOnConnect();
    Check(NiceApprovalReader.Reads == 1 && initial.PopupItems == 0 && initial.Entries.Count == 0
        && initial.ConnectionStatus.Contains("나이스 결재대기") && initial.ApprovalStatus.Contains("4건")
        && initial.ApprovalStatus.Contains("1분마다") && initial.TimerInterval == 5_000 && initial.MenuCount == 4,
        "Connection did not perform an immediate quiet baseline read during connection setup.");
    initial.WorkflowRunning = false;
    for (var index = 0; index < 5; index++) initial.UpdateMonitoring();
    Check(initial.TimerEnabled && NiceApprovalReader.Reads == 1, "Repeated timer/settings updates caused immediate reads.");
    await initial.ScheduledRefresh();
    Check(NiceApprovalReader.Reads == 1, "A five-second UI tick issued another server request before one minute.");
    var attemptedAt = initial.LastAttempt!.Value;
    Check(!initial.IsDueAt(attemptedAt + 59_999) && initial.IsDueAt(attemptedAt + 60_000),
        "Nice approval requests do not follow the background one-minute schedule.");
    initial.MakeDue();
    NiceApprovalReader.Count = 6;
    await initial.ScheduledRefresh();
    Check(NiceApprovalReader.Reads == 2 && initial.PopupItems == 1 && initial.Entries.Single().ItemCount == 2
        && initial.Entries.Single().Kind == NotificationKind.NiceApproval && initial.MenuCount == 6,
        "The next due Nice request failed to publish only the count increase.");
    initial.EstablishEdufineBaseline(50);
    NiceApprovalReader.Count = 7;
    await initial.ManualRefresh();
    Check(initial.Entries[0].Kind == NotificationKind.NiceApproval && initial.Entries[0].ItemCount == 3
        && initial.ObserveEdufine(51).Single().ItemCount == 1,
        "Nice approval reads changed the existing Edufine baseline.");
    Check(!File.ReadAllText(Path.Combine(probeRoot, "initial.json")).Contains("PRIVATE", StringComparison.Ordinal),
        "The monitor persisted a source scope or source ID.");

    NiceApprovalReader.Reset();
    var busy = Form("busy");
    busy.HoldGate();
    await busy.ScheduledRefresh();
    Check(NiceApprovalReader.Reads == 0 && !busy.Reading && busy.GateCount == 0 && busy.LastAttempt is null,
        "Busy scheduled work waited, released another operation's gate or consumed its schedule.");
    busy.ReleaseGate();
    await busy.ScheduledRefresh();
    Check(NiceApprovalReader.Reads == 1 && busy.GateCount == 1 && !busy.Reading && busy.LastAttempt is not null,
        "A busy tick did not retry immediately on the next available tick.");
    busy.MakeDue();
    var dueBeforeBusy = busy.LastAttempt;
    busy.HoldGate();
    await busy.ScheduledRefresh();
    Check(busy.LastAttempt == dueBeforeBusy && NiceApprovalReader.Reads == 1,
        "A later busy tick postponed a due request for another minute.");
    var manual = busy.ManualRefresh();
    Check(!manual.IsCompleted && busy.Reading && NiceApprovalReader.Reads == 1,
        "A manual request did not wait for the shared portal gate.");
    busy.ReleaseGate();
    await manual;
    Check(NiceApprovalReader.Reads == 2 && !busy.Reading && busy.GateCount == 1,
        "A queued manual request failed to run or release ownership.");
    busy.WorkflowRunning = true;
    busy.MakeDue();
    await busy.ManualRefresh();
    await busy.ScheduledRefresh();
    Check(NiceApprovalReader.Reads == 2, "Regular monitoring ran during an interactive workflow.");
    busy.WorkflowRunning = false;
    busy.HoldGate();
    var queuedManual = busy.ManualRefresh();
    busy.WorkflowRunning = true;
    busy.ReleaseGate();
    await queuedManual;
    Check(NiceApprovalReader.Reads == 2 && !busy.Reading && busy.GateCount == 1,
        "Manual work failed to recheck workflow state after waiting for the gate.");

    foreach (var state in Enum.GetValues<NiceApprovalReadState>().Where(state => state != NiceApprovalReadState.Available))
    {
        NiceApprovalReader.Reset();
        var failed = Form("failed-" + state);
        NiceApprovalReader.Count = 10;
        await failed.CheckOnConnect();
        NiceApprovalReader.Handler = _ => Task.FromResult(new NiceApprovalReadResult(0, "PRIVATE-SCOPE", state));
        await failed.ManualRefresh();
        Check(failed.Entries.Count == 0 && failed.PopupItems == 0 && failed.GateCount == 1 && !failed.Reading
            && failed.MenuCount is null,
            "An unavailable read created an alert or retained ownership: " + state);
        NiceApprovalReader.Handler = null;
        NiceApprovalReader.Count = 11;
        await failed.ManualRefresh();
        Check(failed.Entries.Single().ItemCount == 1 && failed.PopupItems == 1,
            "An unavailable read changed the last successful baseline: " + state);
    }
    foreach (var invalid in new[]
    {
        new NiceApprovalReadResult(null, "PRIVATE-SCOPE", NiceApprovalReadState.Available),
        new NiceApprovalReadResult(-1, "PRIVATE-SCOPE", NiceApprovalReadState.Available),
        new NiceApprovalReadResult(0, null, NiceApprovalReadState.Available),
        new NiceApprovalReadResult(0, " ", NiceApprovalReadState.Available),
    })
    {
        NiceApprovalReader.Reset();
        var invalidForm = Form("invalid-" + Guid.NewGuid().ToString("N"));
        NiceApprovalReader.Count = 10;
        await invalidForm.CheckOnConnect();
        NiceApprovalReader.Handler = _ => Task.FromResult(invalid);
        await invalidForm.ManualRefresh();
        NiceApprovalReader.Handler = null;
        NiceApprovalReader.Count = 11;
        await invalidForm.ManualRefresh();
        Check(invalidForm.Entries.Single().ItemCount == 1 && invalidForm.PopupItems == 1,
            "An invalid available result changed the last successful count baseline.");
    }

    NiceApprovalReader.Reset();
    var failure = Form("exception");
    await failure.CheckOnConnect();
    NiceApprovalReader.Handler = _ => throw new InvalidOperationException("PRIVATE DOCUMENT DATA");
    await failure.ManualRefresh();
    Check(failure.ApprovalStatus.Contains("확인하지 못했습니다") && !failure.Reading && failure.GateCount == 1,
        "A reader exception escaped or leaked operation state.");
    Check(!AppLogger.Messages.Any(message => message.Contains("PRIVATE", StringComparison.Ordinal)),
        "Reader exceptions leaked document text or source information into logs.");
    NiceApprovalReader.Handler = _ => throw new PortalSessionExpiredException();
    await failure.ManualRefresh();
    Check(failure.ApprovalStatus.Contains("재로그인") && !failure.Reading && failure.GateCount == 1,
        "A session-expired reader failure did not preserve login status and release the gate.");

    NiceApprovalReader.Reset();
    var expired = Form("known-expired");
    expired.ExpireNice();
    await expired.CheckOnConnect();
    await expired.ManualRefresh();
    await expired.ScheduledRefresh();
    Check(NiceApprovalReader.Reads == 0 && expired.PopupItems == 0 && expired.ApprovalStatus.Contains("재로그인"),
        "A known expired Nice session issued approval requests.");
    expired.Disconnect();
    await expired.ManualRefresh();
    Check(!expired.TimerEnabled && expired.LastAttempt is null && NiceApprovalReader.Reads == 0
        && expired.ApprovalStatus.Contains("브라우저 연결 후"),
        "Disconnect failed to stop monitoring, reset scheduling or suppress reads.");

    foreach (var mode in new[] { "connection", "manual", "scheduled" })
    foreach (var invalidate in new[] { "generation", "port", "window", "expiry", "disconnect", "cancel", "closing", "disposed", "disposing" })
    {
        NiceApprovalReader.Reset();
        var stale = Form(mode + "-" + invalidate);
        await stale.CheckOnConnect();
        stale.MakeDue();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var completed = new TaskCompletionSource<NiceApprovalReadResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        NiceApprovalReader.Handler = _ => { entered.SetResult(); return completed.Task; };
        var read = mode == "connection" ? stale.CheckOnConnect()
            : mode == "manual" ? stale.ManualRefresh() : stale.ScheduledRefresh();
        await entered.Task;
        stale.Invalidate(invalidate);
        completed.SetResult(new(50, "PRIVATE-SCOPE", NiceApprovalReadState.Available, "PRIVATE-SOURCE-ID"));
        await read;
        Check(stale.Entries.Count == 0 && stale.PopupItems == 0 && stale.GateCount == 1 && !stale.Reading && !stale.HasReadCancellation,
            "A canceled, expired or stale result published an alert or leaked state: " + mode + "/" + invalidate);
        if (invalidate == "expiry") Check(stale.ApprovalStatus.Contains("재로그인") && stale.MenuCount is null, "Late result replaced expired-session status or count.");
        if (invalidate == "disconnect") Check(stale.ApprovalStatus.Contains("브라우저 연결 후") && stale.MenuCount is null, "Late result replaced disconnect status or count.");
    }

    foreach (var invalidate in new[] { "generation", "expiry", "disconnect", "cancel", "workflow" })
    {
        NiceApprovalReader.Reset();
        var queued = Form("queued-" + invalidate);
        queued.HoldGate();
        var waiting = queued.ManualRefresh();
        queued.Invalidate(invalidate);
        queued.ReleaseGate();
        await waiting;
        Check(NiceApprovalReader.Reads == 0 && queued.GateCount == 1 && !queued.Reading,
            $"Queued manual work failed to revalidate its connection or cancellation: {invalidate}; reads={NiceApprovalReader.Reads}, gate={queued.GateCount}, reading={queued.Reading}");
    }
    NiceApprovalReader.Reset();
    using (var cancellation = new CancellationTokenSource())
    {
        cancellation.Cancel();
        var canceled = Form("caller-cancel");
        var propagated = false;
        try { await canceled.CheckOnConnect(cancellation.Token); }
        catch (OperationCanceledException) { propagated = true; }
        Check(propagated && NiceApprovalReader.Reads == 0 && canceled.GateCount == 1 && !canceled.Reading,
            "Explicit connection cancellation was swallowed or leaked state.");
    }

    NiceApprovalReader.Reset();
    var preview = Form("preview");
    preview.StudentPreview = true;
    await preview.CheckOnConnect();
    NiceApprovalReader.Count = 99;
    await preview.ManualRefresh();
    Check(NiceApprovalReader.Reads == 2 && preview.PopupItems == 0 && preview.Entries.Count == 0,
        "Live Nice approvals contaminated the synthetic notification preview.");
    preview.StudentPreview = false;
    await preview.ManualRefresh();
    Check(preview.Entries.Count == 0, "Synthetic preview reads established a live count baseline.");
    NiceApprovalReader.Count = 100;
    await preview.ManualRefresh();
    Check(preview.Entries.Single().ItemCount == 1, "Leaving preview failed to establish an independent live baseline.");

    Console.WriteLine("PASS: one-minute schedule, busy retry, immediate connection, manual gate, independent baseline, failed reads, cancellation, stale connection, expired session, preview suppression");
}
finally
{
    var actual = Path.GetFullPath(probeRoot);
    if (Path.GetDirectoryName(actual) != Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()))
        || !Path.GetFileName(actual).StartsWith("oneclick-nice-approval-monitoring-data-", StringComparison.Ordinal))
        throw new Exception("Unsafe monitor test cleanup path.");
    Directory.Delete(actual, recursive: true);
}

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
    internal static class EducationOfficeCatalog { public static EducationOffice GetByCode(string code) => new(); }
    internal static class AppPreferences { public static string GetEducationOfficeCode() => "TEST"; }
    internal static class AppLogger
    {
        public static readonly List<string> Messages = [];
        public static void Info(string area, string message) => Messages.Add(area + ": " + message);
    }
    internal enum NiceApprovalReadState { Available, PageMissing, MultiplePages, ScopeUnavailable, Busy, QueryFailed, CountUnavailable }
    internal sealed record NiceApprovalReadResult(int? Count, string? Scope, NiceApprovalReadState State, string? SourceId = null);
    internal static class NiceApprovalReader
    {
        public static int Reads { get; private set; }
        public static int Count { get; set; }
        public static Func<CancellationToken, Task<NiceApprovalReadResult>>? Handler { get; set; }
        public static Task<NiceApprovalReadResult> ReadAsync(int port, EducationOffice office, CancellationToken token)
        {
            Reads++;
            return Handler?.Invoke(token) ?? Task.FromResult(new NiceApprovalReadResult(Count, "PRIVATE-SCOPE", NiceApprovalReadState.Available, "PRIVATE-SOURCE-ID"));
        }
        public static void Reset() { Reads = 0; Count = 4; Handler = null; }
    }
    internal sealed class PortalSessionExpiredException : Exception { }
    public sealed partial class MainForm
    {
        private bool _isClosing;
        private bool IsDisposed { get; set; }
        private bool Disposing { get; set; }
        private IntPtr _sourceWindow = new(99);
        private int? _devToolsPort = 9222;
        private int _connectionGeneration = 1;
        private bool _workflowRunning;
        private bool _studentNotificationPreview;
        private readonly SemaphoreSlim _portalOperationGate = new(1, 1);
        private readonly HashSet<string> _confirmedExpiredSystems = [];
        private readonly NotificationCenter _notificationCenter;
        private static readonly FieldInfo AttemptField = typeof(ApprovalPollingSchedule).GetField("_lastAttemptMilliseconds", BindingFlags.Instance | BindingFlags.NonPublic)!;
        public MainForm(string path) => _notificationCenter = new(path);
        internal IReadOnlyList<PortalNotification> Entries => _notificationCenter.Entries;
        internal int PopupItems { get; private set; }
        internal int? MenuCount { get; private set; }
        internal int TimerInterval => _niceApprovalTimer.Interval;
        internal bool TimerEnabled => _niceApprovalTimer.Enabled;
        internal bool Reading => _niceApprovalReading;
        internal bool HasReadCancellation => _niceApprovalCancellationSource is not null;
        internal int GateCount => _portalOperationGate.CurrentCount;
        internal string ApprovalStatus => _niceApprovalStatus;
        internal string ConnectionStatus { get; private set; } = "";
        internal long? LastAttempt => (long?)AttemptField.GetValue(_niceApprovalPolling);
        internal bool IsDueAt(long now) => _niceApprovalPolling.IsDue(now, edufineActive: false);
        internal void MakeDue() => AttemptField.SetValue(_niceApprovalPolling, Environment.TickCount64 - 60_001);
        internal bool WorkflowRunning { set => _workflowRunning = value; }
        internal bool StudentPreview { set => _studentNotificationPreview = value; }
        internal void UpdateMonitoring() => UpdateNiceApprovalMonitoring();
        internal Task CheckOnConnect(CancellationToken token = default) => CheckNiceApprovalsOnConnectAsync(token);
        internal Task ScheduledRefresh() => RefreshScheduledNiceApprovalsAsync();
        internal Task ManualRefresh() => RefreshNiceApprovalsAsync();
        internal void HoldGate() => _portalOperationGate.Wait();
        internal void ReleaseGate() => _portalOperationGate.Release();
        internal void EstablishEdufineBaseline(int count) => _notificationCenter.ObserveCount(NotificationKind.Approval, count, "PRIVATE-SCOPE");
        internal IReadOnlyList<PortalNotification> ObserveEdufine(int count) => _notificationCenter.ObserveCount(NotificationKind.Approval, count, "PRIVATE-SCOPE");
        internal void ExpireNice() { _confirmedExpiredSystems.Add("나이스"); CancelNiceApprovalReadForExpiredSession(); }
        internal void Disconnect() { _connectionGeneration++; _sourceWindow = IntPtr.Zero; _devToolsPort = null; StopNiceApprovalMonitoring(); }
        internal void Invalidate(string mode)
        {
            switch (mode)
            {
                case "generation": _connectionGeneration++; break;
                case "port": _devToolsPort++; break;
                case "window": _sourceWindow = new(100); break;
                case "expiry": ExpireNice(); break;
                case "disconnect": Disconnect(); break;
                case "cancel": _niceApprovalCancellationSource?.Cancel(); break;
                case "closing": _isClosing = true; break;
                case "disposed": IsDisposed = true; break;
                case "disposing": Disposing = true; break;
                case "workflow": _workflowRunning = true; break;
                default: throw new InvalidOperationException(mode);
            }
        }
        private void SetConnectionStatus(string status) => ConnectionStatus = status;
        private void RefreshNotificationSourceStatus() { }
        private void SetNiceApprovalMenuCount(int? count) => MenuCount = count;
        private void ShowNewNotificationPopup(IReadOnlyList<PortalNotification> added) => PopupItems += added.Count;
    }
}
`;
