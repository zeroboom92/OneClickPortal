using System.Diagnostics;

namespace BrowserThumbnailPrototype;

internal enum PortalBrowser { Edge, Chrome }

internal static class BrowserSupport
{
    public static string GetDisplayName(PortalBrowser browser) => browser == PortalBrowser.Chrome ? "Chrome" : "Edge";
    public static string GetProcessName(PortalBrowser browser) => browser == PortalBrowser.Chrome ? "chrome" : "msedge";
    public static string GetPolicyPage(PortalBrowser browser) => browser == PortalBrowser.Chrome ? "chrome://policy" : "edge://policy";
    public static string GetPolicyKeyPath(PortalBrowser browser) => browser == PortalBrowser.Chrome
        ? @"SOFTWARE\Policies\Google\Chrome" : @"SOFTWARE\Policies\Microsoft\Edge";

    public static PortalBrowser FromProcessName(string processName) => processName.ToLowerInvariant() switch
    {
        "chrome" => PortalBrowser.Chrome,
        "msedge" => PortalBrowser.Edge,
        _ => throw new InvalidOperationException("Chrome 또는 Edge 창을 선택해 주세요."),
    };

    public static bool MatchesProduct(PortalBrowser browser, string? product) =>
        product?.StartsWith(browser == PortalBrowser.Chrome ? "Chrome/" : "Edg/", StringComparison.Ordinal) == true;

    public static string GetControlledProfilePath(PortalBrowser browser) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OneClickPortal",
        browser == PortalBrowser.Chrome ? "ChromeAnalysisProfile" : "EdgeAnalysisProfile");

    public static string? FindExecutable(PortalBrowser browser)
    {
        var vendor = browser == PortalBrowser.Chrome ? "Google" : "Microsoft";
        var product = GetDisplayName(browser);
        var executable = GetProcessName(browser) + ".exe";
        return new[] { Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86,
                Environment.SpecialFolder.LocalApplicationData }
            .Select(folder => Path.Combine(Environment.GetFolderPath(folder), vendor, product, "Application", executable))
            .FirstOrDefault(File.Exists);
    }

    public static ProcessStartInfo CreateStartInfo(PortalBrowser browser, int port, EducationOffice office)
    {
        var executable = FindExecutable(browser)
            ?? throw new FileNotFoundException($"{GetDisplayName(browser)} 실행 파일을 찾지 못했습니다. 설치 여부를 확인하거나 설정에서 로그인 브라우저를 변경해 주세요.");
        var startInfo = new ProcessStartInfo { FileName = executable, UseShellExecute = false };
        startInfo.ArgumentList.Add($"--remote-debugging-port={port}");
        startInfo.ArgumentList.Add("--remote-debugging-address=127.0.0.1");
        startInfo.ArgumentList.Add($"--user-data-dir={GetControlledProfilePath(browser)}");
        startInfo.ArgumentList.Add("--start-maximized");
        startInfo.ArgumentList.Add("--new-window");
        startInfo.ArgumentList.Add("--disable-background-timer-throttling");
        startInfo.ArgumentList.Add("--disable-renderer-backgrounding");
        startInfo.ArgumentList.Add("--disable-backgrounding-occluded-windows");
        startInfo.ArgumentList.Add(office.PortalUri.AbsoluteUri);
        return startInfo;
    }
}
