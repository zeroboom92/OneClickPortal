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
