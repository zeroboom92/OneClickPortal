using System.Reflection;

namespace BrowserThumbnailPrototype;

internal static class UpdateAnnouncement
{
    // Maintenance releases keep the existing announcement and its saved choice.
    public static string Title => UpdateHistory.Current.Title;
    public static string Summary => UpdateHistory.Current.Summary;
    public static string AnnouncementVersion => UpdateHistory.Current.Version;
    public static string CurrentVersion => typeof(UpdateAnnouncement).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+', 2)[0]
        ?? typeof(UpdateAnnouncement).Assembly.GetName().Version?.ToString(3) ?? "1.4.2";

    public static bool ShouldShow(string? acknowledgedVersion) =>
        !string.Equals(acknowledgedVersion, AnnouncementVersion, StringComparison.Ordinal);

    // Manual replays can change the user's choice; previews never change saved preferences.
    public static bool Show(Form owner, bool force = false, bool showSettingsButton = true, bool preview = false)
    {
        if (owner.IsDisposed || owner.Disposing) return false;
        try
        {
            var alreadyHidden = !preview && !ShouldShow(AppPreferences.GetLastAcknowledgedUpdateVersion());
            if (!force && !preview && alreadyHidden) return false;
            using var dialog = new UpdateAnnouncementForm(showSettingsButton)
            {
                TopMost = owner.TopMost,
                DoNotShowAgain = alreadyHidden,
            };
            var result = dialog.ShowDialog(owner);
            if (!preview && dialog.DoNotShowAgain != alreadyHidden)
            {
                try
                {
                    AppPreferences.SetLastAcknowledgedUpdateVersion(dialog.DoNotShowAgain ? AnnouncementVersion : null);
                }
                catch (Exception exception)
                {
                    AppLogger.Error("Update", "업데이트 안내 표시 설정 저장 실패", exception);
                }
            }
            return result == DialogResult.OK && dialog.OpenSettingsRequested;
        }
        catch (Exception exception)
        {
            AppLogger.Error("Update", "업데이트 안내 표시 실패", exception);
            return false;
        }
    }
}
