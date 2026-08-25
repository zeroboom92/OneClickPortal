namespace BrowserThumbnailPrototype;

/// <summary>
/// 명령줄 인자와 oneclickportal:// 주소를 업무 요청으로 변환합니다.
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
                if (PortalTaskCatalog.TryGetByExternalName(
                        candidate[TaskOptionPrefix.Length..],
                        out var commandKind))
                {
                    return commandKind;
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

    private static bool TryParseUri(string candidate, out PortalTaskKind kind)
    {
        kind = default;
        if (!candidate.StartsWith($"{UriScheme}:", StringComparison.OrdinalIgnoreCase)
            || !Uri.TryCreate(candidate, UriKind.Absolute, out var uri))
        {
            return false;
        }

        var name = string.IsNullOrEmpty(uri.Host) ? uri.AbsolutePath : uri.Host;
        return PortalTaskCatalog.TryGetByExternalName(name.Trim('/'), out kind);
    }
}
