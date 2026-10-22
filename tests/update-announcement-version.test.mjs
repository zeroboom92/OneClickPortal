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

test('maintenance releases preserve announcement acknowledgement independently of the installed version',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-announcement-version-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><Version>9.9.9</Version><AssemblyVersion>9.9.9.0</AssemblyVersion><InformationalVersion>9.9.9</InformationalVersion></PropertyGroup>
        <ItemGroup>
          ${['UpdateAnnouncement.cs', 'UpdateHistory.cs'].map(name =>
            `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('\n')}
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', project, '--configuration', 'Release'],
        { timeout: 100_000, maxBuffer: 1024 * 1024 }).catch(error => {
          assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
        });
      assert.match(result.stdout,
        /PASS: installed version, preserved announcement, acknowledgement, manual replay, preview isolation/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-announcement-version-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Windows.Forms;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
        void Reset(string? acknowledged, bool? nextHidden = null)
        {
            AppPreferences.Acknowledged = acknowledged;
            AppPreferences.Reads = 0;
            AppPreferences.Writes.Clear();
            UpdateAnnouncementForm.Shown = 0;
            UpdateAnnouncementForm.InitialHidden = false;
            UpdateAnnouncementForm.NextHidden = nextHidden;
            UpdateAnnouncementForm.NextOpenSettings = false;
        }

        Check(UpdateAnnouncement.CurrentVersion == "9.9.9", "Installed version must come from the assembly.");
        Check(UpdateHistory.Current.Version == "1.4.0" && UpdateHistory.Releases.Count == 30,
            "The maintenance release must preserve the existing announcement and history.");
        Check(UpdateAnnouncement.AnnouncementVersion == UpdateHistory.Current.Version,
            "Announcement identity must follow its content rather than the installed version.");
        Check(UpdateAnnouncement.Title == UpdateHistory.Current.Title
            && UpdateAnnouncement.Summary == UpdateHistory.Current.Summary, "Announcement content diverged from history.");
        Check(!UpdateAnnouncement.ShouldShow("1.4.0"), "Acknowledged unchanged content was shown again.");
        Check(UpdateAnnouncement.ShouldShow(null) && UpdateAnnouncement.ShouldShow("1.3.2")
            && UpdateAnnouncement.ShouldShow("9.9.9"), "Unacknowledged content was incorrectly suppressed.");

        // Only the owner object is constructed. The dialog and preferences below
        // are in-memory stubs; no native window is shown and no registry is used.
        using var owner = new Form();
        Check(!owner.Visible && !owner.IsHandleCreated, "The test owner unexpectedly created a native window.");

        Reset("1.4.0");
        Check(!UpdateAnnouncement.Show(owner) && UpdateAnnouncementForm.Shown == 0
            && AppPreferences.Writes.Count == 0, "An acknowledged maintenance announcement was displayed or saved again.");

        Reset(null, nextHidden: true);
        UpdateAnnouncementForm.NextOpenSettings = true;
        Check(UpdateAnnouncement.Show(owner) && UpdateAnnouncementForm.Shown == 1,
            "An unacknowledged announcement did not follow its normal settings action.");
        Check(AppPreferences.Writes.SequenceEqual(new string?[] { "1.4.0" }),
            "The hide choice was saved against the installed version instead of the announcement version.");

        Reset("1.4.0");
        UpdateAnnouncement.Show(owner, force: true);
        Check(UpdateAnnouncementForm.Shown == 1 && UpdateAnnouncementForm.InitialHidden
            && AppPreferences.Writes.Count == 0, "Manual replay lost or rewrote the existing hide choice.");

        Reset("1.4.0", nextHidden: false);
        UpdateAnnouncement.Show(owner, force: true);
        Check(UpdateAnnouncementForm.InitialHidden && AppPreferences.Writes.SequenceEqual(new string?[] { null }),
            "Unchecking the hide choice during manual replay did not clear it.");

        Reset("1.4.0", nextHidden: true);
        UpdateAnnouncement.Show(owner, preview: true);
        Check(UpdateAnnouncementForm.Shown == 1 && !UpdateAnnouncementForm.InitialHidden
            && AppPreferences.Reads == 0 && AppPreferences.Writes.Count == 0,
            "Preview read or changed saved preferences.");

        Reset("1.3.2");
        UpdateAnnouncement.Show(owner);
        Check(UpdateAnnouncementForm.Shown == 1 && !UpdateAnnouncementForm.InitialHidden
            && AppPreferences.Writes.Count == 0, "An older acknowledgement skipped the announcement or was changed without consent.");
        Check(!owner.Visible && !owner.IsHandleCreated && AppLogger.Errors.Count == 0,
            "The probe showed a real window or the production code swallowed an error.");
        Console.WriteLine("PASS: installed version, preserved announcement, acknowledgement, manual replay, preview isolation");
    }
}

namespace BrowserThumbnailPrototype
{
    internal static class AppPreferences
    {
        internal static string? Acknowledged;
        internal static int Reads;
        internal static List<string?> Writes { get; } = new();
        internal static string? GetLastAcknowledgedUpdateVersion() { Reads++; return Acknowledged; }
        internal static void SetLastAcknowledgedUpdateVersion(string? value) { Writes.Add(value); Acknowledged = value; }
    }

    internal static class AppLogger
    {
        internal static List<Exception> Errors { get; } = new();
        internal static void Error(string category, string message, Exception error) => Errors.Add(error);
    }

    internal sealed class UpdateAnnouncementForm(bool showSettingsButton) : IDisposable
    {
        internal static int Shown;
        internal static bool InitialHidden;
        internal static bool? NextHidden;
        internal static bool NextOpenSettings;
        public bool TopMost { get; set; }
        public bool DoNotShowAgain { get; set; }
        public bool OpenSettingsRequested { get; private set; }
        public DialogResult ShowDialog(Form owner)
        {
            Shown++;
            InitialHidden = DoNotShowAgain;
            if (NextHidden.HasValue) DoNotShowAgain = NextHidden.Value;
            OpenSettingsRequested = showSettingsButton && NextOpenSettings;
            return DialogResult.OK;
        }
        public void Dispose() { }
    }
}
`;
