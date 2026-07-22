using System.Text.Json;
using System.Text.Json.Nodes;
using System.Globalization;
using Microsoft.Win32;

namespace BrowserThumbnailPrototype;

internal static class EdgeIntegrationPolicy
{
    private const string WxsClientProtocol = "wxsclient";

    public static string ControlledProfilePath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "OneClickPortal",
        "EdgeAnalysisProfile");

    public static void PrepareControlledProfile(EducationOffice educationOffice)
    {
        var defaultProfilePath = Path.Combine(ControlledProfilePath, "Default");
        var preferencesPath = Path.Combine(defaultProfilePath, "Preferences");
        var temporaryPath = Path.Combine(defaultProfilePath, "Preferences.oneclickportal.tmp");
        try
        {
            Directory.CreateDirectory(defaultProfilePath);
            JsonObject preferences;
            if (File.Exists(preferencesPath))
            {
                preferences = JsonNode.Parse(File.ReadAllText(preferencesPath)) as JsonObject
                    ?? throw new JsonException("전용 Edge 프로필 설정 형식이 올바르지 않습니다.");
            }
            else
            {
                preferences = new JsonObject();
            }

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
            var contentSettingPattern = $"{edufineOrigin}:443,*";
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

            if (!changed)
            {
                return;
            }

            File.WriteAllText(
                temporaryPath,
                preferences.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
            File.Move(temporaryPath, preferencesPath, overwrite: true);
            AppLogger.Info(
                "EdgeProfile",
                $"전용 Edge 프로필에 로컬 네트워크와 WXSClient 실행 허용을 설정했습니다: {educationOffice.EdufineDomain}");
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException
            or System.Security.SecurityException
            or IOException
            or JsonException
            or InvalidOperationException)
        {
            AppLogger.Error("EdgeProfile", "전용 Edge 프로필의 K-에듀파인 권한을 설정하지 못했습니다.", exception);
            TryDeleteTemporaryFile(temporaryPath);
        }
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
