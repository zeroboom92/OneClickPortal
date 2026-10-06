using System.Reflection;

namespace BrowserThumbnailPrototype;

internal static class UpdateAnnouncement
{
    // Update these release notes and the embedded artwork when preparing the next version.
    public const string Title = "표시 방식을 직접 고를 수 있어요";
    public const string Summary = "설정에서 미리보기를 보고 상단 숨김 또는 별도 창을 선택하세요.\n선택한 방식은 다음 실행에도 유지됩니다.";
    public const string ArtworkResourceName = "OneClickPortal.Update.DisplayModes";
    public static string CurrentVersion => typeof(UpdateAnnouncement).Assembly
        .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion.Split('+', 2)[0]
        ?? typeof(UpdateAnnouncement).Assembly.GetName().Version?.ToString(3) ?? "1.1.1";

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
