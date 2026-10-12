using System.Reflection;

namespace BrowserThumbnailPrototype;

internal static class UpdateAnnouncement
{
    // Keep the release notes and native feature preview aligned with this release.
    public const string Title = "마우스로 펼치고, 배경은 투명하게";
    public const string Summary = "손잡이는 항상 보이고, 메뉴를 떠나면 2초 뒤 자동으로 접힙니다.\n로고로 위치를 옮기고, 설정에서 배경만 투명하게 조절해 보세요.";
    public static string CurrentVersion => typeof(UpdateAnnouncement).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+', 2)[0]
        ?? typeof(UpdateAnnouncement).Assembly.GetName().Version?.ToString(3) ?? "1.2.1";

    public static bool ShouldShow(string? acknowledgedVersion) =>
        !string.Equals(acknowledgedVersion, CurrentVersion, StringComparison.Ordinal);

    // Manual replays and previews do not consume the first-run announcement.
    public static bool Show(Form owner, bool force = false, bool showSettingsButton = true)
    {
        if (owner.IsDisposed || owner.Disposing) return false;
        try
        {
            if (!force && !ShouldShow(AppPreferences.GetLastAcknowledgedUpdateVersion())) return false;
            using var dialog = new UpdateAnnouncementForm(showSettingsButton)
            {
                TopMost = owner.TopMost,
            };
            if (dialog.ShowDialog(owner) != DialogResult.OK) return false;
            if (!force)
            {
                try
                {
                    AppPreferences.SetLastAcknowledgedUpdateVersion(CurrentVersion);
                }
                catch (Exception exception)
                {
                    AppLogger.Error("Update", "업데이트 안내 확인 기록 저장 실패", exception);
                }
            }
            return dialog.OpenSettingsRequested;
        }
        catch (Exception exception)
        {
            AppLogger.Error("Update", "업데이트 안내 표시 실패", exception);
            return false;
        }
    }
}
