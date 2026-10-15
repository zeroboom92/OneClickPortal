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

test('pending field-trip reports alert initially and retain private deduplication across restarts',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-pending-reports-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root, 'NotificationCenter.cs'))}" Link="NotificationCenter.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: pending reports, first query, restart, history independence, invalid snapshots, scopes, privacy, legacy store, storage failures/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-pending-reports-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Text.Json;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
var probeRoot = Path.Combine(Path.GetTempPath(), "oneclick-pending-report-data-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(probeRoot);
try
{
    var now = new DateTimeOffset(2026, 10, 15, 12, 0, 0, TimeSpan.FromHours(9));
    string Store(string name) => Path.Combine(probeRoot, name + ".json");
    const string scope = "office-secret/account-secret/school-secret/class-secret";
    var a = new NotificationSourceItem("REPORT-SECRET-A", "학생이름과 보고서 본문 비밀 A");
    var b = new NotificationSourceItem("REPORT-SECRET-B", "학생이름과 보고서 본문 비밀 B");
    var c = new NotificationSourceItem("REPORT-SECRET-C", "학생이름과 보고서 본문 비밀 C");
    var center = new NotificationCenter(Store("pending"));
    var changes = 0;
    center.Changed += (_, _) => changes++;
    Check((int)NotificationKind.Approval == 0 && (int)NotificationKind.FieldTrip == 1
        && (int)NotificationKind.Absence == 2 && (int)NotificationKind.FieldTripReport == 3,
        "Existing notification kind numbers changed.");
    Check(center.ObservePendingFieldTripReports(null, scope, now).Count == 0, "Null snapshot accepted.");
    Check(center.ObservePendingFieldTripReports([a, new(" ", "")], scope, now).Count == 0,
        "Partial invalid initial snapshot accepted.");
    Check(!File.Exists(Store("pending")) && changes == 0, "Invalid snapshot changed history or disk.");
    var first = center.ObservePendingFieldTripReports([a, a], scope, now).Single();
    Check(first.Kind == NotificationKind.FieldTripReport && first.ItemCount == 1 && !first.IsRead
        && first.Title.Contains("보고서") && first.Message.Contains("미상신") && !first.Message.Contains("제출되었습니다"),
        "Initial pending report did not create the correct notification.");
    Check(changes == 1 && center.UnreadCount == 1, "Initial alert did not publish history change.");
    var firstStore = File.ReadAllText(Store("pending"));
    foreach (var secret in new[] { a.Id, a.Summary, scope, "account-secret", "class-secret", "school-secret" })
        Check(!firstStore.Contains(secret, StringComparison.Ordinal), "Raw source information persisted.");
    Check(!first.Title.Contains(a.Summary) && !first.Message.Contains(a.Summary), "Source summary reached an alert.");
    using (var json = JsonDocument.Parse(firstStore))
    {
        var saved = json.RootElement;
        Check(saved.GetProperty("Version").GetInt32() == 1, "Store version broke v1 compatibility.");
        var keys = saved.GetProperty("NotifiedFieldTripReportFingerprints");
        Check(keys.GetArrayLength() == 1 && keys[0].GetString() == first.SourceKey
            && first.SourceKey!.Length == 64, "Deduplication key was not persisted separately.");
        Check(!saved.GetProperty("Entries")[0].TryGetProperty("SourceKey", out _),
            "A source key was added to visible notification entries.");
    }
    Check(center.ObservePendingFieldTripReports([a], scope, now).Count == 0 && changes == 1,
        "Repeated query notified again.");
    var beforeInvalid = File.ReadAllText(Store("pending"));
    foreach (var invalid in new IReadOnlyList<NotificationSourceItem>?[]
        { null, [b, null!], [b, new("", "")], [b, new(new string('x', 2049), "")] })
        Check(center.ObservePendingFieldTripReports(invalid, scope, now).Count == 0,
            "An invalid complete-list candidate was accepted.");
    Check(center.ObservePendingFieldTripReports([b], " ", now).Count == 0
        && center.ObservePendingFieldTripReports([b], null!, now).Count == 0
        && center.ObservePendingFieldTripReports([b], new string('x', 2049), now).Count == 0,
        "An invalid report scope was accepted.");
    Check(changes == 1 && File.ReadAllText(Store("pending")) == beforeInvalid,
        "Failed snapshots changed deduplication or disk.");
    Check(center.ObservePendingFieldTripReports([b], scope, now.AddMinutes(1)).Count == 1,
        "Same-count replacement was lost or invalid snapshot remembered its valid prefix.");
    Check(center.ObservePendingFieldTripReports([], scope, now).Count == 0
        && center.ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
        "Returning pending reports notified again.");
    center.ResetObservations();
    Check(center.ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
        "ResetObservations discarded persistent report keys.");
    var restarted = new NotificationCenter(Store("pending"));
    Check(restarted.Entries.Count == 2 && restarted.ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
        "Restart repeated existing report notifications.");
    Check(restarted.ObservePendingFieldTripReports([c], scope, now.AddMinutes(2)).Count == 1,
        "New report after restart was lost.");
    restarted.MarkAllRead();
    restarted.ClearRead();
    Check(restarted.Entries.Count == 0 && restarted.UnreadCount == 0, "History clearing failed.");
    restarted = new NotificationCenter(Store("pending"));
    Check(restarted.Entries.Count == 0 && restarted.ObservePendingFieldTripReports([a, b, c], scope, now).Count == 0,
        "Cleared visible history discarded report keys.");
    Check(restarted.ObservePendingFieldTripReports([a], scope + "/different-class", now).Count == 1,
        "Different class shared a deduplication scope.");
    Check(restarted.ObservePendingFieldTripReports([a], "office-secret/other-account/school-secret/class-secret", now).Count == 1,
        "Different account shared a deduplication scope.");
    Check(restarted.ObservePendingFieldTripReports([a], "other-office/account-secret/school-secret/class-secret", now).Count == 1,
        "Different office shared a deduplication scope.");

    var history = new NotificationCenter(Store("bounded"));
    var many = Enumerable.Range(0, 1005).Select(index => new NotificationSourceItem("report-" + index, "")).ToArray();
    Check(history.ObservePendingFieldTripReports(many, scope, now).Count == many.Length,
        "Large initial pending list did not alert all distinct reports.");
    Check(history.Entries.Count == NotificationCenter.MaximumEntries, "Visible history exceeded its 300-entry limit.");
    history.ObservePendingFieldTripReports([], scope, now);
    history.ResetObservations();
    history = new NotificationCenter(Store("bounded"));
    Check(history.ObservePendingFieldTripReports(many, scope, now).Count == 0,
        "History trimming or remembered-item eviction discarded permanent report keys.");
    history.MarkAllRead();
    history.ClearRead();
    history = new NotificationCenter(Store("bounded"));
    Check(history.ObservePendingFieldTripReports([many[0], many[^1]], scope, now).Count == 0,
        "Deleting all history repeated old reports after restart.");

    var legacyId = Guid.NewGuid().ToString("N");
    File.WriteAllText(Store("legacy"), JsonSerializer.Serialize(new
    {
        Version = 1,
        Entries = new[] { new { Id = legacyId, Kind = 0, CreatedAt = now, IsRead = true, ItemCount = 2 } }
    }));
    var legacy = new NotificationCenter(Store("legacy"));
    Check(legacy.Entries.Single().Id == legacyId && legacy.Entries.Single().IsRead,
        "v1 history without report keys did not load.");
    Check(legacy.ObservePendingFieldTripReports([a], scope, now).Count == 1,
        "Legacy history prevented first report alert.");
    legacy = new NotificationCenter(Store("legacy"));
    Check(legacy.Entries.Count == 2 && legacy.ObservePendingFieldTripReports([a], scope, now).Count == 0,
        "Upgraded v1 store lost history or report deduplication.");

    var malformedIndex = 0;
    foreach (var malformedKeys in new object?[]
        { new[] { "raw-report-id" }, new[] { new string('G', 64) }, new[] { new string('a', 64) },
          new string?[] { null }, new[] { new string('A', 64), new string('A', 64) }, "not-a-list" })
    {
        var path = Store("malformed-" + malformedIndex++);
        File.WriteAllText(path, JsonSerializer.Serialize(new
            { Version = 1, Entries = Array.Empty<object>(), NotifiedFieldTripReportFingerprints = malformedKeys }));
        var malformed = new NotificationCenter(path);
        Check(malformed.Entries.Count == 0 && malformed.ObservePendingFieldTripReports([a], scope, now).Count == 1,
            "Malformed fingerprints poisoned later report collection.");
        Check(!File.ReadAllText(path).Contains("raw-report-id"), "Malformed original source key survived recovery.");
    }

    var atomicPath = Store("atomic");
    var atomic = new NotificationCenter(atomicPath);
    atomic.ObservePendingFieldTripReports([a], scope, now);
    var original = File.ReadAllText(atomicPath);
    using (var locked = new FileStream(atomicPath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(atomic.ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
            "A report notification was published before its deduplication key was durable.");
    Check(atomic.HasPersistenceError && atomic.Entries.Count == 1 && File.ReadAllText(atomicPath) == original,
        "Write failure was not surfaced or changed visible/prior history.");
    Check(!Directory.EnumerateFiles(probeRoot, "*.tmp").Any(), "Failed write leaked temporary files.");
    var immediateRestart = new NotificationCenter(atomicPath);
    Check(immediateRestart.ObservePendingFieldTripReports([a, b], scope, now).Count == 1,
        "Restart immediately after a failed write lost the never-published report alert.");
    Check(new NotificationCenter(atomicPath).ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
        "Report alerted again after the first durable notification following restart.");

    var retryPath = Store("retry");
    var retry = new NotificationCenter(retryPath);
    retry.ObservePendingFieldTripReports([a], scope, now);
    using (var locked = new FileStream(retryPath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(retry.ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
            "Failed write published the retry report prematurely.");
    Check(retry.ObservePendingFieldTripReports([a, b], scope, now).Count == 1 && !retry.HasPersistenceError,
        "Requery failed to publish the report after persistence recovered.");
    Check(retry.ObservePendingFieldTripReports([a, b], scope, now).Count == 0
        && new NotificationCenter(retryPath).ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
        "Successful persistence retry repeated a report alert.");

    var rollbackPath = Store("full-history-rollback");
    var rollback = new NotificationCenter(rollbackPath);
    rollback.ObservePendingFieldTripReports(many.Take(NotificationCenter.MaximumEntries).ToArray(), scope, now);
    var beforeRollback = rollback.Entries.Select(entry => entry.Id).ToArray();
    using (var locked = new FileStream(rollbackPath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(rollback.ObservePendingFieldTripReports([a], scope, now.AddMinutes(1)).Count == 0,
            "Full-history write failure published a report alert.");
    Check(rollback.Entries.Select(entry => entry.Id).SequenceEqual(beforeRollback),
        "Report write rollback failed to restore an older alert trimmed by the 300-entry limit.");
    Check(rollback.ObservePendingFieldTripReports([a], scope, now.AddMinutes(1)).Count == 1,
        "Full-history write rollback remembered the report before it was durable.");
    var protectedHistory = File.ReadAllText(atomicPath);
    NotificationCenter unreadable;
    using (var locked = new FileStream(atomicPath, FileMode.Open, FileAccess.Read, FileShare.None))
    {
        unreadable = new NotificationCenter(atomicPath);
        Check(unreadable.HasPersistenceError && unreadable.ObservePendingFieldTripReports([a, c], scope, now).Count == 0,
            "Unreadable deduplication history repeated possibly known reports.");
    }
    Check(unreadable.ObservePendingFieldTripReports([c], scope, now).Count == 0
        && File.ReadAllText(atomicPath) == protectedHistory,
        "Unreadable initial history was replaced after its file lock disappeared.");
    Check(new NotificationCenter(atomicPath).ObservePendingFieldTripReports([a, b, c], scope, now).Count == 1,
        "Restart did not recover preserved deduplication history.");

    var capacityPath = Store("capacity");
    var capacity = new NotificationCenter(capacityPath);
    var capacityA = capacity.ObservePendingFieldTripReports([a], scope, now).Single().SourceKey!;
    var capacityOriginal = File.ReadAllText(capacityPath);
    var capacityKeys = (HashSet<string>)typeof(NotificationCenter)
        .GetField("notifiedFieldTripReports", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
        .GetValue(capacity)!;
    // Exercise the real atomic writer at its byte limit without generating thousands of alerts.
    for (var index = 0; index < 260_000; index++) capacityKeys.Add(index.ToString("X64"));
    Check(capacity.ObservePendingFieldTripReports([b], scope, now).Count == 0,
        "Capacity failure published a report before its deduplication key was durable.");
    Check(capacity.HasPersistenceError && capacity.Entries.Count == 1
        && File.ReadAllText(capacityPath) == capacityOriginal,
        "Exceeding the store byte limit replaced visible or previous valid history.");
    Check(!Directory.EnumerateFiles(probeRoot, "*.tmp").Any(), "Capacity failure leaked a temporary file.");
    capacityKeys.RemoveWhere(key => key != capacityA);
    Check(capacity.ObservePendingFieldTripReports([a, b], scope, now).Count == 1 && !capacity.HasPersistenceError,
        "Capacity recovery failed to publish the previously deferred report.");
    Check(new NotificationCenter(capacityPath).ObservePendingFieldTripReports([a, b], scope, now).Count == 0,
        "Capacity recovery lost pending-report deduplication after restart.");
    Check(AppLogger.Messages.All(message => !message.Contains("raw-report-id") && !message.Contains(a.Id)
        && !message.Contains(a.Summary) && !message.Contains(scope)), "Report source information leaked to logs.");

    Console.WriteLine("PASS: pending reports, first query, restart, history independence, invalid snapshots, scopes, privacy, legacy store, storage failures");
}
finally
{
    var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
    if (!Path.GetFullPath(probeRoot).StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(probeRoot).StartsWith("oneclick-pending-report-data-", StringComparison.Ordinal))
        throw new Exception("Probe cleanup path is outside the temporary test directory.");
    Directory.Delete(probeRoot, recursive: true);
}

namespace BrowserThumbnailPrototype
{
    internal static class AppLogger
    {
        public static List<string> Messages { get; } = [];
        public static void Info(string area, string message) => Messages.Add(message);
    }
}
`;
