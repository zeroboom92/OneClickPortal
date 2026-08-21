using System;
using System.Windows.Forms;
using Velopack;

namespace BrowserThumbnailPrototype;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        VelopackApp.Build().Run();
        ApplicationConfiguration.Initialize();

        // 외부에서 넘어온 업무 요청입니다. 없으면 평소처럼 창만 띄웁니다.
        var requestedTask = PortalTaskRequest.Parse(args);

        // 이미 창이 떠 있으면 새로 띄우지 않고 그 창으로 요청만 넘깁니다.
        if (!SingleInstanceCoordinator.TryAcquire(out var singleInstance))
        {
            if (SingleInstanceCoordinator.TrySendToRunningInstance(requestedTask))
            {
                return;
            }

            // 전달하지 못했다면(예: 앞선 창이 응답하지 않음) 사용자가 아무것도 못 하게 되므로
            // 평소처럼 실행을 이어갑니다.
            AppLogger.Info("SingleInstance", "실행 중인 창에 전달하지 못해 새로 실행합니다.");
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

        // 중간에 오류가 나더라도 중복 실행 잠금이 남지 않도록 using 으로 감쌉니다.
        using (singleInstance)
        {
            using var mainForm = new MainForm();

            // 파이프를 읽는 백그라운드 스레드에서 호출되므로, 창 쪽에서 UI 스레드로 옮깁니다.
            singleInstance?.StartListening(mainForm.RequestPortalTask);

            mainForm.Shown += async (_, _) =>
            {
                UsageTelemetry.Start();
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
