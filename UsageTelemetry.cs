using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;

namespace BrowserThumbnailPrototype;

internal static class UsageTelemetry
{
    private static readonly Uri RecordEndpoint = new(
        "https://asia-northeast3-oneclickportal.cloudfunctions.net/recordUsage");
    private static readonly Uri SummaryEndpoint = new(
        "https://asia-northeast3-oneclickportal.cloudfunctions.net/getUsageSummary");
    private static readonly TimeZoneInfo KoreaTimeZone =
        TimeZoneInfo.FindSystemTimeZoneById("Korea Standard Time");
    private static readonly HttpClient HttpClient = new()
    {
        Timeout = TimeSpan.FromSeconds(5),
    };
    private static readonly object TimerLock = new();

    private static System.Threading.Timer? _timer;
    private static int _reportRunning;

    public static void Start()
    {
        lock (TimerLock)
        {
            _timer ??= new System.Threading.Timer(
                _ => TryReportInBackground(),
                null,
                TimeSpan.Zero,
                TimeSpan.FromMinutes(5));
        }
    }

    public static void Stop()
    {
        lock (TimerLock)
        {
            _timer?.Dispose();
            _timer = null;
        }
    }

    public static async Task<UsageSummary?> GetUsageSummaryAsync()
    {
        try
        {
            return await HttpClient.GetFromJsonAsync<UsageSummary>(SummaryEndpoint);
        }
        catch (Exception exception)
        {
            AppLogger.Error("Usage", "현재 사용자 수 조회 중 오류", exception);
            return null;
        }
    }

    private static void TryReportInBackground()
    {
        if (Interlocked.Exchange(ref _reportRunning, 1) != 0)
        {
            return;
        }

        _ = ReportAndReleaseAsync();
    }

    private static async Task ReportAndReleaseAsync()
    {
        try
        {
            await ReportIfNeededAsync();
        }
        finally
        {
            Interlocked.Exchange(ref _reportRunning, 0);
        }
    }

    private static async Task ReportIfNeededAsync()
    {
        try
        {
            if (!AppPreferences.IsUsageTelemetryEnabled())
            {
                return;
            }

            var nowUtc = DateTimeOffset.UtcNow;
            var koreaNow = TimeZoneInfo.ConvertTime(nowUtc, KoreaTimeZone);
            var todayKorea = DateOnly.FromDateTime(koreaNow.DateTime);
            var isPresenceWindow = koreaNow.Hour >= 7 && koreaNow.Hour < 11;
            var dailyReportDue = AppPreferences.GetLastUsageReportDateUtc() != todayKorea;
            var lastPresenceReport = AppPreferences.GetLastPresenceReportUtc();
            var presenceReportDue = isPresenceWindow
                && (lastPresenceReport is null
                    || nowUtc - lastPresenceReport.Value >= TimeSpan.FromMinutes(30));

            if (!dailyReportDue && !presenceReportDue)
            {
                return;
            }

            var localInstallationId = AppPreferences.GetOrCreateAnonymousInstallationId();
            var installationIdHash = Convert.ToHexString(
                    SHA256.HashData(Encoding.UTF8.GetBytes(localInstallationId)))
                .ToLowerInvariant();
            var version = Application.ProductVersion.Split('+', 2)[0];

            using var response = await HttpClient.PostAsJsonAsync(
                RecordEndpoint,
                new UsageReport(installationIdHash, version, presenceReportDue));
            if (!response.IsSuccessStatusCode)
            {
                AppLogger.Info("Usage", $"익명 사용 통계 전송 실패: HTTP {(int)response.StatusCode}");
                return;
            }

            if (dailyReportDue)
            {
                AppPreferences.SetLastUsageReportDateUtc(todayKorea);
            }

            if (presenceReportDue)
            {
                AppPreferences.SetLastPresenceReportUtc(nowUtc);
            }

            AppLogger.Info(
                "Usage",
                presenceReportDue ? "익명 사용 통계와 현재 사용자 신호를 전송했습니다." : "익명 사용 통계를 전송했습니다.");
        }
        catch (Exception exception)
        {
            // 통계 수집 실패가 프로그램 시작이나 업무 처리를 방해하면 안 됩니다.
            AppLogger.Error("Usage", "익명 사용 통계 전송 중 오류", exception);
        }
    }

    private sealed record UsageReport(string InstallationIdHash, string Version, bool IsPresence);
}

internal sealed record UsageSummary(int ActiveUsers, int WindowMinutes, bool TrackingActive);
