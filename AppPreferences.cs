using Microsoft.Win32;

namespace BrowserThumbnailPrototype;

internal static class AppPreferences
{
    private const string ApplicationName = "OneClickPortal";
    private const string SettingsKeyPath = @"Software\OneClickPortal";
    private const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string AutoRefreshValueName = "PortalAutoRefresh";
    private const string WindowOpacityValueName = "WindowOpacityPercent";
    private const string WindowLeftValueName = "WindowLeft";
    private const string WindowTopValueName = "WindowTop";
    private const string UsageTelemetryValueName = "UsageTelemetry";
    private const string AnonymousInstallationIdValueName = "AnonymousInstallationId";
    private const string LastUsageReportDateValueName = "LastUsageReportDateUtc";
    private const string LastPresenceReportValueName = "LastPresenceReportUtc";
    private const string EducationOfficeValueName = "EducationOfficeCode";
    private const string AlwaysOnTopValueName = "AlwaysOnTop";

    public static bool IsWindowsStartupEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        return key?.GetValue(ApplicationName) is string value && !string.IsNullOrWhiteSpace(value);
    }

    public static void SetWindowsStartupEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true)
            ?? throw new InvalidOperationException("Windows 시작 프로그램 설정을 열지 못했습니다.");
        if (enabled)
        {
            key.SetValue(ApplicationName, $"\"{Application.ExecutablePath}\"", RegistryValueKind.String);
        }
        else
        {
            key.DeleteValue(ApplicationName, throwOnMissingValue: false);
        }
    }

    public static bool IsPortalAutoRefreshEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        return key?.GetValue(AutoRefreshValueName) is not int value || value != 0;
    }

    public static void SetPortalAutoRefreshEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("업무포털 설정을 저장하지 못했습니다.");
        key.SetValue(AutoRefreshValueName, enabled ? 1 : 0, RegistryValueKind.DWord);
    }

    public static bool IsUsageTelemetryEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        return key?.GetValue(UsageTelemetryValueName) is not int value || value != 0;
    }

    public static void SetUsageTelemetryEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("사용 통계 설정을 저장하지 못했습니다.");
        key.SetValue(UsageTelemetryValueName, enabled ? 1 : 0, RegistryValueKind.DWord);
    }

    public static string GetEducationOfficeCode()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        var value = key?.GetValue(EducationOfficeValueName) as string;
        return EducationOfficeCatalog.GetByCode(value).Code;
    }

    public static void SetEducationOfficeCode(string code)
    {
        var educationOffice = EducationOfficeCatalog.GetByCode(code);
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("소속 교육청 설정을 저장하지 못했습니다.");
        key.SetValue(EducationOfficeValueName, educationOffice.Code, RegistryValueKind.String);
    }

    public static bool IsAlwaysOnTopEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        return key?.GetValue(AlwaysOnTopValueName) is int value && value != 0;
    }

    public static void SetAlwaysOnTopEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("항상 위에 표시 설정을 저장하지 못했습니다.");
        key.SetValue(AlwaysOnTopValueName, enabled ? 1 : 0, RegistryValueKind.DWord);
    }

    public static string GetOrCreateAnonymousInstallationId()
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("익명 설치 식별자를 저장하지 못했습니다.");
        if (key.GetValue(AnonymousInstallationIdValueName) is string existing
            && Guid.TryParseExact(existing, "N", out _))
        {
            return existing;
        }

        var installationId = Guid.NewGuid().ToString("N");
        key.SetValue(AnonymousInstallationIdValueName, installationId, RegistryValueKind.String);
        return installationId;
    }

    public static DateOnly? GetLastUsageReportDateUtc()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        return key?.GetValue(LastUsageReportDateValueName) is string value
            && DateOnly.TryParseExact(value, "yyyy-MM-dd", out var date)
                ? date
                : null;
    }

    public static void SetLastUsageReportDateUtc(DateOnly date)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("사용 통계 전송 기록을 저장하지 못했습니다.");
        key.SetValue(LastUsageReportDateValueName, date.ToString("yyyy-MM-dd"), RegistryValueKind.String);
    }

    public static DateTimeOffset? GetLastPresenceReportUtc()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        return key?.GetValue(LastPresenceReportValueName) is string value
            && DateTimeOffset.TryParseExact(
                value,
                "O",
                System.Globalization.CultureInfo.InvariantCulture,
                System.Globalization.DateTimeStyles.RoundtripKind,
                out var timestamp)
                ? timestamp
                : null;
    }

    public static void SetLastPresenceReportUtc(DateTimeOffset timestamp)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("현재 사용자 신호 기록을 저장하지 못했습니다.");
        key.SetValue(LastPresenceReportValueName, timestamp.ToUniversalTime().ToString("O"), RegistryValueKind.String);
    }

    public static int GetWindowOpacityPercent()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        var value = key?.GetValue(WindowOpacityValueName);
        if (value is int percent)
        {
            return Math.Clamp(percent, 70, 100);
        }

        return 100;
    }

    public static void SetWindowOpacityPercent(int percent)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("프로그램 설정을 저장하지 못했습니다.");
        key.SetValue(WindowOpacityValueName, Math.Clamp(percent, 70, 100), RegistryValueKind.DWord);
    }

    public static Point? GetWindowLocation()
    {
        using var key = Registry.CurrentUser.OpenSubKey(SettingsKeyPath, writable: false);
        var left = key?.GetValue(WindowLeftValueName);
        var top = key?.GetValue(WindowTopValueName);
        if (left is int x && top is int y)
        {
            return new Point(x, y);
        }

        return null;
    }

    public static void SetWindowLocation(Point location)
    {
        using var key = Registry.CurrentUser.CreateSubKey(SettingsKeyPath, writable: true)
            ?? throw new InvalidOperationException("프로그램 위치를 저장하지 못했습니다.");
        key.SetValue(WindowLeftValueName, location.X, RegistryValueKind.DWord);
        key.SetValue(WindowTopValueName, location.Y, RegistryValueKind.DWord);
    }
}
