using Microsoft.Win32;

namespace BrowserThumbnailPrototype;

/// <summary>
/// 현재 사용자 영역에 oneclickportal:// 주소 처리기를 등록합니다.
/// </summary>
internal static class UriSchemeRegistrar
{
    private const string ClassesKeyPath = @"Software\Classes";
    private const string SchemeDescription = "URL:원클릭업무포털 프로토콜";

    public static void EnsureRegistered()
    {
        var launcherPath = ResolveLauncherPath();
        if (string.IsNullOrWhiteSpace(launcherPath) || !File.Exists(launcherPath))
        {
            AppLogger.Info("UriScheme", "실행 파일을 찾지 못해 주소 등록을 건너뜁니다.");
            return;
        }

        var expectedCommand = $"\"{launcherPath}\" \"%1\"";
        if (IsAlreadyRegistered(expectedCommand))
        {
            return;
        }

        using var schemeKey = Registry.CurrentUser.CreateSubKey(
            $@"{ClassesKeyPath}\{PortalTaskRequest.UriScheme}",
            writable: true);
        if (schemeKey is null)
        {
            AppLogger.Info("UriScheme", "주소 등록에 필요한 레지스트리 키를 만들지 못했습니다.");
            return;
        }

        schemeKey.SetValue(null, SchemeDescription, RegistryValueKind.String);
        schemeKey.SetValue("URL Protocol", string.Empty, RegistryValueKind.String);
        using (var iconKey = schemeKey.CreateSubKey("DefaultIcon", writable: true))
        {
            iconKey?.SetValue(null, $"\"{launcherPath}\",0", RegistryValueKind.String);
        }

        using (var commandKey = schemeKey.CreateSubKey(@"shell\open\command", writable: true))
        {
            commandKey?.SetValue(null, expectedCommand, RegistryValueKind.String);
        }

        AppLogger.Info("UriScheme", $"{PortalTaskRequest.UriScheme}:// 주소를 등록했습니다.");
    }

    private static bool IsAlreadyRegistered(string expectedCommand)
    {
        try
        {
            using var commandKey = Registry.CurrentUser.OpenSubKey(
                $@"{ClassesKeyPath}\{PortalTaskRequest.UriScheme}\shell\open\command",
                writable: false);
            return commandKey?.GetValue(null) is string current
                && string.Equals(current, expectedCommand, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception)
        {
            AppLogger.Error("UriScheme", "기존 주소 등록을 확인하지 못했습니다.", exception);
            return false;
        }
    }

    private static string ResolveLauncherPath()
    {
        var currentExecutable = Application.ExecutablePath;
        var currentDirectory = Path.GetDirectoryName(currentExecutable);
        if (currentDirectory is not null
            && string.Equals(Path.GetFileName(currentDirectory), "current", StringComparison.OrdinalIgnoreCase))
        {
            var installRoot = Path.GetDirectoryName(currentDirectory);
            if (installRoot is not null)
            {
                var stubPath = Path.Combine(installRoot, Path.GetFileName(currentExecutable));
                if (File.Exists(stubPath))
                {
                    return stubPath;
                }
            }
        }

        return currentExecutable;
    }
}
