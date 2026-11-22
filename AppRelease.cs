using System.Reflection;

namespace BrowserThumbnailPrototype;

/// <summary>
/// Build-time identity of the installed channel. Beta keeps its settings, history,
/// logs and updates separate while intentionally reusing the portal browser profile.
/// </summary>
internal static class AppRelease
{
    public static bool IsBeta
    {
        get
        {
#if PORTAL_BETA
            return true;
#else
            return false;
#endif
        }
    }

    public static string Channel => IsBeta ? "beta" : "stable";
    public static string PackageId => IsBeta ? "OneClickPortalBeta" : "OneClickPortal";
    public static string AppName => IsBeta ? "원클릭업무포털 베타" : "원클릭업무포털";
    public static string ExecutableName => IsBeta ? "OneClickPortal.Beta.exe" : "OneClickPortal.exe";
    public static string SettingsKeyPath => IsBeta ? @"Software\OneClickPortalBeta" : @"Software\OneClickPortal";
    public static string DataDirectoryName => PackageId;
    public static string UpdateChannel => IsBeta ? "win-beta" : "win";
    public static bool IncludePrereleases => IsBeta;

    public static string DisplayVersion =>
        (typeof(AppRelease).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            ?? typeof(AppRelease).Assembly.GetName().Version?.ToString(3)
            ?? string.Empty).Split('+', 2)[0];
}
