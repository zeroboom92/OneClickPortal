using System;
using System.Windows.Forms;
using Velopack;

namespace BrowserThumbnailPrototype;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        VelopackApp.Build().Run();
        ApplicationConfiguration.Initialize();
        try
        {
            AppPreferences.ApplyWindowsStartupPreference();
        }
        catch (Exception exception)
        {
            AppLogger.Error("Preferences", "Windows 시작 시 자동 실행 기본값 적용 실패", exception);
        }

        using var mainForm = new MainForm();
        mainForm.Shown += async (_, _) =>
        {
            UsageTelemetry.Start();
            await AppUpdater.CheckForUpdatesAsync();
        };
        mainForm.Show();
        Application.Run(mainForm);
        UsageTelemetry.Stop();
    }
}
