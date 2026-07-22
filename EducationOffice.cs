namespace BrowserThumbnailPrototype;

internal sealed record EducationOffice(string Name, string Code)
{
    public string PortalDomain => $"{Code}.eduptl.kr";

    public string NiceDomain => $"{Code}.neis.go.kr";

    public string EdufineDomain => $"klef.{Code}.go.kr";

    public string EvpnDomain => $"evpn.{Code}.go.kr";

    public Uri PortalUri => new($"https://{PortalDomain}/");

    public Uri NiceUri => new($"https://{NiceDomain}/");

    public Uri EdufineUri => new($"https://{EdufineDomain}/");
}

internal static class EducationOfficeCatalog
{
    private static readonly IReadOnlyList<EducationOffice> Offices = Array.AsReadOnly<EducationOffice>(
    [
        new("서울", "sen"),
        new("경기", "goe"),
        new("경남", "gne"),
        new("부산", "pen"),
        new("대구", "dge"),
        new("대전", "dje"),
        new("경북", "gbe"),
        new("세종", "sje"),
        new("울산", "use"),
        new("인천", "ice"),
        new("광주", "gen"),
        new("전남", "jne"),
        new("전북", "jbe"),
        new("충남", "cne"),
        new("충북", "cbe"),
        new("강원", "gwe"),
        new("제주", "jje"),
    ]);

    public static IReadOnlyList<EducationOffice> All => Offices;

    public static EducationOffice Default => GetByCode("jbe");

    public static EducationOffice GetByCode(string? code)
    {
        return Offices.FirstOrDefault(
                office => string.Equals(office.Code, code, StringComparison.OrdinalIgnoreCase))
            ?? Offices.First(office => office.Code == "jbe");
    }
}
