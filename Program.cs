using System;
using System.Windows.Forms;
using Velopack;

namespace BrowserThumbnailPrototype;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Preview alongside an installed copy without updater/startup/URI registration.
        var updatePreview = args.Contains("--update-preview", StringComparer.OrdinalIgnoreCase);
        if (updatePreview || args.Contains("--dock-preview", StringComparer.OrdinalIgnoreCase))
        {
            ApplicationConfiguration.Initialize();
            using var preview = new MainForm { Text = "원클릭 업무포털 · 테스트" };
            if (updatePreview)
                preview.Shown += (_, _) => preview.ShowUpdateAnnouncement(force: true);
            Application.Run(preview);
            return;
        }
        VelopackApp.Build().Run();
        ApplicationConfiguration.Initialize();

        var requestedTask = PortalTaskRequest.Parse(args);
        if (!SingleInstanceCoordinator.TryAcquire(out var singleInstance))
        {
            if (SingleInstanceCoordinator.TrySendToRunningInstance(requestedTask))
            {
                return;
            }

            AppLogger.Info("SingleInstance", "실행 중인 창에 외부 요청을 전달하지 못해 새로 실행합니다.");
        }

        try
        {
            AppPreferences.ApplyWindowsStartupPreference();
        }
        catch (Exception exception)
        {
            AppLogger.Error("Preferences", "Windows 시작 시 자동 실행 기본값 적용 실패", exception);
        }

        try
        {
            UriSchemeRegistrar.EnsureRegistered();
        }
        catch (Exception exception)
        {
            AppLogger.Error("UriScheme", "oneclickportal:// 주소 등록 실패", exception);
        }

        using (singleInstance)
        {
            using var mainForm = new MainForm();
            singleInstance?.StartListening(mainForm.RequestPortalTask);
            mainForm.Shown += async (_, _) =>
            {
                UsageTelemetry.Start();
                mainForm.ShowUpdateAnnouncement();
                await AppUpdater.CheckForUpdatesAsync();
                if (requestedTask is not null)
                {
                    mainForm.RequestPortalTask(requestedTask);
                }
            };
            mainForm.Show();
            Application.Run(mainForm);
            UsageTelemetry.Stop();
        }
    }
}
