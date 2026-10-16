using System.Net;
using System.Net.Sockets;
using System.Text.Json;

namespace BrowserThumbnailPrototype;

internal static class ControlledEdgeLauncher
{
    private const int PortProbeCount = 11;

    public static int FindAvailablePort()
    {
        foreach (var port in Enumerable.Range(DevToolsDiscovery.DefaultPort, PortProbeCount))
        {
            var listener = new TcpListener(IPAddress.Loopback, port) { ExclusiveAddressUse = true };
            try
            {
                listener.Start();
                return port;
            }
            catch (SocketException)
            {
                // Another local program or a Windows port reservation owns this port.
            }
            finally { listener.Stop(); }
        }
        throw new InvalidOperationException("브라우저 제어용 로컬 포트(9222~9232)를 모두 사용할 수 없습니다. 다른 프로그램의 포트 점유 또는 보안 설정을 확인해 주세요.");
    }

    // The dedicated browser can remain alive after its last visible window closes.
    // Reuse its own local endpoint before trying to edit its locked Preferences file.
    public static async Task<bool> TryReuseAsync(EducationOffice office, CancellationToken cancellationToken = default)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(8));
        return await TryReuseAcrossPortsAsync(office, ReadVersionAsync, DevToolsDiscovery.GetTargetsAsync,
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
        CancellationToken operationToken, CancellationToken userToken = default,
        int port = DevToolsDiscovery.DefaultPort)
    {
        return await TryReusePortsAsync(office, [port], readVersion, getTargets, createWindow,
            activate, operationToken, userToken);
    }

    internal static Task<bool> TryReuseAcrossPortsAsync(EducationOffice office,
        Func<int, CancellationToken, Task<JsonElement>> readVersion,
        Func<int, CancellationToken, Task<List<DevToolsTarget>>> getTargets,
        Func<int, Uri, CancellationToken, Task<string>> createWindow,
        Func<int, string, CancellationToken, Task> activate,
        CancellationToken operationToken, CancellationToken userToken = default) =>
        TryReusePortsAsync(office, Enumerable.Range(DevToolsDiscovery.DefaultPort, PortProbeCount),
            readVersion, getTargets, createWindow, activate, operationToken, userToken);

    private static async Task<bool> TryReusePortsAsync(EducationOffice office, IEnumerable<int> ports,
        Func<int, CancellationToken, Task<JsonElement>> readVersion,
        Func<int, CancellationToken, Task<List<DevToolsTarget>>> getTargets,
        Func<int, Uri, CancellationToken, Task<string>> createWindow,
        Func<int, string, CancellationToken, Task> activate,
        CancellationToken operationToken, CancellationToken userToken)
    {
        try
        {
            var probes = ports.Select(async port =>
            {
                try
                {
                    var version = await readVersion(port, operationToken);
                    if (!IsReusableVersion(version, port)) return null;
                    var targets = await getTargets(port, operationToken);
                    var portalPages = targets.Where(target => target.Type == "page"
                        && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
                        && uri.Scheme == Uri.UriSchemeHttps
                        && string.Equals(uri.Host, office.PortalDomain, StringComparison.OrdinalIgnoreCase)).ToArray();
                    return new ReusableEndpoint(port, portalPages);
                }
                catch (OperationCanceledException) when (userToken.IsCancellationRequested) { throw; }
                catch (Exception exception) when (IsExpectedFailure(exception)) { return null; }
            });
            var candidates = (await Task.WhenAll(probes)).Where(endpoint => endpoint is not null).ToArray();
            userToken.ThrowIfCancellationRequested();
            operationToken.ThrowIfCancellationRequested();
            if (candidates.Any(endpoint => endpoint!.PortalPages.Length > 1)) return false;

            var portals = candidates.Where(endpoint => endpoint!.PortalPages.Length == 1).ToArray();
            var selected = portals.Length == 1 ? portals[0]
                : portals.Length == 0 && candidates.Length == 1 ? candidates[0] : null;
            if (selected is null) return false;

            var id = selected.PortalPages.Length == 1 ? selected.PortalPages[0].Id
                : await createWindow(selected.Port, office.PortalUri, operationToken);
            if (string.IsNullOrWhiteSpace(id)) return false;
            await activate(selected.Port, id, operationToken);
            AppLogger.Info("EdgeLaunch", $"실행 중인 전용 Edge를 재사용해 업무포털을 열었습니다. (포트 {selected.Port})");
            return true;
        }
        catch (OperationCanceledException) when (userToken.IsCancellationRequested) { throw; }
        catch (Exception exception) when (IsExpectedFailure(exception))
        {
            AppLogger.Info("EdgeLaunch", $"기존 Edge 재사용 확인을 완료하지 못했습니다 ({exception.GetType().Name})");
            return false;
        }
    }

    private sealed record ReusableEndpoint(int Port, DevToolsTarget[] PortalPages);

    private static bool IsExpectedFailure(Exception exception) =>
        exception is HttpRequestException or IOException or JsonException or OperationCanceledException
            or TimeoutException or InvalidOperationException or System.Net.WebSockets.WebSocketException;

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
        using var http = new HttpClient(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false })
        { Timeout = TimeSpan.FromSeconds(2) };
        await using var stream = await http.GetStreamAsync($"http://127.0.0.1:{port}/json/version", cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return document.RootElement.Clone();
    }
}
