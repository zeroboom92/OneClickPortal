using System.Reflection;

namespace BrowserThumbnailPrototype;

internal static class UpdateAnnouncement
{
    // Keep the current history entry, release notes and native preview aligned.
    public static string Title => UpdateHistory.Current.Title;
    public static string Summary => UpdateHistory.Current.Summary;
    public static string CurrentVersion => typeof(UpdateAnnouncement).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+', 2)[0]
        ?? typeof(UpdateAnnouncement).Assembly.GetName().Version?.ToString(3) ?? "1.3.1";

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
