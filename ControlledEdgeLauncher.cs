using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal static class ControlledEdgeLauncher
{
    // The dedicated browser can remain alive after its last visible window closes.
    // Reuse its own local endpoint before trying to edit its locked Preferences file.
    public static async Task<bool> TryReuseAsync(EducationOffice office, CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        return await TryReuseAsync(office, ReadVersionAsync, DevToolsDiscovery.GetTargetsAsync,
            (port, uri, token) => DevToolsSession.CreateTargetAsync(port, uri, token, newWindow: true),
            async (port, id, token) =>
            {
                await using var session = await DevToolsSession.ConnectAsync(port, id, token);
                await session.ActivateTargetAsync(token);
                await session.MaximizeTargetWindowAsync(token);
            }, timeout.Token, cancellationToken);
    }

    internal static async Task<bool> TryReuseAsync(EducationOffice office,
        Func<int, CancellationToken, Task<JsonElement>> readVersion,
        Func<int, CancellationToken, Task<List<DevToolsTarget>>> getTargets,
        Func<int, Uri, CancellationToken, Task<string>> createWindow,
        Func<int, string, CancellationToken, Task> activate,
        CancellationToken operationToken, CancellationToken userToken = default)
    {
        const int port = DevToolsDiscovery.DefaultPort;
        try
        {
            var version = await readVersion(port, operationToken);
            if (!IsReusableVersion(version, port)) return false;
            var targets = await getTargets(port, operationToken);
            var portalPages = targets.Where(target => target.Type == "page"
                && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
                && uri.Scheme == Uri.UriSchemeHttps
                && string.Equals(uri.Host, office.PortalDomain, StringComparison.OrdinalIgnoreCase)).ToArray();
            if (portalPages.Length > 1) return false;

            var id = portalPages.Length == 1 ? portalPages[0].Id
                : await createWindow(port, office.PortalUri, operationToken);
            if (string.IsNullOrWhiteSpace(id)) return false;
            await activate(port, id, operationToken);
            AppLogger.Info("EdgeLaunch", "실행 중인 전용 Edge를 재사용해 업무포털을 열었습니다.");
            return true;
        }
        catch (OperationCanceledException) when (userToken.IsCancellationRequested) { throw; }
        catch (Exception exception) when (exception is HttpRequestException or IOException or JsonException
            or OperationCanceledException or TimeoutException or InvalidOperationException or System.Net.WebSockets.WebSocketException)
        {
            AppLogger.Info("EdgeLaunch", $"기존 Edge 재사용 확인을 완료하지 못했습니다 ({exception.GetType().Name})");
            return false;
        }
    }

    internal static bool IsReusableVersion(JsonElement version, int port)
    {
        return version.ValueKind == JsonValueKind.Object
            && version.TryGetProperty("Browser", out var product) && product.ValueKind == JsonValueKind.String
            && product.GetString()?.StartsWith("Edg/", StringComparison.Ordinal) == true
            && version.TryGetProperty("webSocketDebuggerUrl", out var socket) && socket.ValueKind == JsonValueKind.String
            && Uri.TryCreate(socket.GetString(), UriKind.Absolute, out var uri)
            && uri.Scheme == "ws" && uri.Port == port
            && (uri.Host == "127.0.0.1" || uri.Host == "localhost" || uri.Host == "[::1]")
            && string.IsNullOrEmpty(uri.UserInfo)
            && uri.AbsolutePath.StartsWith("/devtools/browser/", StringComparison.Ordinal)
            && uri.AbsolutePath.Length > "/devtools/browser/".Length;
    }

    private static async Task<JsonElement> ReadVersionAsync(int port, CancellationToken cancellationToken)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        await using var stream = await http.GetStreamAsync($"http://127.0.0.1:{port}/json/version", cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return document.RootElement.Clone();
    }
}
