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

test('Nice approval alerts use independent baselines, safe durable history and an unread-only actual form',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-nice-approval-notifications-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>${['NotificationCenter.cs', 'NotificationCenterForm.cs', 'AppRelease.cs']
          .map(name => `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('')}</ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', project, '--configuration', 'Release', '--nologo'],
        { timeout: 100_000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /PASS: independent approval baselines, count validation, Nice labels, unread-only UI, durable read state, private scopes, legacy kinds/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-nice-approval-notifications-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Reflection;
using System.Text.Json;

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
        var directory = Path.Combine(Path.GetTempPath(), "oneclick-nice-approval-data-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            Check((int)NotificationKind.Approval == 0 && (int)NotificationKind.FieldTrip == 1
                && (int)NotificationKind.Absence == 2 && (int)NotificationKind.FieldTripReport == 3
                && (int)NotificationKind.AbsencePending == 4 && (int)NotificationKind.NiceApproval == 5,
                "Adding Nice approvals changed a stored notification kind.");
            var path = Path.Combine(directory, "notifications.json");
            var center = new NotificationCenter(path);
            var now = new DateTimeOffset(2026, 11, 20, 10, 0, 0, TimeSpan.FromHours(9));
            const string scope = "PRIVATE-OFFICE-ACCOUNT-SCOPE";
            const string otherScope = "PRIVATE-OTHER-ACCOUNT-SCOPE";
            var changes = 0;
            center.Changed += (_, _) => changes++;
            Check(center.ObserveCount(NotificationKind.Approval, 7, scope, now).Count == 0,
                "Initial Edufine count notified existing approvals.");
            Check(center.ObserveCount(NotificationKind.NiceApproval, 4, scope, now).Count == 0,
                "Nice approval baseline reused Edufine or notified existing approvals.");
            Check(center.ObserveCount(NotificationKind.NiceApproval, 4, scope, now).Count == 0,
                "Unchanged Nice approval count notified.");
            Check(center.ObserveCount(NotificationKind.NiceApproval, -1, scope, now).Count == 0
                && center.ObserveCount(NotificationKind.NiceApproval, 50, null!, now).Count == 0
                && center.ObserveCount(NotificationKind.NiceApproval, 50, " ", now).Count == 0
                && center.ObserveCount(NotificationKind.NiceApproval, 50, new string('x', 2049), now).Count == 0
                && center.ObserveCount((NotificationKind)999, 50, scope, now).Count == 0,
                "An invalid Nice count, scope or kind was accepted.");
            Check(changes == 0, "Baseline or invalid input fired an alert event.");
            var nice = center.ObserveCount(NotificationKind.NiceApproval, 6, scope, now).Single();
            Check(nice.Kind == NotificationKind.NiceApproval && nice.ItemCount == 2 && !nice.IsRead
                && nice.Title == "나이스 결재대기"
                && nice.Message == "아직 확인하지 않은 나이스 결재대기 증가 알림이 2건 있습니다. 나이스 결재대기 목록에서 확인해 주세요.",
                "Nice approval increase lost its source, difference or generic message.");
            var edufine = center.ObserveCount(NotificationKind.Approval, 8, scope, now).Single();
            Check(edufine.ItemCount == 1 && edufine.Title == "에듀파인 결재대기"
                && edufine.Message == "아직 확인하지 않은 에듀파인 결재대기 증가 알림이 1건 있습니다. 결재대기 목록에서 확인해 주세요.",
                "Nice observation altered Edufine baseline or the source-specific text.");
            Check(center.ObserveCount(NotificationKind.NiceApproval, 1, scope, now).Count == 0
                && center.ObserveCount(NotificationKind.NiceApproval, 1, scope, now).Count == 0,
                "Decreased or unchanged Nice count notified.");
            Check(center.ObserveCount(NotificationKind.NiceApproval, 2, scope, now).Single().ItemCount == 3,
                "A decrease failed to update the Nice baseline.");
            Check(center.ObserveCount(NotificationKind.NiceApproval, 20, otherScope, now).Count == 0
                && center.ObserveCount(NotificationKind.NiceApproval, 21, otherScope, now).Single().ItemCount == 4,
                "Nice approval baselines crossed account scopes.");
            Check(changes == 4 && center.UnreadCount == 2, "Approval increase events or per-kind aggregation are inconsistent.");

            var saved = File.ReadAllText(path);
            Check(!saved.Contains(scope, StringComparison.Ordinal) && !saved.Contains(otherScope, StringComparison.Ordinal),
                "Approval observation scope leaked to disk.");
            using (var json = JsonDocument.Parse(saved))
                Check(json.RootElement.GetProperty("Entries").EnumerateArray().Count(entry => entry.GetProperty("Kind").GetInt32() == 5) == 1,
                    "Nice approval history did not retain the new stable kind.");

            using var dialog = new NotificationCenterForm(center, _ => true);
            _ = dialog.Handle;
            var controls = Descendants(dialog).ToArray();
            var list = controls.OfType<ListBox>().Single();
            var markAll = controls.OfType<LinkLabel>().Single();
            Check(list.Items.Count == 2 && list.Items.Cast<object>().Count(item => item.ToString()!.Contains("나이스 결재대기")) == 1,
                "Actual notification form does not distinguish Nice approval alerts.");
            Check(list.Items.Cast<object>().Any(item => item.ToString()!.StartsWith("나이스 결재대기 4건,", StringComparison.Ordinal))
                && list.Items.Cast<object>().Any(item => item.ToString()!.StartsWith("에듀파인 결재대기 1건,", StringComparison.Ordinal)),
                "Actual Nice summary has an incorrect count or source label.");
            var updated = center.ObserveCount(NotificationKind.NiceApproval, 3, scope, now.AddMinutes(1)).Single();
            Check(updated.Id == nice.Id && updated.ItemCount == 5 && changes == 5 && list.Items.Count == 2
                && list.Items.Cast<object>().Any(item => item.ToString()!.StartsWith("나이스 결재대기 5건,", StringComparison.Ordinal)),
                "An open list appended another Nice alert instead of updating its count and source-specific summary.");
            center.MarkRead(nice.Id);
            Check(list.Items.Count == 1 && center.Entries.Single(entry => entry.Id == nice.Id).IsRead
                && new NotificationCenter(path).Entries.Single(entry => entry.Id == nice.Id).IsRead,
                "Reading a Nice alert retained it in the UI or failed to persist the read state.");
            var afterRead = center.ObserveCount(NotificationKind.NiceApproval, 4, scope, now.AddMinutes(2)).Single();
            Check(afterRead.Id != nice.Id && afterRead.ItemCount == 1 && list.Items.Count == 2
                && list.Items.Cast<object>().Any(item => item.ToString()!.StartsWith("나이스 결재대기 1건,", StringComparison.Ordinal)),
                "A new Nice increase after acknowledgment reused the read total or remained hidden.");
            var clickMarkAll = typeof(LinkLabel).GetMethod("OnLinkClicked", BindingFlags.Instance | BindingFlags.NonPublic)!;
            clickMarkAll.Invoke(markAll, [new LinkLabelLinkClickedEventArgs(markAll.Links[0])]);
            Check(list.Items.Count == 0 && !markAll.Enabled && center.UnreadCount == 0,
                "Acknowledge-all left a Nice or Edufine alert visible.");
            var restarted = new NotificationCenter(path);
            Check(restarted.Entries.Count == 3 && restarted.Entries.All(entry => entry.IsRead)
                && restarted.Entries.Count(entry => entry.Kind == NotificationKind.NiceApproval) == 2,
                "Restart lost approval kinds or acknowledged state.");
            using (var reopened = new NotificationCenterForm(restarted))
            {
                _ = reopened.Handle;
                Check(Descendants(reopened).OfType<ListBox>().Single().Items.Count == 0,
                    "Restart displayed acknowledged approval history.");
            }
            Check(restarted.ObserveCount(NotificationKind.NiceApproval, 500, scope, now).Count == 0
                && restarted.ObserveCount(NotificationKind.Approval, 500, scope, now).Count == 0,
                "Restart restored stale approval count baselines.");
            Check(restarted.ObserveCount(NotificationKind.NiceApproval, 501, scope, now).Single().ItemCount == 1
                && restarted.ObserveCount(NotificationKind.Approval, 502, scope, now).Single().ItemCount == 2,
                "Restart failed to monitor both approval sources independently.");

            var legacyPath = Path.Combine(directory, "legacy.json");
            File.WriteAllText(legacyPath, JsonSerializer.Serialize(new
            {
                Version = 1,
                Entries = Enumerable.Range(0, 5).Select(kind => new
                {
                    Id = Guid.NewGuid().ToString("N"), Kind = kind, CreatedAt = now, IsRead = true, ItemCount = 1
                }).ToArray()
            }));
            var legacy = new NotificationCenter(legacyPath);
            Check(legacy.Entries.Count == 5 && legacy.Entries.All(entry => entry.IsRead)
                && legacy.Entries.Select(entry => (int)entry.Kind).Order().SequenceEqual(Enumerable.Range(0, 5)),
                "Legacy notification kinds or read flags changed during loading.");
            Check(legacy.ObserveCount(NotificationKind.NiceApproval, 0, scope, now).Count == 0
                && legacy.ObserveCount(NotificationKind.NiceApproval, 1, scope, now).Count == 1
                && new NotificationCenter(legacyPath).Entries.Count == 6,
                "A legacy history could not add and persist a new Nice approval alert.");
            Console.WriteLine("PASS: independent approval baselines, count validation, Nice labels, unread-only UI, durable read state, private scopes, legacy kinds");
        }
        finally
        {
            var actual = Path.GetFullPath(directory);
            Check(Path.GetDirectoryName(actual) == Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath()))
                && Path.GetFileName(actual).StartsWith("oneclick-nice-approval-data-", StringComparison.Ordinal),
                "Unsafe approval probe cleanup path.");
            Directory.Delete(actual, recursive: true);
        }
    }
}

namespace BrowserThumbnailPrototype
{
    internal static class AppLogger { public static void Info(string area, string message) { } }
}
`;
