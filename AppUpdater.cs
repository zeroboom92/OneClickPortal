using Velopack;
using Velopack.Sources;

namespace BrowserThumbnailPrototype;

internal static class AppUpdater
{
    private const string RepositoryUrl = "https://github.com/zeroboom92/OneClickPortal";

    public static async Task CheckForUpdatesAsync()
    {
        try
        {
            var source = new GithubSource(RepositoryUrl, accessToken: null, prerelease: false);
            var manager = new UpdateManager(source);

            if (!manager.IsInstalled)
            {
                AppLogger.Info("Update", "설치형 실행이 아니므로 자동 업데이트 확인을 건너뜁니다.");
                return;
            }

            var update = await manager.CheckForUpdatesAsync();
            if (update is null)
            {
                AppLogger.Info("Update", "현재 최신 버전입니다.");
                return;
            }

            AppLogger.Info("Update", $"새 버전 {update.TargetFullRelease.Version} 다운로드를 시작합니다.");
            await manager.DownloadUpdatesAsync(update);
            AppLogger.Info("Update", "업데이트를 적용하고 프로그램을 다시 시작합니다.");
            manager.ApplyUpdatesAndRestart(update);
        }
        catch (Exception exception)
        {
            AppLogger.Error("Update", "자동 업데이트 확인 실패", exception);
        }
    }
}
