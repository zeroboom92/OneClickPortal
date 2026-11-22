import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('Nice approval menu defaults off, persists only explicit opt-in and stays reachable in the actual settings form',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-nice-approval-settings-'));
    try {
      const keyRoot = `Software\\OneClickPortal.Tests\\NiceApprovalSettings-${randomUUID()}`;
      const source = await readFile(join(root, 'AppPreferences.cs'), 'utf8');
      const originalSettings = 'private const string SettingsKeyPath = @"Software\\OneClickPortal";';
      const originalRun = 'private const string RunKeyPath = @"Software\\Microsoft\\Windows\\CurrentVersion\\Run";';
      assert.equal(source.split(originalSettings).length, 2);
      assert.equal(source.split(originalRun).length, 2);
      await writeFile(join(directory, 'AppPreferences.cs'), source
        .replace(originalSettings, `private const string SettingsKeyPath = @"${keyRoot}\\Settings";`)
        .replace(originalRun, `private const string RunKeyPath = @"${keyRoot}\\Run";`));
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>${['SettingsForm.cs', 'DisplayModePreview.cs', 'EducationOffice.cs', 'BrowserSupport.cs']
          .map(name => `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('')}</ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe.replace('/* TEST_KEY_ROOT */', keyRoot));
      const result = await run('dotnet', ['run', '--project', project, '--configuration', 'Release', '--nologo'],
        { timeout: 100_000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /PASS: missing and invalid default off, explicit on and off persist, isolated registry, actual opt-in checkbox, no form persistence, scaled layout, scrollable save and cancel/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-nice-approval-settings-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using Microsoft.Win32;
using System.Reflection;
using System.Text.Json;

internal static class Program
{
    private const string TestKeyRoot = @"/* TEST_KEY_ROOT */";
    private const string TestSettings = TestKeyRoot + @"\Settings";
    private const string MenuValue = "NiceApprovalMenuEnabled";
    private static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
    private static IEnumerable<Control> Descendants(Control parent)
    {
        foreach (Control child in parent.Controls)
        {
            yield return child;
            foreach (var descendant in Descendants(child)) yield return descendant;
        }
    }
    private static string RealValueSnapshot()
    {
        using var key = Registry.CurrentUser.OpenSubKey(@"Software\OneClickPortal", writable: false);
        if (key is null) return "KEY-MISSING";
        if (!key.GetValueNames().Contains(MenuValue, StringComparer.OrdinalIgnoreCase)) return "VALUE-MISSING";
        return JsonSerializer.Serialize(new { Kind = key.GetValueKind(MenuValue), Value = key.GetValue(MenuValue) });
    }
    private static SettingsForm DefaultForm() => new(false, true, false, false,
        EducationOfficeCatalog.Default.Code, 85, PortalDisplayMode.FloatingWindow);

    [STAThread]
    private static void Main()
    {
        var realBefore = RealValueSnapshot();
        try
        {
            Check(typeof(AppPreferences).GetField("SettingsKeyPath", BindingFlags.NonPublic | BindingFlags.Static)!.GetRawConstantValue() as string == TestSettings,
                "Preference probe was not isolated from real application settings.");
            Check(!AppPreferences.IsNiceApprovalMenuEnabled(), "Missing settings must keep the existing direct Edufine behavior.");
            using (var missing = Registry.CurrentUser.OpenSubKey(TestSettings, writable: false))
                Check(missing is null, "Reading the default unexpectedly created settings.");
            using (var key = Registry.CurrentUser.CreateSubKey(TestSettings, writable: true))
            {
                key.SetValue("ExistingSetting", "PRESERVE", RegistryValueKind.String);
                Check(!AppPreferences.IsNiceApprovalMenuEnabled(), "Missing menu value did not default off.");
                foreach (var invalid in new (object Value, RegistryValueKind Kind)[]
                {
                    (2, RegistryValueKind.DWord), (-1, RegistryValueKind.DWord),
                    ("1", RegistryValueKind.String), (1L, RegistryValueKind.QWord),
                    (new byte[] { 1 }, RegistryValueKind.Binary), (new string[] { "1" }, RegistryValueKind.MultiString),
                })
                {
                    key.SetValue(MenuValue, invalid.Value, invalid.Kind);
                    Check(!AppPreferences.IsNiceApprovalMenuEnabled(), "Invalid menu setting enabled the feature.");
                }
            }
            foreach (var enabled in new[] { true, false, true })
            {
                AppPreferences.SetNiceApprovalMenuEnabled(enabled);
                Check(AppPreferences.IsNiceApprovalMenuEnabled() == enabled, "Explicit menu choice failed to persist.");
                using var key = Registry.CurrentUser.OpenSubKey(TestSettings, writable: false)!;
                Check(key.GetValueKind(MenuValue) == RegistryValueKind.DWord
                    && key.GetValue(MenuValue) is int stored && stored == (enabled ? 1 : 0)
                    && key.GetValue("ExistingSetting") as string == "PRESERVE",
                    "Menu persistence changed another setting or stored an incompatible value.");
            }

            AppPreferences.SetNiceApprovalMenuEnabled(false);
            using (var defaults = DefaultForm())
            {
                _ = defaults.Handle;
                var controls = Descendants(defaults).ToArray();
                var option = controls.OfType<CheckBox>().Single(control => control.Text == "나이스 결재 선택 메뉴 사용");
                var description = controls.OfType<Label>().Single(control => control.Text == "결재 버튼에서 에듀파인·나이스를 선택합니다.");
                Check(!defaults.NiceApprovalMenuEnabled && !option.Checked,
                    "The existing constructor unexpectedly opts users into the choice menu.");
                Check(option.AccessibleName == option.Text && option.AccessibleDescription == description.Text,
                    "The checkbox lacks an accessible name or explanation.");
                Check(defaults.WindowsStartupEnabled == false && defaults.PortalAutoRefreshEnabled
                    && !defaults.UsageTelemetryEnabled && !defaults.AlwaysOnTopEnabled
                    && defaults.DisplayMode == PortalDisplayMode.FloatingWindow
                    && defaults.WindowOpacityPercent == 85 && defaults.LoginBrowser == PortalBrowser.Edge,
                    "Adding the menu option changed existing constructor choices.");
                Check(option.Parent!.ClientRectangle.Contains(option.Bounds)
                    && description.Parent!.ClientRectangle.Contains(description.Bounds)
                    && option.Bottom <= description.Top
                    && description.GetPreferredSize(new Size(description.Width, 0)).Height <= description.Height,
                    $"The checkbox or its explanation is clipped or overlaps another control: option={option.Bounds}, description={description.Bounds}, panel={option.Parent.ClientRectangle}, preferred={description.GetPreferredSize(new Size(description.Width, 0))}.");
                var opacity = controls.OfType<TrackBar>().Single();
                Check(option.Parent.Bottom < opacity.Top, "The added option overlaps the opacity controls.");
                Check(defaults.Controls.Cast<Control>().All(control => defaults.ClientRectangle.Contains(control.Bounds)),
                    "The full settings content extends below the normal client area.");
                option.Checked = true;
                Check(defaults.NiceApprovalMenuEnabled, "The settings property did not reflect a user's checkbox change.");
                defaults.DialogResult = DialogResult.Cancel;
                Check(!AppPreferences.IsNiceApprovalMenuEnabled(), "Canceling the form changed persisted preferences.");
            }
            AppPreferences.SetNiceApprovalMenuEnabled(false);
            using (var enabledForm = new SettingsForm(false, true, false, false,
                EducationOfficeCatalog.Default.Code, 85, PortalDisplayMode.TopDock,
                PortalBrowser.Chrome, niceApprovalMenuEnabled: true))
            {
                _ = enabledForm.Handle;
                Check(enabledForm.NiceApprovalMenuEnabled && enabledForm.LoginBrowser == PortalBrowser.Chrome,
                    "The explicit opt-in constructor or prior browser option was not restored.");
                enabledForm.DialogResult = DialogResult.OK;
                Check(!AppPreferences.IsNiceApprovalMenuEnabled(), "The settings form wrote preferences before its owner accepted the result.");
            }

            foreach (var scale in new[] { 1.5F, 2F })
            {
                using var scaled = DefaultForm();
                _ = scaled.Handle;
                scaled.Scale(new SizeF(scale, scale));
                scaled.PerformLayout();
                var controls = Descendants(scaled).ToArray();
                var option = controls.OfType<CheckBox>().Single(control => control.Text == "나이스 결재 선택 메뉴 사용");
                var description = controls.OfType<Label>().Single(control => control.Text == "결재 버튼에서 에듀파인·나이스를 선택합니다.");
                Check(option.Parent!.ClientRectangle.Contains(option.Bounds)
                    && description.Parent!.ClientRectangle.Contains(description.Bounds) && option.Bottom <= description.Top,
                    "The scaled option is clipped or overlaps its explanation.");
                typeof(SettingsForm).GetMethod("FitWithinWorkingArea", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(scaled, null);
                scaled.PerformLayout();
                var workingArea = Screen.FromControl(scaled).WorkingArea;
                Check(scaled.Height <= workingArea.Height && scaled.AutoScroll,
                    "The scaled settings window extends beyond the working area or cannot scroll.");
                if (scaled.AutoScrollMinSize.Height > scaled.ClientSize.Height)
                {
                    // A hidden form has no interactive scroll position. Verify the real
                    // scroll range covers the complete page without showing or focusing it.
                    var maximumScroll = scaled.AutoScrollMinSize.Height - scaled.ClientSize.Height;
                    Check(scaled.VerticalScroll.Visible
                        && scaled.VerticalScroll.Maximum - scaled.VerticalScroll.LargeChange + 1 >= maximumScroll,
                        "The scaled form did not expose enough vertical scroll range.");
                    foreach (var button in controls.OfType<Button>().Where(button => button.DialogResult is DialogResult.OK or DialogResult.Cancel))
                        Check(button.Top - maximumScroll >= 0 && button.Bottom - maximumScroll <= scaled.ClientSize.Height,
                            $"Save or cancel is outside the scaled settings scroll range: scale={scale}, button={button.Bounds}, client={scaled.ClientSize}, minimum={scaled.AutoScrollMinSize}.");
                }
            }
            Check(RealValueSnapshot() == realBefore, "Settings probe modified the real application preference.");
            Console.WriteLine("PASS: missing and invalid default off, explicit on and off persist, isolated registry, actual opt-in checkbox, no form persistence, scaled layout, scrollable save and cancel");
        }
        finally
        {
            Check(TestKeyRoot.StartsWith(@"Software\OneClickPortal.Tests\NiceApprovalSettings-", StringComparison.Ordinal)
                && Guid.TryParse(TestKeyRoot.Split('\\')[^1]["NiceApprovalSettings-".Length..], out _),
                "Unsafe registry probe cleanup key.");
            Registry.CurrentUser.DeleteSubKeyTree(TestKeyRoot, throwOnMissingSubKey: false);
            Check(RealValueSnapshot() == realBefore, "Registry cleanup modified real application settings.");
        }
    }
}

namespace BrowserThumbnailPrototype
{
    internal sealed record UsageSummary(int ActiveUsers);
    internal static class UsageTelemetry { public static Task<UsageSummary?> GetUsageSummaryAsync() => Task.FromResult<UsageSummary?>(null); }
    internal static class UpdateAnnouncement
    {
        public static string CurrentVersion => "TEST";
        public static void Show(IWin32Window owner, bool force, bool showSettingsButton) { }
    }
}
`;
