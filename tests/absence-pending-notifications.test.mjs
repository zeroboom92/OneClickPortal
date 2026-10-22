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

test('pending absence reports remind daily, deduplicate durably and keep only private bounded keys',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-pending-absence-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root, 'NotificationCenter.cs'))}" Link="NotificationCenter.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: initial pending, Korea days, new IDs, restart, cleared history, scopes, privacy, legacy, retention, atomic retry/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-pending-absence-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Text.Json;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
var probeRoot = Path.Combine(Path.GetTempPath(), "oneclick-pending-absence-data-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(probeRoot);
try
{
    var now = new DateTimeOffset(2026, 10, 22, 8, 0, 0, TimeSpan.FromHours(9));
    string Store(string name) => Path.Combine(probeRoot, name + ".json");
    const string scope = "OFFICE-SECRET/ACCOUNT-SECRET/SCHOOL-SECRET";
    var a = new NotificationSourceItem("ABSENCE-SECRET-A", "학생 이름과 결석 사유 원문 비밀 A");
    var b = new NotificationSourceItem("ABSENCE-SECRET-B", "학생 이름과 결석 사유 원문 비밀 B");
    var c = new NotificationSourceItem("ABSENCE-SECRET-C", "학생 이름과 결석 사유 원문 비밀 C");
    var d = new NotificationSourceItem("ABSENCE-SECRET-D", "학생 이름과 결석 사유 원문 비밀 D");
    var center = new NotificationCenter(Store("daily"));
    var changes = 0;
    center.Changed += (_, _) => changes++;
    Check((int)NotificationKind.Approval == 0 && (int)NotificationKind.FieldTrip == 1
        && (int)NotificationKind.Absence == 2 && (int)NotificationKind.FieldTripReport == 3
        && (int)NotificationKind.AbsencePending == 4, "Existing kind numbers changed.");
    foreach (var invalid in new IReadOnlyList<NotificationSourceItem>?[]
        { null, [a, null!], [a, new(" ", "")], [a, new(new string('x', 2049), "")] })
        Check(center.ObservePendingAbsenceReports(invalid, scope, now).Count == 0, "Invalid initial snapshot accepted.");
    foreach (var invalidScope in new string?[] { null, " ", new('s', 2049) })
        Check(center.ObservePendingAbsenceReports([a], invalidScope!, now).Count == 0, "Invalid scope accepted.");
    Check(!File.Exists(Store("daily")) && changes == 0, "Invalid input modified history or storage.");
    var first = center.ObservePendingAbsenceReports([a, b, c, a], scope, now).Single();
    Check(first.Kind == NotificationKind.AbsencePending && first.ItemCount == 3 && !first.IsRead
        && first.Title == "결석신고서 접수대기" && first.Message.Contains("3건")
        && !first.Message.Contains("제출되었습니다") && first.SourceKey is null,
        "First successful read did not aggregate three existing pending reports.");
    Check(center.UnreadCount == 1 && changes == 1, "Initial notification was not published once.");
    var saved = File.ReadAllText(Store("daily"));
    foreach (var secret in new[] { scope, "OFFICE-SECRET", "ACCOUNT-SECRET", "SCHOOL-SECRET",
        a.Id, b.Id, c.Id, a.Summary, b.Summary, c.Summary })
        Check(!saved.Contains(secret, StringComparison.Ordinal), "Source information reached disk.");
    Check(!first.Title.Contains(a.Summary) && !first.Message.Contains(a.Summary), "Source summary reached UI.");
    using (var json = JsonDocument.Parse(saved))
    {
        Check(json.RootElement.GetProperty("Version").GetInt32() == 1, "v1 compatibility changed.");
        var days = json.RootElement.GetProperty("NotifiedPendingAbsenceDays");
        Check(days.GetArrayLength() == 1 && days[0].GetProperty("Date").GetString() == "2026-10-22",
            "Korea observation date missing.");
        var keys = days[0].GetProperty("Fingerprints");
        Check(keys.GetArrayLength() == 3 && keys.EnumerateArray().All(key => key.GetString()!.Length == 64
            && key.GetString()!.All(character => character is >= '0' and <= '9' or >= 'A' and <= 'F')),
            "Only scoped SHA256 keys should be persisted.");
    }
    Check(center.ObservePendingAbsenceReports([a, b, c], scope, now.AddHours(1)).Count == 0,
        "A same-day query repeated pending reports.");
    center.ResetObservations();
    Check(center.ObservePendingAbsenceReports([a, b, c], scope, now).Count == 0,
        "Reconnect discarded daily keys.");
    var restarted = new NotificationCenter(Store("daily"));
    Check(restarted.Entries.Single().Message == first.Message
        && restarted.ObservePendingAbsenceReports([a, b, c], scope, now).Count == 0,
        "Restart changed pending semantics or repeated reports.");
    restarted.MarkAllRead();
    restarted.ClearRead();
    restarted = new NotificationCenter(Store("daily"));
    Check(restarted.Entries.Count == 0 && restarted.ObservePendingAbsenceReports([a, b, c], scope, now).Count == 0,
        "Clearing visible history discarded today's keys.");
    Check(restarted.ObservePendingAbsenceReports([b, c, d], scope, now).Single().ItemCount == 1,
        "Same-count replacement failed to alert a new stable ID.");
    Check(restarted.ObservePendingAbsenceReports([], scope, now).Count == 0
        && restarted.ObservePendingAbsenceReports([a, b, c, d], scope, now).Count == 0,
        "A report returning during the same day alerted again.");
    Check(restarted.ObservePendingAbsenceReports([a, b, c], scope, now.AddDays(1)).Single().ItemCount == 3,
        "Next Korea day did not remind about remaining reports.");
    Check(restarted.ObservePendingAbsenceReports([a], scope + "/other-account", now.AddDays(1)).Count == 1
        && restarted.ObservePendingAbsenceReports([a], "OFFICE-SECRET/ACCOUNT-SECRET/OTHER-SCHOOL", now.AddDays(1)).Count == 1
        && restarted.ObservePendingAbsenceReports([a], "OTHER-OFFICE/ACCOUNT-SECRET/SCHOOL-SECRET", now.AddDays(1)).Count == 1,
        "Different office, account or school shared a daily key.");

    var boundary = new NotificationCenter(Store("boundary"));
    var beforeMidnight = new DateTimeOffset(2026, 10, 22, 14, 59, 59, TimeSpan.Zero);
    Check(boundary.ObservePendingAbsenceReports([a], scope, beforeMidnight).Count == 1
        && boundary.ObservePendingAbsenceReports([a], scope, beforeMidnight.ToOffset(TimeSpan.FromHours(-5))).Count == 0
        && boundary.ObservePendingAbsenceReports([a], scope, beforeMidnight.AddSeconds(1)).Count == 1,
        "The daily boundary followed an input offset or UTC instead of Korea time.");
    var empty = new NotificationCenter(Store("empty"));
    Check(empty.ObservePendingAbsenceReports([], scope, now).Count == 0
        && empty.ObservePendingAbsenceReports([a], scope, now).Count == 1,
        "An initial empty list hid a later pending report.");

    var legacyId = Guid.NewGuid().ToString("N");
    File.WriteAllText(Store("legacy"), JsonSerializer.Serialize(new
    {
        Version = 1,
        Entries = new[] { new { Id = legacyId, Kind = 2, CreatedAt = now, IsRead = true, ItemCount = 2 } }
    }));
    var legacy = new NotificationCenter(Store("legacy"));
    Check(legacy.Entries.Single().Id == legacyId && legacy.Entries.Single().Title == "결석신고서 제출"
        && legacy.Entries.Single().IsRead, "Legacy submitted notification changed meaning.");
    legacy.ObservePendingFieldTripReports([a], scope, now);
    legacy.ObservePendingAbsenceReports([a, b, c], scope, now);
    legacy = new NotificationCenter(Store("legacy"));
    Check(legacy.Entries.Count == 3 && legacy.ObservePendingFieldTripReports([a], scope, now).Count == 0
        && legacy.ObservePendingAbsenceReports([a, b, c], scope, now).Count == 0,
        "Upgraded storage lost existing history or report deduplication.");

    var retained = new NotificationCenter(Store("retained"));
    for (var index = 0; index < 45; index++)
        Check(retained.ObservePendingAbsenceReports([a], scope, now.AddDays(index)).Count == 1,
            "Daily reminder unexpectedly suppressed.");
    using (var json = JsonDocument.Parse(File.ReadAllText(Store("retained"))))
    {
        var days = json.RootElement.GetProperty("NotifiedPendingAbsenceDays");
        Check(NotificationCenter.PendingAbsenceRetentionDays == 35 && days.GetArrayLength() == 35
            && days[0].GetProperty("Date").GetString() == "2026-11-01"
            && days[34].GetProperty("Date").GetString() == "2026-12-05", "Daily keys were not limited to the latest 35 days.");
    }
    Check(new NotificationCenter(Store("retained")).ObservePendingAbsenceReports([a], scope, now.AddDays(44)).Count == 0,
        "Retention lost the current day's keys on restart.");

    var atomicPath = Store("atomic");
    var atomic = new NotificationCenter(atomicPath);
    atomic.ObservePendingAbsenceReports([a], scope, now);
    var original = File.ReadAllText(atomicPath);
    using (var locked = new FileStream(atomicPath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(atomic.ObservePendingAbsenceReports([a, b, c], scope, now).Count == 0,
            "A popup was published before daily deduplication was durable.");
    Check(atomic.HasPersistenceError && atomic.Entries.Count == 1 && File.ReadAllText(atomicPath) == original,
        "Failed atomic save changed prior history.");
    Check(atomic.ObservePendingAbsenceReports([a, b, c], scope, now).Single().ItemCount == 2
        && !atomic.HasPersistenceError, "Retry lost never-published pending reports.");
    Check(new NotificationCenter(atomicPath).ObservePendingAbsenceReports([a, b, c], scope, now).Count == 0,
        "Successful retry did not persist daily keys.");

    var failedRestartPath = Store("failed-restart");
    var failedRestart = new NotificationCenter(failedRestartPath);
    failedRestart.ObservePendingAbsenceReports([a], scope, now);
    using (var locked = new FileStream(failedRestartPath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(failedRestart.ObservePendingAbsenceReports([b], scope, now).Count == 0, "Failed write published an alert.");
    Check(new NotificationCenter(failedRestartPath).ObservePendingAbsenceReports([a, b], scope, now).Single().ItemCount == 1,
        "Immediate restart after failed write lost the deferred new ID.");

    var boundedPath = Store("full-history");
    var bounded = new NotificationCenter(boundedPath);
    bounded.ObserveCount(NotificationKind.Approval, 0, scope, now);
    for (var index = 1; index <= 300; index++) bounded.ObserveCount(NotificationKind.Approval, index, scope, now.AddSeconds(index));
    var priorIds = bounded.Entries.Select(entry => entry.Id).ToArray();
    using (var locked = new FileStream(boundedPath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(bounded.ObservePendingAbsenceReports([a, b, c], scope, now.AddHours(1)).Count == 0,
            "Full-history failed write published an alert.");
    Check(bounded.Entries.Select(entry => entry.Id).SequenceEqual(priorIds), "Rollback lost a trimmed old notification.");
    Check(bounded.ObservePendingAbsenceReports([a, b, c], scope, now.AddHours(1)).Single().ItemCount == 3
        && bounded.Entries.Count == 300, "Full-history retry did not restore all deferred IDs.");

    var prunePath = Store("prune-rollback");
    var pruning = new NotificationCenter(prunePath);
    pruning.ObservePendingAbsenceReports([a], scope, now);
    var beforePrune = File.ReadAllText(prunePath);
    using (var locked = new FileStream(prunePath, FileMode.Open, FileAccess.Read, FileShare.None))
        Check(pruning.ObservePendingAbsenceReports([b], scope, now.AddDays(35)).Count == 0, "Pruning failure published an alert.");
    Check(File.ReadAllText(prunePath) == beforePrune && pruning.ObservePendingAbsenceReports([a], scope, now).Count == 0,
        "Pruning rollback lost previously durable daily keys.");

    var protectedHistory = File.ReadAllText(atomicPath);
    NotificationCenter unreadable;
    using (var locked = new FileStream(atomicPath, FileMode.Open, FileAccess.Read, FileShare.None))
    {
        unreadable = new NotificationCenter(atomicPath);
        Check(unreadable.HasPersistenceError && unreadable.ObservePendingAbsenceReports([a, d], scope, now).Count == 0,
            "Unreadable history allowed potentially duplicate alerts.");
    }
    Check(unreadable.ObservePendingAbsenceReports([d], scope, now).Count == 0
        && File.ReadAllText(atomicPath) == protectedHistory, "Unreadable original history was overwritten.");
    Check(new NotificationCenter(atomicPath).ObservePendingAbsenceReports([a, b, c, d], scope, now).Single().ItemCount == 1,
        "Restart did not recover original keys and a deferred new ID.");
    Check(!Directory.EnumerateFiles(probeRoot, "*.tmp").Any(), "A failed save leaked temporary files.");
    Check(AppLogger.Messages.All(message => !message.Contains(scope) && !message.Contains(a.Id)
        && !message.Contains(a.Summary)), "Source information leaked into diagnostics.");
    Console.WriteLine("PASS: initial pending, Korea days, new IDs, restart, cleared history, scopes, privacy, legacy, retention, atomic retry");
}
finally
{
    var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
    if (!Path.GetFullPath(probeRoot).StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(probeRoot).StartsWith("oneclick-pending-absence-data-", StringComparison.Ordinal))
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
