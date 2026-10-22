import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const [simulation, notifications, program, form] = await Promise.all([
  'MainForm.NotificationSimulation.cs', 'MainForm.Notifications.cs', 'Program.cs', 'NotificationCenterForm.cs',
].map(name => readFile(resolve(root, name), 'utf8')));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('explicit student preview uses the guarded preview branch before installation services', () => {
  const preview = program.slice(program.indexOf('var studentNotificationPreview'), program.indexOf('VelopackApp.Build()'));
  assert.match(preview, /args\.Contains\("--student-notification-preview", StringComparer\.OrdinalIgnoreCase\)/);
  assert.match(preview, /if \(updatePreview \|\| notificationPreview \|\| studentNotificationPreview/);
  assert.match(preview, /PreviewInstanceGuard\.TryAcquire/);
  assert.match(preview, /new MainForm\(closeToTray: false, studentNotificationPreview: studentNotificationPreview\)/);
  assert.match(preview, /Application\.Run\(preview\);\s*return;/);
  assert.doesNotMatch(preview, /UsageTelemetry|ApplyWindowsStartupPreference|UriSchemeRegistrar|CheckForUpdatesAsync/);
});

test('simulation UI is explicit and stays present when another window gets focus', () => {
  assert.match(form, /Text = isSimulation \? "모의 알림 테스트" : "알림"/);
  assert.match(form, /Text = _isSimulation \? "모의 알림" : "알림"/);
  assert.match(form, /"모의 알림 · 클릭하면 실제 나이스 조회"/);
  const deactivate = notifications.split('dialog.Deactivate +=')[1].split('dialog.FormClosed +=')[0];
  assert.ok(deactivate.indexOf('if (_studentNotificationPreview) return;') < deactivate.indexOf('dialog.Close();'));
  assert.match(notifications, /TopMost = _studentNotificationPreview \|\| TopMost/);
  assert.match(notifications, /if \(_studentNotificationPreview\)\s*\{\s*dialog\.BringToFront\(\);\s*dialog\.Activate\(\);\s*NativeMethods\.SetForegroundWindow\(dialog.Handle\);/);
});

test('three real navigation dispatches are behind connection and session checks', () => {
  const handler = notifications.split('dialog.OpenRequested += kind =>')[1].split('dialog.Deactivate +=')[0];
  assert.ok(handler.indexOf('if (!CanOpenNotificationSource(kind)) return;') < handler.indexOf('dialog.Close();'));
  assert.ok(handler.indexOf('dialog.Close();') < handler.indexOf('RunWorkflowAsync'));
  for (const [kind, task] of [
    ['FieldTrip', 'FieldTripApplicationManagement'], ['Absence', 'AbsenceReportManagement'], ['FieldTripReport', 'FieldTripReportManagement'],
  ]) assert.match(handler, new RegExp(`kind == NotificationKind\\.${kind}\\) _ = RunWorkflowAsync\\(PortalTaskKind\\.${task}\\)`));
});

test('automatic preview connection requires a unique official HTTPS page and matching existing browser window', () => {
  const connection = simulation.split('private async Task TryConnectStudentNotificationPreviewAsync()')[1];
  assert.match(connection, /target\.Type == "page"/);
  assert.match(connection, /uri\.Scheme == Uri\.UriSchemeHttps/);
  assert.match(connection, /string\.Equals\(uri\.Host, office\.NiceDomain, StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(connection, /\) != 1\) return;/);
  assert.match(connection, /string\.Equals\(window\.ProcessName, BrowserSupport.GetProcessName\(browser\), StringComparison\.OrdinalIgnoreCase\)/);
  assert.match(connection, /IsWindowOwnedBy\(window.Handle, owner.Value\)/);
  assert.match(connection, /InspectPortalPortsAsync\(office, browser, cancellation.Token\)/);
  assert.match(connection, /if \(candidates\.Length != 1\) return;/);
  assert.match(connection, /await ConnectSelectedBrowserAsync\(\)/);
  assert.doesNotMatch(connection.replace(/\/\/[^\n]*/g, ''),
    /LaunchControlledEdge|CreateTarget|Process\.Start|LoginAsync|certificate|password|btnApproval|btnSubmit/);
});

test('actual WinForms notification list and production seed/store/gate code handle all three preview kinds',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-student-preview-test-'));
    try {
      const createStore = simulation.slice(simulation.indexOf('private static NotificationCenter CreateNotificationCenter('),
        simulation.indexOf('private void InitializeStudentNotificationPreview()'));
      const seed = simulation.slice(simulation.indexOf('const string scope = "student-notification-preview";'),
        simulation.indexOf('SetStatus(IsBrowserConnected()'));
      const gate = notifications.slice(notifications.indexOf('private bool CanOpenNotificationSource('),
        notifications.indexOf('internal void ShowNotificationCenter()'));
      assert.ok(createStore.includes('Path.GetTempPath()') && createStore.includes('Guid.NewGuid()'));
      assert.ok(createStore.includes('"notifications.json" : "notifications-preview.json"'));
      assert.ok(seed.includes('ObservePendingFieldTripReports'));
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'NotificationCenter.cs'))}" Link="NotificationCenter.cs" />
          <Compile Include="${xml(resolve(root, 'NotificationCenterForm.cs'))}" Link="NotificationCenterForm.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe
        .replace('/* PRODUCTION_STORE */', createStore)
        .replace('/* PRODUCTION_SEED */', seed)
        .replace('/* PRODUCTION_GATE */', gate));
      const result = await run('dotnet', ['run', '--project', project, '--configuration', 'Release', '--nologo'],
        { timeout: 100_000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /PASS: isolated stores, exact three seeds, repeat quiet, actual form labels, clicks, session gates, no real history mutation/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-student-preview-test-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Reflection;
using System.Security.Cryptography;

internal static class Program
{
    private static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
    private static IEnumerable<Control> Descendants(Control parent)
    {
        foreach (Control child in parent.Controls)
        {
            yield return child;
            foreach (var descendant in Descendants(child)) yield return descendant;
        }
    }

    [STAThread]
    private static void Main()
    {
        var realStore = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OneClickPortal", "notifications.json");
        var normalPreviewStore = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OneClickPortal", "notifications-preview.json");
        string? Digest(string path) => File.Exists(path) ? Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(path))) : null;
        var before = new[] { Digest(realStore), Digest(normalPreviewStore) };
        var directories = new List<string>();
        try
        {
            var center = MainFormProbe.CreatePreview();
            var second = MainFormProbe.CreatePreview();
            var storeField = typeof(NotificationCenter).GetField("storagePath", BindingFlags.Instance | BindingFlags.NonPublic)!;
            var paths = new[] { (string)storeField.GetValue(center)!, (string)storeField.GetValue(second)! };
            Check(paths.Distinct(StringComparer.OrdinalIgnoreCase).Count() == 2, "Preview runs shared a history.");
            foreach (var path in paths)
            {
                var directory = Path.GetDirectoryName(path)!;
                Check(Path.GetDirectoryName(directory) == Path.Combine(Path.GetTempPath(), "OneClickPortal"), "Store escaped the preview temp parent.");
                Check(Path.GetFileName(directory).StartsWith("student-notification-preview-", StringComparison.Ordinal), "Store is not explicitly a simulation.");
                Check(!string.Equals(path, realStore, StringComparison.OrdinalIgnoreCase) && !string.Equals(path, normalPreviewStore, StringComparison.OrdinalIgnoreCase), "Preview reused user history.");
                directories.Add(directory);
            }
            var harness = new MainFormProbe(center);
            harness.Seed();
            var kinds = new[] { NotificationKind.FieldTrip, NotificationKind.Absence, NotificationKind.FieldTripReport };
            Check(center.Entries.Count == 3 && center.UnreadCount == 3, "Preview did not create exactly three unread entries.");
            Check(center.Entries.Select(e => e.Kind).Order().SequenceEqual(kinds.Order()), "Wrong preview kinds.");
            Check(center.Entries.All(e => e.ItemCount == 1), "A preview kind has the wrong count.");
            harness.Seed();
            Check(center.Entries.Count == 3 && center.UnreadCount == 3, "Repeated preview seed duplicated an entry.");
            Check(new NotificationCenter(paths[0]).Entries.Count == 3 && second.Entries.Count == 0, "Preview history leaked between runs.");

            harness.Connected = true;
            Check(kinds.All(harness.CanOpen), "Healthy Nice does not allow all three preview kinds.");
            harness.Expired.Add("K-에듀파인");
            Check(kinds.All(harness.CanOpen), "Edufine expiry incorrectly blocks Nice entries.");
            Check(!harness.CanOpen(NotificationKind.Approval), "Expired Edufine still opens approval.");
            harness.Expired.Add("나이스");
            Check(kinds.All(kind => !harness.CanOpen(kind)), "Expired Nice still opens a student entry.");
            harness.Expired.Clear();
            harness.Workflow = true;
            Check(kinds.All(kind => !harness.CanOpen(kind)), "Another workflow did not block opening.");
            harness.Workflow = false;
            harness.Connected = false;
            Check(kinds.All(kind => !harness.CanOpen(kind)), "Disconnected entries still open.");
            harness.Connected = true;

            using var dialog = new NotificationCenterForm(center, harness.CanOpen, isSimulation: true);
            // Create the real list handle so Changed refreshes entries during clicks,
            // while keeping the test window hidden and avoiding user focus changes.
            _ = dialog.Handle;
            var controls = Descendants(dialog).ToArray();
            Check(dialog.Text == "모의 알림 테스트", "Simulation window title is unclear.");
            Check(controls.OfType<Label>().Any(label => label.Text == "모의 알림"), "Simulation header missing.");
            Check(controls.OfType<Label>().Any(label => label.Text == "모의 알림 · 클릭하면 실제 나이스 조회"), "Simulation footer missing.");
            var list = controls.OfType<ListBox>().Single();
            Check(list.Items.Count == 3, "Actual form did not render three entries.");
            var labels = list.Items.Cast<object>().Select(item => item.ToString()!).ToArray();
            Check(labels.Any(s => s.Contains("교외체험학습 신청 1건")), "Application summary missing.");
            Check(labels.Any(s => s.Contains("결석신고서 제출 1건")), "Absence summary missing.");
            Check(labels.Any(s => s.Contains("교외체험학습 보고서 미상신 1건")), "Report summary missing.");
            var opened = new List<NotificationKind>();
            dialog.OpenRequested += kind => opened.Add(kind);
            var open = typeof(NotificationCenterForm).GetMethod("OpenEntry", BindingFlags.Instance | BindingFlags.NonPublic)!;
            for (var index = 0; index < 3; index++) open.Invoke(dialog, [index]);
            Check(opened.Order().SequenceEqual(kinds.Order()) && center.UnreadCount == 0, "Actual click did not dispatch every kind and acknowledge it.");
            Check(list.Items.Count == 3, "Acknowledging an entry removed later test choices.");
            open.Invoke(dialog, [0]);
            Check(opened.Count == 4 && center.Entries.Count == 3, "Read entries cannot be reopened or duplicated history.");
            harness.Connected = false;
            open.Invoke(dialog, [1]);
            Check(opened.Count == 4, "Disconnected actual form fired navigation.");
            open.Invoke(dialog, [-1]);
            open.Invoke(dialog, [3]);
            Check(opened.Count == 4, "Invalid list index fired navigation.");
            harness.Seed();
            Check(center.Entries.Count == 3 && center.UnreadCount == 0, "Reading then reseeding created another alert.");
            Check(Digest(realStore) == before[0] && Digest(normalPreviewStore) == before[1], "Simulation modified real or ordinary preview history.");
            Console.WriteLine("PASS: isolated stores, exact three seeds, repeat quiet, actual form labels, clicks, session gates, no real history mutation");
        }
        finally
        {
            foreach (var directory in directories)
            {
                var actual = Path.GetFullPath(directory);
                Check(Path.GetDirectoryName(actual) == Path.Combine(Path.GetTempPath(), "OneClickPortal")
                    && Path.GetFileName(actual).StartsWith("student-notification-preview-", StringComparison.Ordinal), "Unsafe preview cleanup.");
                if (Directory.Exists(actual)) Directory.Delete(actual, recursive: true);
            }
        }
    }
}

namespace BrowserThumbnailPrototype
{
    // Execute the production store factory, seeding body and eligibility method
    // unchanged. Browser connection is deliberately absent from this offline probe.
    internal sealed class MainFormProbe
    {
        private readonly NotificationCenter _notificationCenter;
        private readonly HashSet<string> _confirmedExpiredSystems = new(StringComparer.Ordinal);
        private bool _workflowRunning;
        public bool Connected;
        public bool Workflow { set => _workflowRunning = value; }
        public HashSet<string> Expired => _confirmedExpiredSystems;
        public MainFormProbe(NotificationCenter center) => _notificationCenter = center;
        private bool IsBrowserConnected() => Connected;
        public bool CanOpen(NotificationKind kind) => CanOpenNotificationSource(kind);
        public static NotificationCenter CreatePreview() => CreateNotificationCenter(false, true);
        public void Seed() { /* PRODUCTION_SEED */ }
        /* PRODUCTION_STORE */
        /* PRODUCTION_GATE */
    }
    internal static class AppLogger { public static void Info(string area, string message) { } }
}
`;
