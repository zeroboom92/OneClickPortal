namespace BrowserThumbnailPrototype;

/// <summary>
/// 화면 업무 버튼과 외부 요청 이름을 함께 관리합니다.
/// </summary>
internal sealed record PortalTaskDescriptor(string Name, PortalTaskKind Kind, string ExternalName);

internal static class PortalTaskCatalog
{
    public static IReadOnlyList<PortalTaskDescriptor> All { get; } = new[]
    {
        new PortalTaskDescriptor("나이스", PortalTaskKind.NiceHome, "nice"),
        new PortalTaskDescriptor("복무", PortalTaskKind.Leave, "leave"),
        new PortalTaskDescriptor("출장", PortalTaskKind.BusinessTrip, "trip"),
        new PortalTaskDescriptor("에듀파인", PortalTaskKind.EdufineHome, "edufine"),
        new PortalTaskDescriptor("기안", PortalTaskKind.Draft, "draft"),
        new PortalTaskDescriptor("품의", PortalTaskKind.PurchaseRequest, "purchase"),
    };

    public static string GetName(PortalTaskKind kind)
    {
        return All.FirstOrDefault(task => task.Kind == kind)?.Name ?? kind.ToString();
    }

    public static bool TryGetByExternalName(string? externalName, out PortalTaskKind kind)
    {
        var task = All.FirstOrDefault(candidate =>
            string.Equals(candidate.ExternalName, externalName?.Trim(), StringComparison.OrdinalIgnoreCase));
        if (task is not null)
        {
            kind = task.Kind;
            return true;
        }

        kind = default;
        return false;
    }

    public static string GetExternalName(PortalTaskKind kind)
    {
        return All.FirstOrDefault(task => task.Kind == kind)?.ExternalName ?? kind.ToString();
    }
}
