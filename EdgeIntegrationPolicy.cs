using System.Text.Json;
using System.Text.Json.Nodes;
using System.Globalization;
using Microsoft.Win32;

namespace BrowserThumbnailPrototype;

internal static class EdgeIntegrationPolicy
{
    private const string WxsClientProtocol = "wxsclient";

    public static string ControlledProfilePath => BrowserSupport.GetControlledProfilePath(PortalBrowser.Edge);

    public static bool PrepareControlledProfile(EducationOffice educationOffice, PortalBrowser browser = PortalBrowser.Edge)
    {
        return PrepareProfile(BrowserSupport.GetControlledProfilePath(browser), educationOffice);
    }

    private static bool PrepareProfile(string profilePath, EducationOffice educationOffice)
    {
        var defaultProfilePath = Path.Combine(profilePath, "Default");
        var preferencesPath = Path.Combine(defaultProfilePath, "Preferences");
        var temporaryPath = Path.Combine(defaultProfilePath, "Preferences.oneclickportal.tmp");
        var writeAttempted = false;
        try
        {
            Directory.CreateDirectory(defaultProfilePath);
            // An open Edge keeps preferences in memory. Do not replace its file;
            // the browser could overwrite the change, or lose a newer setting.
            var preferences = ReadPreferences(preferencesPath);
            if (!ApplyPermissions(preferences, educationOffice))
            {
                return true;
            }

            // Chromium on Windows holds user-data-dir/lockfile for its lifetime.
            // Acquire it exclusively for the entire read/merge/write operation.
            using var profileLock = new FileStream(
                Path.Combine(profilePath, "lockfile"),
                FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);

            preferences = ReadPreferences(preferencesPath);
            if (!ApplyPermissions(preferences, educationOffice))
            {
                return true;
            }

            writeAttempted = true;
            File.WriteAllText(
                temporaryPath,
                preferences.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
            File.Move(temporaryPath, preferencesPath, overwrite: true);
            AppLogger.Info(
                "EdgeProfile",
                $"전용 브라우저 프로필에 업무포털·나이스·K-에듀파인 로컬 연결과 K-에듀파인 WXSClient 실행 허용을 설정했습니다: {educationOffice.Code}");
            return true;
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException
            or System.Security.SecurityException
            or IOException
            or JsonException
            or InvalidOperationException)
        {
            AppLogger.Error("EdgeProfile", "전용 브라우저 프로필의 인증서·K-에듀파인 권한을 설정하지 못했습니다. 전용 브라우저 종료 후 재시도가 필요합니다.", exception);
            if (writeAttempted)
            {
                TryDeleteTemporaryFile(temporaryPath);
            }
            return false;
        }
    }

    private static JsonObject ReadPreferences(string preferencesPath)
    {
        return File.Exists(preferencesPath)
            ? JsonNode.Parse(File.ReadAllText(preferencesPath)) as JsonObject
                ?? throw new JsonException("전용 브라우저 프로필 설정 형식이 올바르지 않습니다.")
            : new JsonObject();
    }

    private static bool ApplyPermissions(JsonObject preferences, EducationOffice educationOffice)
    {
        var protocolHandler = GetOrCreateObject(preferences, "protocol_handler");
        var allowedPairs = GetOrCreateObject(protocolHandler, "allowed_origin_protocol_pairs");
        var edufineOrigin = educationOffice.EdufineUri.GetLeftPart(UriPartial.Authority);
        var originPolicy = GetOrCreateObject(allowedPairs, edufineOrigin);
        var changed = false;
        if (originPolicy[WxsClientProtocol]?.GetValue<bool>() != true)
        {
            originPolicy[WxsClientProtocol] = true;
            changed = true;
        }

        var profile = GetOrCreateObject(preferences, "profile");
        var contentSettings = GetOrCreateObject(profile, "content_settings");
        var exceptions = GetOrCreateObject(contentSettings, "exceptions");
        // Certificate detection happens on the portal before connecting to
        // K-Edufine. Each site needs its own permission in this separate profile.
        foreach (var uri in new[] { educationOffice.PortalUri, educationOffice.NiceUri, educationOffice.EdufineUri })
        {
            var contentSettingPattern = $"{uri.Scheme}://{uri.Host}:{uri.Port},*";
            foreach (var permissionName in new[] { "local_network", "loopback_network", "local_network_access" })
            {
                var permission = GetOrCreateObject(exceptions, permissionName);
                var siteSetting = GetOrCreateObject(permission, contentSettingPattern);
                if (siteSetting["setting"]?.GetValue<int>() == 1)
                {
                    continue;
                }

                siteSetting["last_modified"] = (DateTime.UtcNow.ToFileTimeUtc() / 10)
                    .ToString(CultureInfo.InvariantCulture);
                siteSetting["setting"] = 1;
                changed = true;
            }
        }

        return changed;
    }

    public static bool IsWxsClientRegistered()
    {
        try
        {
            using var commandKey = Registry.ClassesRoot.OpenSubKey($@"{WxsClientProtocol}\shell\open\command");
            return !string.IsNullOrWhiteSpace(commandKey?.GetValue(null) as string);
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException
            or System.Security.SecurityException
            or IOException)
        {
            AppLogger.Error("EdgeProfile", "WXSClient 등록 상태를 확인하지 못했습니다.", exception);
            return false;
        }
    }

    private static JsonObject GetOrCreateObject(JsonObject parent, string propertyName)
    {
        if (parent[propertyName] is JsonObject existing)
        {
            return existing;
        }

        var created = new JsonObject();
        parent[propertyName] = created;
        return created;
    }

    private static void TryDeleteTemporaryFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // The original Edge preferences remain untouched.
        }
    }
}
