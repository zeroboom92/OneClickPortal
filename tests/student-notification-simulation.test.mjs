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

// This executes the production engine with fictional source records and an isolated
// store. It does not connect to a browser, portal, live history or approval workflow.
test('student-submission notification simulation uses the actual C# engine',
  { timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-student-simulation-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root, 'NotificationCenter.cs'))}" Link="NotificationCenter.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'], { timeout: 80_000 });
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      const cases = [
        ['initial-and-kinds', 'existing lists are quiet; one new application and absence each alert once'],
        ['stable-identities', 'order, duplicate rows, replacement at the same count and returning items'],
        ['acknowledgement', 'marking and clearing history do not repeat known items in the same session'],
        ['invalid-snapshots', 'invalid complete lists never establish or change a baseline'],
        ['restart-policy', 'history persists while both new-submission baselines reset on restart'],
        ['remembered-window', 'large stable lists stay quiet; an old absent ID can alert after the memory window evicts it'],
        ['privacy-and-scopes', 'kinds and scopes are independent; names, bodies and source keys never reach disk'],
      ];
      for (const [scenario, name] of cases) {
        await t.test(name, async () => {
          const result = await run('dotnet', [assembly, scenario, join(directory, scenario + '.json')],
            { timeout: 15_000 });
          assert.ok(result.stdout.includes('PASS: ' + scenario), result.stdout);
        });
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-student-simulation-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Text.Json;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
var scenario = args[0];
var path = args[1];
var now = new DateTimeOffset(2026, 10, 15, 12, 0, 0, TimeSpan.FromHours(9));
const string scope = "FICTIONAL-OFFICE-ACCOUNT-SCHOOL-CLASS-SECRET";
var a = new NotificationSourceItem("FICTIONAL-SOURCE-A-SECRET", "모의학생가: 신청서 원문 비밀");
var b = new NotificationSourceItem("FICTIONAL-SOURCE-B-SECRET", "모의학생나: 결석신고서 사유 비밀");
var c = new NotificationSourceItem("FICTIONAL-SOURCE-C-SECRET", "모의학생다: 신청서 본문 비밀");
var d = new NotificationSourceItem("FICTIONAL-SOURCE-D-SECRET", "모의학생라: 결석신고서 본문 비밀");
var center = new NotificationCenter(path);
var changes = 0;
center.Changed += (_, _) => changes++;
IReadOnlyList<PortalNotification> Observe(NotificationKind kind, params NotificationSourceItem[] items) =>
    center.ObserveItems(kind, items, scope, now);
var kinds = new[] { NotificationKind.FieldTrip, NotificationKind.Absence };

switch (scenario)
{
    case "initial-and-kinds":
        foreach (var kind in kinds)
        {
            Check(Observe(kind, a, a).Count == 0, $"{kind}: initial existing list alerted.");
            Check(Observe(kind, a).Count == 0, $"{kind}: unchanged baseline alerted.");
        }
        Check(changes == 0 && center.Entries.Count == 0 && !File.Exists(path),
            "Establishing existing-list baselines changed alerts or disk.");
        foreach (var kind in kinds)
        {
            var alert = Observe(kind, a, b, b).Single();
            Check(alert.Kind == kind && alert.ItemCount == 1 && !alert.IsRead
                && alert.CreatedAt == now && alert.SourceKey?.Length == 64,
                $"{kind}: a newly submitted record did not produce exactly one unread alert.");
            Check(alert.Title == (kind == NotificationKind.FieldTrip ? "교외체험학습 신청" : "결석신고서 제출")
                && alert.Message == (kind == NotificationKind.FieldTrip
                    ? "새 교외체험학습 신청서가 1건 제출되었습니다." : "새 결석신고서가 1건 제출되었습니다."),
                $"{kind}: student submission alert wording is incorrect.");
            Check(Observe(kind, b, a, b).Count == 0, $"{kind}: repeated query alerted again.");
        }
        Check(changes == 2 && center.UnreadCount == 2 && center.Entries.Count == 2,
            "One application plus one absence did not produce exactly two history changes.");
        Check(center.Entries[0].Kind == NotificationKind.Absence,
            "Later arrival was not placed first when arrival timestamps tie.");
        Check(center.Entries.Select(entry => entry.SourceKey).Distinct().Count() == 2,
            "The same raw source ID collided across application and absence kinds.");
        break;

    case "stable-identities":
        foreach (var kind in kinds)
        {
            Check(Observe(kind, a, b).Count == 0, $"{kind}: initial list alerted.");
            Check(Observe(kind, b, a, b, a).Count == 0, $"{kind}: ordering or duplicated rows alerted.");
            var replaced = Observe(kind, a, c).Single();
            Check(replaced.Kind == kind && replaced.ItemCount == 1,
                $"{kind}: same-count replacement was missed.");
            Check(Observe(kind).Count == 0, $"{kind}: removing all rows alerted.");
            Check(Observe(kind, c, b, a, c).Count == 0,
                $"{kind}: previously seen records alerted after disappearing and returning.");
            var added = Observe(kind, d, d, c, b, a).Single();
            Check(added.Kind == kind && added.SourceKey != replaced.SourceKey,
                $"{kind}: subsequent distinct submission was missed.");
            Check(Observe(kind, a, b, c, d).Count == 0, $"{kind}: stable full list alerted again.");
        }
        Check(center.Entries.Count == 4 && changes == 4,
            "Identity-based observations did not produce exactly two arrivals per kind.");
        break;

    case "acknowledgement":
        foreach (var kind in kinds)
        {
            Observe(kind, a);
            var alert = Observe(kind, a, b).Single();
            var beforeRead = changes;
            center.MarkRead(alert.Id);
            Check(center.Entries.Single(entry => entry.Id == alert.Id).IsRead && changes == beforeRead + 1,
                $"{kind}: acknowledgement did not change the actual history entry.");
            center.MarkRead(alert.Id);
            Check(changes == beforeRead + 1, $"{kind}: repeated acknowledgement changed history.");
            Check(Observe(kind, a, b).Count == 0, $"{kind}: reading an alert caused it to repeat.");
            center.ClearRead();
            Check(center.Entries.Count == 0 && center.UnreadCount == 0,
                $"{kind}: cleared read history remained visible.");
            Check(Observe(kind, b, a).Count == 0,
                $"{kind}: clearing read history discarded this session's identity baseline.");
        }
        Check(new NotificationCenter(path).Entries.Count == 0,
            "Cleared read history was restored from disk.");
        break;

    case "invalid-snapshots":
        foreach (var kind in kinds)
        {
            Check(center.ObserveItems(kind, [a, new(" ", "")], scope, now).Count == 0,
                $"{kind}: partially invalid first list was accepted.");
            Check(Observe(kind, a, b).Count == 0,
                $"{kind}: partially invalid first list established an incomplete baseline.");
            var invalidLists = new IReadOnlyList<NotificationSourceItem>?[]
                { null, [c, null!], [c, new("", "")], [c, new(new string('x', 2049), "")] };
            foreach (var invalid in invalidLists)
                Check(center.ObserveItems(kind, invalid, scope, now).Count == 0,
                    $"{kind}: invalid candidate snapshot was accepted.");
            foreach (var invalidScope in new string?[] { null, " ", new string('x', 2049) })
                Check(center.ObserveItems(kind, [c], invalidScope!, now).Count == 0,
                    $"{kind}: invalid observation scope was accepted.");
            Check(center.ObserveItems((NotificationKind)999, [c], scope, now).Count == 0,
                "Undefined notification kind was accepted.");
            Check(center.ObserveItems(kind, [a, b, c], scope, now).Count == 1,
                $"{kind}: invalid snapshot remembered its valid prefix or damaged the prior baseline.");
            Check(Observe(kind, a, b, c).Count == 0,
                $"{kind}: valid list failed to settle after ignored invalid snapshots.");
        }
        Check(changes == 2 && center.Entries.Count == 2,
            "Ignored invalid snapshots changed notification history.");
        break;

    case "restart-policy":
        foreach (var kind in kinds)
        {
            Observe(kind, a);
            Check(Observe(kind, a, b).Count == 1, $"{kind}: pre-restart arrival was missed.");
        }
        center.MarkRead(center.Entries[0].Id);
        var savedIds = center.Entries.Select(entry => entry.Id).ToArray();
        var restarted = new NotificationCenter(path);
        Check(restarted.Entries.Select(entry => entry.Id).SequenceEqual(savedIds)
            && restarted.UnreadCount == 1 && restarted.Entries.All(entry => entry.SourceKey is null),
            "Restart lost persisted history/read state or restored ephemeral source keys.");
        foreach (var kind in kinds)
        {
            // C arrived while the program was stopped. Current policy establishes a
            // fresh baseline for the entire first list and does not retrospectively alert C.
            Check(restarted.ObserveItems(kind, [a, b, c], scope, now).Count == 0,
                $"{kind}: restart did not treat the first complete list as a new baseline.");
            Check(restarted.ObserveItems(kind, [a, b, c, d], scope, now).Count == 1,
                $"{kind}: new arrival after the restarted baseline was missed.");
            Check(restarted.ObserveItems(kind, [d, c, b, a, d], scope, now).Count == 0,
                $"{kind}: repeated query after restart alerted again.");
        }
        Check(restarted.Entries.Count == 4 && restarted.UnreadCount == 3,
            "Restart did not retain old history plus one later arrival per kind.");
        restarted.ResetObservations();
        foreach (var kind in kinds)
            Check(restarted.ObserveItems(kind, [a, b, c, d], scope, now).Count == 0,
                $"{kind}: resetting monitoring failed to establish a fresh baseline.");
        Check(restarted.Entries.Count == 4, "Resetting observations deleted visible history.");
        break;

    case "remembered-window":
        Check(NotificationCenter.MaximumRememberedItems == 1000,
            "The documented recent-item memory target changed.");
        var largeList = Enumerable.Range(0, 1005)
            .Select(index => new NotificationSourceItem("FICTIONAL-LARGE-LIST-" + index, "")).ToArray();
        foreach (var kind in kinds)
        {
            Check(center.ObserveItems(kind, largeList, scope, now).Count == 0,
                $"{kind}: a large initial list alerted existing submissions.");
            Check(center.ObserveItems(kind, largeList.Reverse().ToArray(), scope, now).Count == 0,
                $"{kind}: a stable list larger than 1,000 items evicted its currently present records.");
            // The reverse query refreshes encounter order. The original list's last
            // five rows become the oldest absent memories after a later empty query.
            Check(Observe(kind).Count == 0, $"{kind}: an empty list generated an alert.");
            Check(Observe(kind, largeList[^1]).Count == 1,
                $"{kind}: an old absent ID did not follow the documented eviction policy.");
            Check(Observe(kind, largeList[0]).Count == 0,
                $"{kind}: a recent remembered absent ID was unnecessarily repeated.");
            Check(Observe(kind, largeList[^1], largeList[0]).Count == 0,
                $"{kind}: the re-observed evicted record did not settle after one alert.");
        }
        Check(center.Entries.Count == 2,
            "Each notification kind did not independently exhibit its bounded memory policy.");
        break;

    case "privacy-and-scopes":
        var secrets = new List<string> { scope, a.Id, a.Summary, b.Id, b.Summary, c.Id, c.Summary };
        foreach (var kind in kinds)
        {
            Observe(kind, a);
            var original = Observe(kind, a, b).Single();
            secrets.Add(original.SourceKey!);
            const string secondScope = "FICTIONAL-DIFFERENT-ACCOUNT-SCHOOL-CLASS-SECRET";
            secrets.Add(secondScope);
            Check(center.ObserveItems(kind, [a], secondScope, now).Count == 0,
                $"{kind}: a separate scope reused the first scope's baseline.");
            var separate = center.ObserveItems(kind, [a, b], secondScope, now).Single();
            secrets.Add(separate.SourceKey!);
            Check(separate.SourceKey != original.SourceKey,
                $"{kind}: identical source ID shared its fingerprint across accounts/classes.");
            Check(Observe(kind, a, b, c).Count == 1,
                $"{kind}: observation of another scope altered this scope's baseline.");
        }
        var stored = File.ReadAllText(path);
        foreach (var secret in secrets)
        {
            Check(!stored.Contains(secret, StringComparison.Ordinal),
                "Source ID, scope, name, document body or ephemeral fingerprint reached disk.");
            Check(center.Entries.All(entry => !entry.Title.Contains(secret, StringComparison.Ordinal)
                && !entry.Message.Contains(secret, StringComparison.Ordinal)),
                "Source content reached notification wording.");
            Check(AppLogger.Messages.All(message => !message.Contains(secret, StringComparison.Ordinal)),
                "Source content reached logs.");
        }
        using (var json = JsonDocument.Parse(stored))
        {
            var store = json.RootElement;
            Check(store.GetProperty("Version").GetInt32() == 1
                && store.GetProperty("Entries").GetArrayLength() == 6,
                "Private generic notification history did not persist all simulated arrivals.");
            Check(store.EnumerateObject().Select(property => property.Name).Order()
                .SequenceEqual(new[] { "Entries", "Version" }),
                "New-submission baselines or source fingerprints were persisted.");
            var fields = new[] { "CreatedAt", "Id", "IsRead", "ItemCount", "Kind" };
            foreach (var entry in store.GetProperty("Entries").EnumerateArray())
                Check(entry.EnumerateObject().Select(property => property.Name).Order().SequenceEqual(fields),
                    "Stored entry schema includes source content.");
        }
        break;

    default:
        throw new Exception("Unknown student simulation scenario.");
}
Console.WriteLine("PASS: " + scenario);

namespace BrowserThumbnailPrototype
{
    internal static class AppLogger
    {
        public static List<string> Messages { get; } = [];
        public static void Info(string area, string message) => Messages.Add(message);
    }
}
`;
