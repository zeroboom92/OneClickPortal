namespace BrowserThumbnailPrototype;

/// <summary>
/// 업무 버튼 목록과 외부 요청 이름을 한곳에서 관리합니다.
/// 버튼 생성(<see cref="MainForm"/>)과 외부 요청 해석(<see cref="PortalTaskRequest"/>)이
/// 같은 목록을 보도록 하여 두 곳이 어긋나지 않게 합니다.
/// </summary>
internal sealed record PortalTaskDescriptor(string Name, PortalTaskKind Kind, string ExternalName);

internal static class PortalTaskCatalog
{
    /// <summary>화면에 표시되는 순서 그대로입니다. 순서를 바꾸면 버튼 배치도 함께 바뀝니다.</summary>
    public static IReadOnlyList<PortalTaskDescriptor> All { get; } = new[]
    {
        new PortalTaskDescriptor("나이스", PortalTaskKind.NiceHome, "nice"),
        new PortalTaskDescriptor("복무", PortalTaskKind.Leave, "leave"),
        new PortalTaskDescriptor("출장", PortalTaskKind.BusinessTrip, "trip"),
        new PortalTaskDescriptor("에듀파인", PortalTaskKind.EdufineHome, "edufine"),
        new PortalTaskDescriptor("기안", PortalTaskKind.Draft, "draft"),
        new PortalTaskDescriptor("품의", PortalTaskKind.PurchaseRequest, "purchase"),
    };

    /// <summary>업무 종류에 해당하는 한글 이름을 돌려줍니다. 목록에 없으면 열거형 이름을 그대로 씁니다.</summary>
    public static string GetName(PortalTaskKind kind)
    {
        foreach (var descriptor in All)
        {
            if (descriptor.Kind == kind)
            {
                return descriptor.Name;
            }
        }

        return kind.ToString();
    }

    /// <summary>외부 요청 이름(leave, trip 등)을 업무 종류로 바꿉니다. 대소문자는 구분하지 않습니다.</summary>
    public static bool TryGetByExternalName(string? externalName, out PortalTaskKind kind)
    {
        if (!string.IsNullOrWhiteSpace(externalName))
        {
            var trimmed = externalName.Trim();
            foreach (var descriptor in All)
            {
                if (string.Equals(descriptor.ExternalName, trimmed, StringComparison.OrdinalIgnoreCase))
                {
                    kind = descriptor.Kind;
                    return true;
                }
            }
        }

        kind = default;
        return false;
    }
}
