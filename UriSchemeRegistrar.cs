using Microsoft.Win32;

namespace BrowserThumbnailPrototype;

/// <summary>
/// <c>oneclickportal://</c> 주소를 이 프로그램이 처리하도록 윈도우에 등록합니다.
///
/// 관리자 권한이 필요 없도록 현재 사용자 영역(HKEY_CURRENT_USER)에만 씁니다.
/// 이렇게 등록해 두면 다른 프로그램이나 바탕화면 바로가기에서
/// <c>oneclickportal://leave</c> 같은 주소로 업무 화면 이동을 요청할 수 있습니다.
/// </summary>
internal static class UriSchemeRegistrar
{
    private const string ClassesKeyPath = @"Software\Classes";
    private const string SchemeDescription = "URL:원클릭업무포털 프로토콜";

    /// <summary>
    /// 등록이 안 되어 있거나 실행 경로가 바뀌었으면 다시 등록합니다.
    /// 이미 같은 내용이면 아무것도 쓰지 않습니다.
    /// </summary>
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
            $@"{ClassesKeyPath}\{PortalTaskRequest.UriScheme}", writable: true);
        if (schemeKey is null)
        {
            AppLogger.Info("UriScheme", "주소 등록에 필요한 키를 만들지 못했습니다.");
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
                $@"{ClassesKeyPath}\{PortalTaskRequest.UriScheme}\shell\open\command", writable: false);
            return commandKey?.GetValue(null) is string current
                && string.Equals(current, expectedCommand, StringComparison.OrdinalIgnoreCase);
        }
        catch (Exception exception)
        {
            AppLogger.Error("UriScheme", "기존 주소 등록을 확인하지 못했습니다.", exception);
            return false;
        }
    }

    /// <summary>
    /// 주소를 열었을 때 실행할 파일을 고릅니다.
    ///
    /// 설치본은 버전이 바뀔 때마다 <c>current</c> 폴더가 통째로 교체되므로,
    /// 그 위에 있는 고정 실행 파일(스텁)을 우선 등록합니다.
    /// 개발 중 <c>dotnet run</c>으로 띄운 경우처럼 스텁이 없으면 현재 실행 파일을 씁니다.
    /// </summary>
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
