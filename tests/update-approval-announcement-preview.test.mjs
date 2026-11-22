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

test('actual approval announcement renders its native artwork and retains distinct earlier illustrations and history',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-approval-announcement-preview-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><Version>1.4.6</Version><AssemblyVersion>1.4.6.0</AssemblyVersion><InformationalVersion>1.4.6</InformationalVersion></PropertyGroup>
        <ItemGroup>${['UpdateAnnouncement.cs', 'UpdateAnnouncementForm.cs', 'UpdateFeaturePreview.cs', 'UpdateHistory.cs', 'UpdateHistoryForm.cs']
          .map(name => `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('')}</ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', project, '--configuration', 'Release', '--nologo'],
        { timeout: 100_000, maxBuffer: 1024 * 1024 }).catch(error => {
          assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
        });
      assert.match(result.stdout, /PASS: native approval artwork, prior illustration variants, exact announcement text, default-off explanation, actual history selection, no preferences or visible windows/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-approval-announcement-preview-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
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
    private static string RenderDigest(UpdateFeaturePreview preview)
    {
        Check(preview.Size == new Size(532, 299), "Native announcement artwork changed its established canvas size.");
        using var bitmap = new Bitmap(preview.Width, preview.Height, PixelFormat.Format32bppArgb);
        preview.DrawToBitmap(bitmap, new Rectangle(Point.Empty, bitmap.Size));
        var data = bitmap.LockBits(new Rectangle(Point.Empty, bitmap.Size), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var bytes = new byte[Math.Abs(data.Stride) * data.Height];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);
            Check(bytes.Where((value, index) => index % 4 != 3 && value < 240).Count() > 10_000,
                "The native announcement artwork rendered blank or almost empty.");
            return Convert.ToHexString(SHA256.HashData(bytes));
        }
        finally { bitmap.UnlockBits(data); }
    }

    [STAThread]
    private static void Main()
    {
        using var current = new UpdateFeaturePreview();
        using var approval = new UpdateFeaturePreview("1.4.6");
        using var chrome = new UpdateFeaturePreview("1.4.3");
        using var reports = new UpdateFeaturePreview("1.4.0");
        Check(current.AccessibleName == "결재 알림을 더 편하게 확인하세요"
            && current.AccessibleRole == AccessibleRole.Graphic && !current.TabStop,
            "The default illustration does not describe the new approval announcement.");
        foreach (var explanation in new[] { "에듀파인", "나이스", "한 줄", "모두 확인", "기본으로 꺼져", "기본은 기존 에듀파인 바로가기" })
            Check(current.AccessibleDescription.Contains(explanation, StringComparison.Ordinal),
                "The artwork omits a key user-facing behavior: " + explanation);
        Check(chrome.AccessibleName == "크롬 또는 엣지로 로그인하고 연결하기"
            && reports.AccessibleName == "교외체험학습 보고서 미상신 알림",
            "An explicitly selected prior illustration now describes new content.");
        var currentDigest = RenderDigest(current);
        Check(currentDigest == RenderDigest(approval), "Default artwork does not render the latest release illustration.");
        var chromeDigest = RenderDigest(chrome);
        var reportsDigest = RenderDigest(reports);
        Check(currentDigest != chromeDigest && currentDigest != reportsDigest && chromeDigest != reportsDigest,
            "New artwork replaced an earlier illustration or versions no longer select distinct content.");

        using var announcement = new UpdateAnnouncementForm();
        _ = announcement.Handle;
        var controls = Descendants(announcement).ToArray();
        var title = controls.OfType<Label>().Single(label => label.Text == UpdateAnnouncement.Title);
        var summary = controls.OfType<Label>().Single(label => label.Text == UpdateAnnouncement.Summary);
        Check(UpdateAnnouncement.AnnouncementVersion == "1.4.6"
            && controls.OfType<Label>().Any(label => label.Text == "새로운 업데이트 · v1.4.6")
            && title.Text == "결재 알림을 더 편하게 확인하세요"
            && summary.Text == "나이스 결재대기도 알림으로 확인하세요.\n알림은 종류별로 모아 보고, 필요한 분만 결재 선택 메뉴를 켤 수 있습니다.",
            "The actual announcement form does not display the new reviewed version and text.");
        foreach (var label in new[] { title, summary })
            Check(label.GetPreferredSize(new Size(label.Width, 0)).Height <= label.Height,
                "Reviewed announcement text is clipped in the actual form: " + label.Text);
        Check(announcement.Controls.Cast<Control>().All(control => announcement.ClientRectangle.Contains(control.Bounds)),
            "The illustration, summary or footer extends beyond the announcement window.");
        var actualArtwork = controls.OfType<UpdateFeaturePreview>().Single();
        Check(RenderDigest(actualArtwork) == currentDigest, "The real announcement form uses a different artwork than the reviewed native preview.");
        Check(controls.OfType<Button>().Any(button => button.Text == "설정 열기")
            && controls.OfType<Button>().Any(button => button.Text == "이전 업데이트 보기"),
            "The announcement lost settings access or the preserved release-history action.");
        announcement.DoNotShowAgain = true;
        Check(announcement.DoNotShowAgain && AppPreferences.Reads == 0 && AppPreferences.Writes == 0,
            "Constructing or editing a preview directly changed saved acknowledgement settings.");
        using var noSettings = new UpdateAnnouncementForm(showSettingsButton: false);
        Check(!Descendants(noSettings).OfType<Button>().Any(button => button.Text == "설정 열기"),
            "The established no-settings preview mode gained an action it should hide.");

        using var history = new UpdateHistoryForm();
        _ = history.Handle;
        var historyControls = Descendants(history).ToArray();
        var versions = historyControls.OfType<ListBox>().Single();
        var details = historyControls.OfType<RichTextBox>().Single();
        Check(versions.Items.Count == 32 && versions.SelectedIndex == 1
            && ((UpdateRelease)versions.SelectedItem!).Version == "1.4.3"
            && details.Text.Contains("이제 크롬에서도 사용할 수 있어요", StringComparison.Ordinal),
            "The real history window lost prior entries or no longer opens on the preceding release.");
        versions.SelectedIndex = 0;
        Check(details.Text.Contains("v1.4.6", StringComparison.Ordinal)
            && details.Text.Contains(UpdateHistory.Current.Title, StringComparison.Ordinal)
            && UpdateHistory.Current.Changes.All(change => details.Text.Contains(change, StringComparison.Ordinal)),
            "The current announcement's full change details are not available from the real history window.");
        versions.SelectedIndex = 2;
        Check(((UpdateRelease)versions.SelectedItem!).Version == "1.4.0"
            && details.Text.Contains("미상신 보고서를 알려드려요", StringComparison.Ordinal),
            "Selecting the earlier report release no longer renders its content.");
        Check(!announcement.Visible && !noSettings.Visible && !history.Visible
            && AppPreferences.Reads == 0 && AppPreferences.Writes == 0 && AppLogger.Errors == 0,
            "The preview test showed a window, read or wrote user preferences, or swallowed a rendering error.");
        Console.WriteLine("PASS: native approval artwork, prior illustration variants, exact announcement text, default-off explanation, actual history selection, no preferences or visible windows");
    }
}

namespace BrowserThumbnailPrototype
{
    internal static class AppPreferences
    {
        public static int Reads;
        public static int Writes;
        public static string? GetLastAcknowledgedUpdateVersion() { Reads++; return null; }
        public static void SetLastAcknowledgedUpdateVersion(string? value) { Writes++; }
    }
    internal static class AppLogger
    {
        public static int Errors;
        public static void Error(string category, string message, Exception error) => Errors++;
    }
}
`;
