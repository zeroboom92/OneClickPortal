using System.Diagnostics;

namespace BrowserThumbnailPrototype;

internal static class SupportInquiry
{
    private static readonly Uri BoardUri = new("https://원클릭업무포털.com/board");

    public static ProcessStartInfo CreateStartInfo(string educationOfficeCode, string version)
    {
        var office = EducationOfficeCatalog.GetByCode(educationOfficeCode);
        var uri = new UriBuilder(BoardUri)
        {
            Query = $"write=1&office={Uri.EscapeDataString(office.Code)}&version={Uri.EscapeDataString(version)}",
        }.Uri;

        return new ProcessStartInfo
        {
            FileName = uri.AbsoluteUri,
            UseShellExecute = true,
        };
    }
}
