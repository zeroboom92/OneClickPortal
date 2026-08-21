namespace BrowserThumbnailPrototype;

/// <summary>
/// 외부에서 들어온 업무 실행 요청을 해석합니다.
///
/// 지원 형식
///   OneClickPortal.exe --task=leave
///   OneClickPortal.exe oneclickportal://leave
///
/// 해석에 실패하면 <c>null</c>을 돌려주며, 이때는 평소처럼 프로그램만 실행됩니다.
/// Velopack이 넘기는 설치·업데이트 인자처럼 모르는 인자는 조용히 무시합니다.
/// </summary>
internal static class PortalTaskRequest
{
    public const string UriScheme = "oneclickportal";

    private const string TaskOptionPrefix = "--task=";

    public static PortalTaskKind? Parse(IReadOnlyList<string>? args)
    {
        if (args is null)
        {
            return null;
        }

        foreach (var argument in args)
        {
            if (string.IsNullOrWhiteSpace(argument))
            {
                continue;
            }

            var candidate = argument.Trim();

            if (candidate.StartsWith(TaskOptionPrefix, StringComparison.OrdinalIgnoreCase))
            {
                var name = candidate[TaskOptionPrefix.Length..];
                if (PortalTaskCatalog.TryGetByExternalName(name, out var optionKind))
                {
                    return optionKind;
                }

                continue;
            }

            if (TryParseUri(candidate, out var uriKind))
            {
                return uriKind;
            }
        }

        return null;
    }

    /// <summary>
    /// <c>oneclickportal://leave</c> 형태를 해석합니다.
    /// 브라우저나 탐색기가 뒤에 슬래시를 붙여 <c>oneclickportal://leave/</c>로 넘기는 경우도 처리합니다.
    /// </summary>
    private static bool TryParseUri(string candidate, out PortalTaskKind kind)
    {
        kind = default;

        if (!candidate.StartsWith($"{UriScheme}:", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        if (!Uri.TryCreate(candidate, UriKind.Absolute, out var uri))
        {
            return false;
        }

        // oneclickportal://leave 는 Host 에, oneclickportal:leave 는 경로에 이름이 담깁니다.
        var name = string.IsNullOrEmpty(uri.Host)
            ? uri.AbsolutePath
            : uri.Host;

        return PortalTaskCatalog.TryGetByExternalName(name.Trim('/'), out kind);
    }
}
