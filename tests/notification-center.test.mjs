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

test('actual notification engine handles baselines, deduplication, scopes, history and safe persistence',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-notifications-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root, 'NotificationCenter.cs'))}" Link="NotificationCenter.cs" />
          <Compile Include="${xml(resolve(root, 'AppRelease.cs'))}" Link="AppRelease.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: baselines, counts, stable IDs, invalid input, scopes, read history, restart, corruption, storage failure, privacy, bounds/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-notifications-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Text.Json;
using System.Text.Json.Nodes;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
var probeRoot = Path.Combine(Path.GetTempPath(), "oneclick-notification-data-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(probeRoot);
try
{
    var now = new DateTimeOffset(2026, 10, 13, 10, 0, 0, TimeSpan.FromHours(9));
    string Store(string name) => Path.Combine(probeRoot, name + ".json");
    var center = new NotificationCenter(Store("counts"));
    var changes = 0;
    center.Changed += (_, _) => changes++;
    Check(center.Entries.Count == 0 && center.UnreadCount == 0 && !center.HasPersistenceError, "New history is not empty or reports a storage error.");
    Check(center.ObserveCount(NotificationKind.Approval, 8, "office-A", now).Count == 0, "First count alerted existing documents.");
    Check(center.ObserveCount(NotificationKind.Approval, 8, "office-A", now).Count == 0, "Unchanged count alerted.");
    Check(changes == 0, "Baseline-only observation fired a history event.");
    var first = center.ObserveCount(NotificationKind.Approval, 10, "office-A", now).Single();
    Check(first.ItemCount == 2 && first.Message.Contains("2건") && !first.IsRead, "Count increase was not aggregated.");
    Check(center.ObserveCount(NotificationKind.Approval, -1, "office-A", now).Count == 0, "Negative count accepted.");
    Check(center.ObserveCount(NotificationKind.Approval, 11, "office-A", now).Single().ItemCount == 3, "Invalid count changed baseline or unread total.");
    Check(center.ObserveCount(NotificationKind.Approval, 4, "office-A", now).Count == 0, "Count decrease notified.");
    Check(center.ObserveCount(NotificationKind.Approval, 5, "office-A", now).Single().ItemCount == 4, "Decrease failed to update baseline or unread total.");
    Check(center.ObserveCount(NotificationKind.Approval, 50, "office-B", now).Count == 0, "Different scope reused a baseline.");
    Check(center.ObserveCount(NotificationKind.Approval, 51, "office-B", now).Single().ItemCount == 5, "Different scope failed to monitor or merged baselines.");
    Check(center.ObserveCount(NotificationKind.Absence, 10, "office-A", now).Count == 0, "Different kind reused a baseline.");
    Check(center.ObserveCount((NotificationKind)999, 1, "office-A", now).Count == 0, "Invalid kind accepted.");
    Check(center.ObserveCount(NotificationKind.Approval, 50, null!, now).Count == 0, "Null scope accepted.");
    Check(center.ObserveCount(NotificationKind.Approval, 50, " ", now).Count == 0, "Whitespace scope accepted.");
    Check(changes == 4 && center.UnreadCount == 1 && center.Entries.Single().Id == first.Id,
        "Count increases must update one unread system summary and publish one event per increase.");

    var items = new NotificationCenter(Store("items"));
    var a = new NotificationSourceItem("STUDENT-SECRET-ID-A", "학생이름과 문서내용을 저장하면 안 됩니다");
    var b = new NotificationSourceItem("STUDENT-SECRET-ID-B", "AUTH-SECRET-NOT-FOR-DISK");
    const string sensitiveScope = "SCHOOL-SECRET-SCOPE";
    Check(items.ObserveItems(NotificationKind.FieldTrip, [a], sensitiveScope, now).Count == 0, "First items alerted.");
    Check(items.ObserveItems(NotificationKind.FieldTrip, null, sensitiveScope, now).Count == 0, "Null snapshot accepted.");
    Check(items.ObserveItems(NotificationKind.FieldTrip, [a, null!], sensitiveScope, now).Count == 0, "Null row accepted.");
    Check(items.ObserveItems(NotificationKind.FieldTrip, [a, new("", "")], sensitiveScope, now).Count == 0, "Invalid ID accepted.");
    var itemAlert = items.ObserveItems(NotificationKind.FieldTrip, [a, b, b], sensitiveScope, now).Single();
    Check(itemAlert.Kind == NotificationKind.FieldTrip && itemAlert.SourceKey is not null, "Stable item missing its in-memory key.");
    Check(!itemAlert.Message.Contains(b.Summary) && !itemAlert.Title.Contains(a.Summary), "Source content leaked to user notification.");
    Check(items.ObserveItems(NotificationKind.FieldTrip, [b], sensitiveScope, now).Count == 0, "Disappearing item alerted.");
    Check(items.ObserveItems(NotificationKind.FieldTrip, [], sensitiveScope, now).Count == 0, "Empty snapshot alerted.");
    Check(items.ObserveItems(NotificationKind.FieldTrip, [a, b], sensitiveScope, now).Count == 0, "Returning seen ID alerted again.");
    Check(items.ObserveItems(NotificationKind.FieldTrip, [a, b], "another-scope", now).Count == 0, "Source item scope baseline was shared.");
    Check(items.ObserveItems(NotificationKind.Absence, [], sensitiveScope, now).Count == 0, "Empty initial snapshot not accepted.");
    Check(items.ObserveItems(NotificationKind.Absence, [a], sensitiveScope, now.AddMinutes(1)).Count == 1, "New item after empty baseline was lost.");
    Check(items.Entries[0].Kind == NotificationKind.Absence, "Entries are not newest first.");
    var initialInvalid = new NotificationCenter(Store("invalid-first"));
    Check(initialInvalid.ObserveItems(NotificationKind.Absence, [new("bad", ""), new(" ", "")], "scope", now).Count == 0, "Invalid initial list alerted.");
    Check(initialInvalid.ObserveItems(NotificationKind.Absence, [new("bad", ""), new("good", "")], "scope", now).Count == 0, "Partial invalid list established a baseline.");

    var savedText = File.ReadAllText(Store("items"));
    foreach (var secret in new[] { a.Id, b.Id, a.Summary, b.Summary, sensitiveScope, itemAlert.SourceKey! })
        Check(!savedText.Contains(secret, StringComparison.Ordinal), "Source information was persisted.");
    using (var json = JsonDocument.Parse(savedText))
    {
        var storedEntry = json.RootElement.GetProperty("Entries")[0];
        Check(!storedEntry.TryGetProperty("SourceKey", out _) && !storedEntry.TryGetProperty("Summary", out _), "Sensitive fields included in store schema.");
    }

    var snapshot = center.Entries;
    center.MarkRead(first.Id);
    Check(center.UnreadCount == 0 && center.Entries.Single(entry => entry.Id == first.Id).IsRead, "MarkRead failed.");
    Check(!snapshot.Single(entry => entry.Id == first.Id).IsRead, "Entries exposes mutable history.");
    Check(changes == 5, "MarkRead failed to notify.");
    center.MarkRead(first.Id);
    center.MarkRead("unknown");
    Check(changes == 5, "No-op read fired an event.");
    var restarted = new NotificationCenter(Store("counts"));
    Check(restarted.Entries.Count == 1 && restarted.UnreadCount == 0, "Saved read state did not reload.");
    Check(restarted.ObserveCount(NotificationKind.Approval, 100, "office-A", now).Count == 0, "Restart restored an observation baseline.");
    Check(restarted.ObserveCount(NotificationKind.Approval, 101, "office-A", now).Count == 1, "Restart failed to observe subsequent increases.");
    var restartedItems = new NotificationCenter(Store("items"));
    Check(restartedItems.Entries.Count == 2 && restartedItems.Entries.All(entry => entry.SourceKey is null), "Item history reload failed or source keys persisted.");
    Check(restartedItems.ObserveItems(NotificationKind.FieldTrip, [a, b, new("new", "")], sensitiveScope, now).Count == 0, "Restart item list alerted old items.");
    center.ClearRead();
    Check(center.Entries.Count == 0 && center.UnreadCount == 0, "ClearRead did not remove the read summary.");
    Check(center.ObserveCount(NotificationKind.Approval, 52, "office-B", now.AddMinutes(2)).Single().ItemCount == 1,
        "A later increase reused a cleared read summary.");
    center.MarkAllRead();
    Check(center.UnreadCount == 0 && center.Entries.All(entry => entry.IsRead), "MarkAllRead failed.");
    center.MarkAllRead();
    center.ClearRead();
    Check(center.Entries.Count == 0 && new NotificationCenter(Store("counts")).Entries.Count == 0, "Clearing history did not persist.");
    center.ResetObservations();
    Check(center.ObserveCount(NotificationKind.Approval, 500, "office-A", now).Count == 0, "Reset did not establish a fresh baseline.");
    Check(center.ObserveCount(NotificationKind.Approval, 501, "office-A", now).Count == 1, "Reset disabled future count alerts.");
    items.ResetObservations();
    Check(items.ObserveItems(NotificationKind.FieldTrip, [new("after-reset", "")], sensitiveScope, now).Count == 0, "Reset did not clear item baselines.");
    Check(items.Entries.Count == 2, "Reset deleted notification history.");

    File.WriteAllText(Store("corrupt"), "{\"학생비밀정보\": invalid-json");
    var recovered = new NotificationCenter(Store("corrupt"));
    Check(recovered.Entries.Count == 0, "Corrupt history did not recover.");
    Check(!File.ReadAllText(Store("corrupt")).Contains("학생비밀정보"), "Corrupt data was retained during recovery.");
    Check(AppLogger.Messages.All(message => !message.Contains("학생비밀정보")), "Corrupt data leaked to logs.");
    recovered.ObserveCount(NotificationKind.Approval, 0, "scope", now);
    recovered.ObserveCount(NotificationKind.Approval, 1, "scope", now);
    Check(new NotificationCenter(Store("corrupt")).UnreadCount == 1, "Recovered store failed to save.");
    var malformed = File.ReadAllText(Store("corrupt")).Replace("\"ItemCount\":1", "\"ItemCount\":0");
    File.WriteAllText(Store("malformed"), malformed);
    Check(new NotificationCenter(Store("malformed")).Entries.Count == 0, "Invalid stored item count accepted.");

    var atomicPath = Store("atomic");
    var atomic = new NotificationCenter(atomicPath);
    atomic.ObserveCount(NotificationKind.Approval, 0, "scope", now);
    atomic.ObserveCount(NotificationKind.Approval, 1, "scope", now);
    var original = File.ReadAllText(atomicPath);
    using (var locked = new FileStream(atomicPath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(atomic.ObserveCount(NotificationKind.Approval, 2, "scope", now).Count == 1, "Storage failure discarded an in-memory alert.");
    Check(atomic.HasPersistenceError, "Storage failure is not available to the UI.");
    Check(File.ReadAllText(atomicPath) == original, "Failed atomic save damaged prior history.");
    Check(!Directory.EnumerateFiles(probeRoot, "*.tmp").Any(), "Atomic save left temporary files.");
    atomic.MarkAllRead();
    Check(!atomic.HasPersistenceError, "Successful save did not clear storage error state.");
    Check(new NotificationCenter(atomicPath).Entries.Single().ItemCount == 2, "Store failed to recover the merged unread total after a write failure.");

    var unreadablePath = Store("initially-unreadable");
    File.Copy(atomicPath, unreadablePath);
    var protectedHistory = File.ReadAllText(unreadablePath);
    NotificationCenter unreadable;
    using (var locked = new FileStream(unreadablePath, FileMode.Open, FileAccess.Read, FileShare.None))
    {
        unreadable = new NotificationCenter(unreadablePath);
        Check(unreadable.HasPersistenceError, "Initial read failure is not visible.");
        unreadable.ObserveCount(NotificationKind.Approval, 0, "scope", now);
        unreadable.ObserveCount(NotificationKind.Approval, 1, "scope", now);
    }
    unreadable.ObserveCount(NotificationKind.Approval, 2, "scope", now);
    Check(unreadable.UnreadCount == 1 && unreadable.Entries.Single().ItemCount == 2 && unreadable.HasPersistenceError,
        "Unreadable initial history must keep new in-memory alerts available with a storage warning.");
    Check(File.ReadAllText(unreadablePath) == protectedHistory,
        "A later save replaced unreadable initial history after its lock disappeared.");
    Check(new NotificationCenter(unreadablePath).Entries.Single().ItemCount == 2,
        "Restart failed to recover preserved prior history.");

    foreach (var kind in new[] { NotificationKind.Approval, NotificationKind.NiceApproval })
    {
        var path = Store("aggregated-" + kind);
        var aggregated = new NotificationCenter(path);
        var updates = 0;
        aggregated.Changed += (_, _) => updates++;
        aggregated.ObserveCount(kind, 10, "PRIVATE-ACCOUNT-A", now);
        var originalSummary = aggregated.ObserveCount(kind, 12, "PRIVATE-ACCOUNT-A", now.AddMinutes(1)).Single();
        var increased = aggregated.ObserveCount(kind, 15, "PRIVATE-ACCOUNT-A", now.AddMinutes(2)).Single();
        Check(increased.Id == originalSummary.Id && increased.ItemCount == 5
            && increased.CreatedAt == now.AddMinutes(2) && updates == 2 && aggregated.UnreadCount == 1,
            "Repeated increases did not update the same unread summary once.");
        Check(originalSummary.ItemCount == 2 && originalSummary.CreatedAt == now.AddMinutes(1),
            "Updating the summary mutated a prior snapshot.");
        Check(aggregated.ObserveCount(kind, 3, "PRIVATE-ACCOUNT-A", now.AddMinutes(3)).Count == 0
            && aggregated.ObserveCount(kind, 3, "PRIVATE-ACCOUNT-A", now.AddMinutes(3)).Count == 0
            && aggregated.Entries.Single().ItemCount == 5 && updates == 2,
            "A decrease or unchanged count altered the unread total.");
        aggregated.ObserveCount(kind, 100, "PRIVATE-ACCOUNT-B", now.AddMinutes(4));
        var otherScope = aggregated.ObserveCount(kind, 101, "PRIVATE-ACCOUNT-B", now.AddMinutes(5)).Single();
        Check(otherScope.Id == originalSummary.Id && otherScope.ItemCount == 6 && updates == 3,
            "Account-specific baselines did not feed the app-wide system summary.");
        var title = kind == NotificationKind.Approval ? "에듀파인 결재대기" : "나이스 결재대기";
        Check(otherScope.Title == title && otherScope.Message.Contains("6건"), "System-specific title or total is incorrect.");
        var restored = new NotificationCenter(path);
        Check(restored.Entries.Single().Id == originalSummary.Id && restored.Entries.Single().ItemCount == 6,
            "Unread summary was not preserved after restart.");
        restored.ObserveCount(kind, 1000, "PRIVATE-ACCOUNT-A", now.AddMinutes(6));
        Check(restored.ObserveCount(kind, 1001, "PRIVATE-ACCOUNT-A", now.AddMinutes(7)).Single().ItemCount == 7,
            "Restart's fresh baseline did not preserve the existing unread total.");
        restored.MarkRead(originalSummary.Id);
        var next = restored.ObserveCount(kind, 1003, "PRIVATE-ACCOUNT-A", now.AddMinutes(8)).Single();
        Check(next.Id != originalSummary.Id && next.ItemCount == 2 && restored.Entries.Count == 2
            && restored.Entries.Single(entry => entry.Id == originalSummary.Id).ItemCount == 7,
            "A later increase modified read history instead of starting a new unread summary.");
        restored.MarkAllRead();
        Check(restored.ObserveCount(kind, 1004, "PRIVATE-ACCOUNT-A", now.AddMinutes(9)).Single().ItemCount == 1
            && restored.UnreadCount == 1 && restored.Entries.Count == 3,
            "All-read did not start a fresh future summary.");
        var storeText = File.ReadAllText(path);
        Check(!storeText.Contains("PRIVATE-ACCOUNT", StringComparison.Ordinal), "Summary aggregation persisted its account scope.");
        using var stored = JsonDocument.Parse(storeText);
        Check(stored.RootElement.GetProperty("Version").GetInt32() == 1
            && stored.RootElement.GetProperty("Entries").EnumerateArray().All(entry =>
                entry.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(
                    new[] { "CreatedAt", "Id", "IsRead", "ItemCount", "Kind" })),
            "Aggregation added fields to the stored entry schema.");
        var saturated = new NotificationCenter(Store("saturated-" + kind));
        saturated.ObserveCount(kind, 0, "scope", now);
        saturated.ObserveCount(kind, int.MaxValue, "scope", now);
        saturated.ObserveCount(kind, 0, "scope", now);
        Check(saturated.ObserveCount(kind, 1, "scope", now).Single().ItemCount == int.MaxValue
            && saturated.Entries.Single().ItemCount == int.MaxValue,
            "Aggregated totals overflowed or wrapped instead of saturating.");
    }

    var migrationPath = Store("aggregation-legacy");
    var migration = new NotificationCenter(migrationPath);
    migration.ObservePendingFieldTripReports([a], sensitiveScope, now);
    migration.ObservePendingAbsenceReports([a], sensitiveScope, now);
    var migrationData = JsonNode.Parse(File.ReadAllText(migrationPath))!.AsObject();
    var reportFingerprints = migrationData["NotifiedFieldTripReportFingerprints"]!.DeepClone();
    var absenceDays = migrationData["NotifiedPendingAbsenceDays"]!.DeepClone();
    var legacyRows = migrationData["Entries"]!.AsArray();
    string AddLegacy(NotificationKind kind, int count, int minute, bool read = false)
    {
        var id = Guid.NewGuid().ToString("N");
        legacyRows.Add(JsonSerializer.SerializeToNode(new { Id = id, Kind = kind,
            CreatedAt = now.AddMinutes(minute), IsRead = read, ItemCount = count }));
        return id;
    }
    AddLegacy(NotificationKind.Approval, 2, 1);
    var newestEdufineId = AddLegacy(NotificationKind.Approval, 3, 4);
    AddLegacy(NotificationKind.NiceApproval, 4, 2);
    var newestNiceId = AddLegacy(NotificationKind.NiceApproval, 7, 5);
    var readEdufineId = AddLegacy(NotificationKind.Approval, 8, 3, read: true);
    var readNiceId = AddLegacy(NotificationKind.NiceApproval, 6, 0, read: true);
    AddLegacy(NotificationKind.Absence, 1, 6);
    AddLegacy(NotificationKind.Absence, 2, 7);
    File.WriteAllText(migrationPath, migrationData.ToJsonString());
    var consolidated = new NotificationCenter(migrationPath);
    var eduSummary = consolidated.Entries.Single(entry => entry.Kind == NotificationKind.Approval && !entry.IsRead);
    var niceSummary = consolidated.Entries.Single(entry => entry.Kind == NotificationKind.NiceApproval && !entry.IsRead);
    Check(eduSummary.Id == newestEdufineId && eduSummary.ItemCount == 5 && eduSummary.CreatedAt == now.AddMinutes(4)
        && niceSummary.Id == newestNiceId && niceSummary.ItemCount == 11 && niceSummary.CreatedAt == now.AddMinutes(5),
        "Legacy unread migration did not preserve each system's latest identity, timestamp, and total.");
    Check(consolidated.Entries.Single(entry => entry.Id == readEdufineId).ItemCount == 8
        && consolidated.Entries.Single(entry => entry.Id == readNiceId).ItemCount == 6
        && consolidated.Entries.Count(entry => entry.Kind == NotificationKind.Absence) == 2,
        "Legacy migration modified read history or another notification kind.");
    var migratedData = JsonNode.Parse(File.ReadAllText(migrationPath))!.AsObject();
    Check(JsonNode.DeepEquals(reportFingerprints, migratedData["NotifiedFieldTripReportFingerprints"])
        && JsonNode.DeepEquals(absenceDays, migratedData["NotifiedPendingAbsenceDays"])
        && consolidated.ObservePendingFieldTripReports([a], sensitiveScope, now).Count == 0
        && consolidated.ObservePendingAbsenceReports([a], sensitiveScope, now).Count == 0,
        "Saving merged legacy alerts lost independent durable report deduplication.");
    var again = new NotificationCenter(migrationPath);
    Check(again.Entries.Count(entry => entry.Kind == NotificationKind.Approval && !entry.IsRead) == 1
        && again.Entries.Single(entry => entry.Id == newestNiceId).ItemCount == 11,
        "Legacy aggregation was not durable or was applied twice.");

    var bounded = new NotificationCenter(Store("bounded"));
    bounded.ObserveCount(NotificationKind.Absence, 0, "scope", now);
    for (var count = 1; count <= 305; count++)
        bounded.ObserveCount(NotificationKind.Absence, count, "scope", now.AddSeconds(count));
    Check(bounded.Entries.Count == 300 && bounded.Entries[0].CreatedAt == now.AddSeconds(305)
        && bounded.Entries[^1].CreatedAt == now.AddSeconds(6), "History limit or order incorrect.");
    Check(new NotificationCenter(Store("bounded")).Entries.Count == 300, "Bounded history failed to reload.");
    var large = new NotificationCenter(Store("large"));
    var largeRows = Enumerable.Range(0, 1005).Select(index => new NotificationSourceItem("item-" + index, "")).ToArray();
    large.ObserveItems(NotificationKind.Absence, largeRows, "scope", now);
    Check(large.ObserveItems(NotificationKind.Absence, largeRows, "scope", now).Count == 0, "Stable list above remembered-item target repeated alerts.");
    large.ObserveItems(NotificationKind.Absence, [], "scope", now);
    Check(large.ObserveItems(NotificationKind.Absence, [largeRows[0]], "scope", now).Count == 1, "Documented eviction behavior changed.");

    Console.WriteLine("PASS: baselines, counts, stable IDs, invalid input, scopes, read history, restart, corruption, storage failure, privacy, bounds");
}
finally
{
    var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
    if (!Path.GetFullPath(probeRoot).StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(probeRoot).StartsWith("oneclick-notification-data-", StringComparison.Ordinal))
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
