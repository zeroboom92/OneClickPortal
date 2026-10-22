using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BrowserThumbnailPrototype;

internal sealed record DevToolsTarget(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("title")] string Title,
    [property: JsonPropertyName("url")] string Url);

internal sealed class DevToolsCommandTimeoutException : TimeoutException
{
    public DevToolsCommandTimeoutException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}

internal static class DevToolsDiscovery
{
    public const int DefaultPort = 9222;
    private const int PortProbeCount = 11;

    // This channel is always local. System proxy/PAC settings and redirects must
    // never route browser inspection through a network server.
    private static readonly HttpClient HttpClient = new(new HttpClientHandler
    {
        UseProxy = false,
        AllowAutoRedirect = false,
    })
    {
        Timeout = TimeSpan.FromSeconds(1),
    };

    public static async Task<int?> FindPortalPortAsync(
        EducationOffice educationOffice,
        CancellationToken cancellationToken = default)
    {
        return (await InspectPortalPortsAsync(educationOffice, cancellationToken)).Port;
    }

    public static Task<DevToolsDiscoveryResult> InspectPortalPortsAsync(
        EducationOffice educationOffice, CancellationToken cancellationToken = default)
    {
        return InspectPortalPortsAsync(educationOffice,
            (port, token) => ProbePortAsync(port, educationOffice, token), cancellationToken);
    }

    public static Task<DevToolsDiscoveryResult> InspectPortalPortsAsync(
        EducationOffice educationOffice, PortalBrowser browser, CancellationToken cancellationToken = default) =>
        InspectPortalPortsAsync(educationOffice,
            (port, token) => ProbePortAsync(port, educationOffice, token, browser), cancellationToken);

    internal static async Task<DevToolsDiscoveryResult> InspectPortalPortsAsync(
        EducationOffice office,
        Func<int, CancellationToken, Task<DevToolsPortProbe>> probe,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var results = await Task.WhenAll(Enumerable.Range(DefaultPort, PortProbeCount)
            .Select(port => probe(port, cancellationToken)));
        cancellationToken.ThrowIfCancellationRequested();
        var ready = results.Where(result => result.Status == DevToolsProbeStatus.Ready).ToArray();
        if (ready.Length > 1)
            return new DevToolsDiscoveryResult(null, results.Select(result => result.Status == DevToolsProbeStatus.Ready
                ? result with { Status = DevToolsProbeStatus.Ambiguous } : result).ToArray());
        return new DevToolsDiscoveryResult(ready.Length == 1 ? ready[0].Port : null, results);
    }

    internal static async Task<DevToolsPortProbe> ProbePortAsync(
        int port,
        EducationOffice educationOffice,
        CancellationToken cancellationToken = default, PortalBrowser? browser = null)
    {
        try
        {
            var version = await ReadBrowserVersionAsync(port, cancellationToken);
            ParseBrowserWebSocketUri(version, port);
            if (browser is not null && (!version.TryGetProperty("Browser", out var product)
                || product.ValueKind != JsonValueKind.String || !BrowserSupport.MatchesProduct(browser.Value, product.GetString())))
                return new DevToolsPortProbe(port, DevToolsProbeStatus.BrowserMismatch, Array.Empty<string>());
            var targets = await GetTargetsAsync(port, cancellationToken);
            var codes = EducationOfficeCatalog.All
                .Where(office => targets.Any(target => IsPortalRelatedTarget(target, office)))
                .Select(office => office.Code).ToArray();
            return new DevToolsPortProbe(port,
                codes.Contains(educationOffice.Code) ? DevToolsProbeStatus.Ready : DevToolsProbeStatus.NoPortalTarget,
                codes);
        }
        catch (Exception exception) when (
            !cancellationToken.IsCancellationRequested
            && exception is HttpRequestException or OperationCanceledException or IOException
                or JsonException or InvalidOperationException)
        {
            var status = exception is JsonException or InvalidOperationException
                || exception is HttpRequestException { StatusCode: not null }
                ? DevToolsProbeStatus.InvalidResponse : DevToolsProbeStatus.Unreachable;
            return new DevToolsPortProbe(port, status, Array.Empty<string>(), exception.GetType().Name);
        }
    }

    public static async Task<List<DevToolsTarget>> GetTargetsAsync(int port, CancellationToken cancellationToken = default)
    {
        await using var stream = await HttpClient.GetStreamAsync($"http://127.0.0.1:{port}/json/list", cancellationToken);
        var targets = await JsonSerializer.DeserializeAsync<List<DevToolsTarget>>(stream, cancellationToken: cancellationToken);
        if (targets is null || targets.Any(target => target is null
            || string.IsNullOrWhiteSpace(target.Id) || string.IsNullOrWhiteSpace(target.Type) || target.Url is null))
            throw new JsonException("브라우저 탭 목록 형식이 올바르지 않습니다.");
        return targets;
    }

    public static async Task<Uri> GetBrowserWebSocketUriAsync(int port, CancellationToken cancellationToken = default)
    {
        return ParseBrowserWebSocketUri(await ReadBrowserVersionAsync(port, cancellationToken), port);
    }

    private static async Task<JsonElement> ReadBrowserVersionAsync(int port, CancellationToken cancellationToken)
    {
        await using var stream = await HttpClient.GetStreamAsync($"http://127.0.0.1:{port}/json/version", cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        return document.RootElement.Clone();
    }

    private static Uri ParseBrowserWebSocketUri(JsonElement version, int port)
    {
        if (version.ValueKind != JsonValueKind.Object
            || !version.TryGetProperty("webSocketDebuggerUrl", out var value)
            || value.ValueKind != JsonValueKind.String
            || !Uri.TryCreate(value.GetString(), UriKind.Absolute, out var uri)
            || uri.Scheme != "ws" || uri.Port != port
            || (uri.Host != "127.0.0.1" && uri.Host != "localhost" && uri.Host != "[::1]")
            || !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) || !string.IsNullOrEmpty(uri.Fragment)
            || !uri.AbsolutePath.StartsWith("/devtools/browser/", StringComparison.Ordinal)
            || uri.AbsolutePath.Length <= "/devtools/browser/".Length)
            throw new InvalidOperationException("로컬 브라우저 제어 주소가 올바르지 않습니다.");
        return uri;
    }

    private static bool IsPortalRelatedTarget(DevToolsTarget target, EducationOffice educationOffice)
    {
        return target.Type is "page" or "iframe"
            && Uri.TryCreate(target.Url, UriKind.Absolute, out var uri)
            && uri.Scheme == Uri.UriSchemeHttps
            && (string.Equals(uri.Host, educationOffice.PortalDomain, StringComparison.OrdinalIgnoreCase)
                || string.Equals(uri.Host, educationOffice.NiceDomain, StringComparison.OrdinalIgnoreCase)
                || string.Equals(uri.Host, educationOffice.EdufineDomain, StringComparison.OrdinalIgnoreCase));
    }
}

internal enum DevToolsProbeStatus { Ready, NoPortalTarget, Unreachable, InvalidResponse, BrowserMismatch, Ambiguous, WindowMismatch }
internal sealed record DevToolsPortProbe(int Port, DevToolsProbeStatus Status,
    IReadOnlyList<string> OfficeCodes, string? FailureKind = null);
internal sealed record DevToolsDiscoveryResult(int? Port, IReadOnlyList<DevToolsPortProbe> Probes);

internal sealed class DevToolsSession : IAsyncDisposable
{
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(12);
    private static int _backgroundResumeUnavailable;
    private readonly ClientWebSocket _socket = new();
    private readonly SemaphoreSlim _commandLock = new(1, 1);
    private int _nextCommandId;
    private int _disposed;
    private string? _sessionId;
    private string? _targetId;

    private DevToolsSession()
    {
        _socket.Options.Proxy = null;
    }

    public static async Task<string> CreateTargetAsync(
        int port,
        Uri uri,
        CancellationToken cancellationToken = default,
        bool newWindow = false)
    {
        var session = new DevToolsSession();
        using var connectCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        connectCancellation.CancelAfter(CommandTimeout);
        try
        {
            var browserUri = await DevToolsDiscovery.GetBrowserWebSocketUriAsync(port, connectCancellation.Token);
            await session._socket.ConnectAsync(browserUri, connectCancellation.Token);
            var result = await session.ExecuteRootCommandAsync(
                "Target.createTarget",
                new { url = uri.AbsoluteUri, newWindow },
                connectCancellation.Token);
            var targetId = result.GetProperty("targetId").GetString()
                ?? throw new InvalidOperationException("새 브라우저 탭을 만들지 못했습니다.");
            AppLogger.Info("DevTools", $"공식 주소로 새 탭을 열었습니다: {uri.Host}");
            return targetId;
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            var timeoutException = new TimeoutException("새 브라우저 탭을 여는 시간이 초과되었습니다.", exception);
            AppLogger.Error("DevTools", "새 탭 열기 시간 초과", timeoutException);
            throw timeoutException;
        }
        finally
        {
            await session.DisposeAsync();
        }
    }

    public static async Task<DevToolsSession> ConnectAsync(
        int port,
        string targetId,
        CancellationToken cancellationToken = default)
    {
        var session = new DevToolsSession();
        using var connectCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        connectCancellation.CancelAfter(CommandTimeout);
        try
        {
            var browserUri = await DevToolsDiscovery.GetBrowserWebSocketUriAsync(port, connectCancellation.Token);
            await session._socket.ConnectAsync(browserUri, connectCancellation.Token);
            var result = await session.ExecuteRootCommandAsync(
                "Target.attachToTarget",
                new { targetId, flatten = true },
                connectCancellation.Token);
            session._sessionId = result.GetProperty("sessionId").GetString()
                ?? throw new InvalidOperationException("브라우저 탭에 연결하지 못했습니다.");
            session._targetId = targetId;
            AppLogger.Info("DevTools", "브라우저 탭 연결 완료");
            return session;
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            var timeoutException = new TimeoutException("브라우저 탭 연결 응답 시간이 초과되었습니다.", exception);
            AppLogger.Error("DevTools", "브라우저 탭 연결 시간 초과", timeoutException);
            await session.DisposeAsync();
            throw timeoutException;
        }
        catch (Exception exception)
        {
            AppLogger.Error("DevTools", "브라우저 탭 연결 실패", exception);
            await session.DisposeAsync();
            throw;
        }
    }

    public async Task<JsonElement> EvaluateAsync(
        string expression,
        bool userGesture = false,
        CancellationToken cancellationToken = default)
    {
        var result = await ExecuteSessionCommandAsync(
            "Runtime.evaluate",
            new
            {
                expression,
                returnByValue = true,
                awaitPromise = true,
                userGesture,
            },
            cancellationToken);

        if (result.TryGetProperty("exceptionDetails", out var exceptionDetails))
        {
            var detail = GetExceptionDetail(exceptionDetails);
            var exception = new InvalidOperationException($"페이지 상태 확인 중 오류가 발생했습니다: {detail}");
            AppLogger.Error("DevTools", "페이지 명령 실행 실패", exception);
            throw exception;
        }

        return result.GetProperty("result").TryGetProperty("value", out var value)
            ? value.Clone()
            : default;
    }

    private static string GetExceptionDetail(JsonElement exceptionDetails)
    {
        if (exceptionDetails.TryGetProperty("exception", out var exception)
            && exception.TryGetProperty("description", out var description)
            && !string.IsNullOrWhiteSpace(description.GetString()))
        {
            return description.GetString()!.Split('\n')[0];
        }

        if (exceptionDetails.TryGetProperty("text", out var text)
            && !string.IsNullOrWhiteSpace(text.GetString()))
        {
            return text.GetString()!;
        }

        return "웹 화면이 변경되는 중이었습니다.";
    }

    public async Task<bool> EvaluateBooleanAsync(
        string expression,
        bool userGesture = false,
        CancellationToken cancellationToken = default)
    {
        var value = await EvaluateAsync(expression, userGesture, cancellationToken);
        return value.ValueKind == JsonValueKind.True;
    }

    public async Task<string?> EvaluateStringAsync(
        string expression,
        CancellationToken cancellationToken = default)
    {
        var value = await EvaluateAsync(expression, cancellationToken: cancellationToken);
        return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
    }

    public Task BringToFrontAsync(CancellationToken cancellationToken = default)
    {
        return ExecuteSessionCommandWithoutResultAsync("Page.bringToFront", new { }, cancellationToken);
    }

    public async Task ResumeBackgroundPageAsync(CancellationToken cancellationToken = default)
    {
        if (Volatile.Read(ref _backgroundResumeUnavailable) != 0)
        {
            return;
        }

        try
        {
            await ExecuteSessionCommandWithoutResultAsync(
                "Page.setWebLifecycleState",
                new { state = "active" },
                cancellationToken);
        }
        catch (InvalidOperationException)
        {
            // Older Chromium builds may not expose this optional command.
            // Session checks must still run through their existing path.
            Interlocked.Exchange(ref _backgroundResumeUnavailable, 1);
            AppLogger.Info("SessionRefresh", "브라우저가 백그라운드 탭 깨우기를 지원하지 않아 기존 방식으로 점검합니다.");
        }
    }

    public async Task ActivateTargetAsync(CancellationToken cancellationToken = default)
    {
        if (_targetId is null)
        {
            throw new InvalidOperationException("활성화할 브라우저 탭이 없습니다.");
        }

        await ExecuteRootCommandAsync(
            "Target.activateTarget",
            new { targetId = _targetId },
            cancellationToken);
    }

    public async Task MaximizeTargetWindowAsync(CancellationToken cancellationToken = default)
    {
        if (_targetId is null)
        {
            throw new InvalidOperationException("최대화할 브라우저 탭이 없습니다.");
        }

        var windowInfo = await ExecuteRootCommandAsync(
            "Browser.getWindowForTarget",
            new { targetId = _targetId },
            cancellationToken);
        var windowId = windowInfo.GetProperty("windowId").GetInt32();
        var boundsInfo = await ExecuteRootCommandAsync(
            "Browser.getWindowBounds",
            new { windowId },
            cancellationToken);
        var windowState = boundsInfo.GetProperty("bounds").GetProperty("windowState").GetString();
        if (string.Equals(windowState, "maximized", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        if (string.Equals(windowState, "minimized", StringComparison.OrdinalIgnoreCase)
            || string.Equals(windowState, "fullscreen", StringComparison.OrdinalIgnoreCase))
        {
            await ExecuteRootCommandAsync(
                "Browser.setWindowBounds",
                new { windowId, bounds = new { windowState = "normal" } },
                cancellationToken);
            // Leaving fullscreen (or restoring a minimized maximized window) can
            // restore its previous maximized state without passing through normal.
            var restoredState = await WaitForWindowStateAsync(windowId, "normal", cancellationToken,
                allowMaximized: true);
            if (string.Equals(restoredState, "maximized", StringComparison.OrdinalIgnoreCase)) return;
        }

        await ExecuteRootCommandAsync(
            "Browser.setWindowBounds",
            new { windowId, bounds = new { windowState = "maximized" } },
            cancellationToken);
        await WaitForWindowStateAsync(windowId, "maximized", cancellationToken);
    }

    private async Task<string> WaitForWindowStateAsync(int windowId, string expectedState,
        CancellationToken cancellationToken, bool allowMaximized = false)
    {
        var deadline = DateTime.UtcNow.AddSeconds(2);
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var info = await ExecuteRootCommandAsync(
                "Browser.getWindowBounds", new { windowId }, cancellationToken);
            var state = info.GetProperty("bounds").GetProperty("windowState").GetString();
            if (string.Equals(state, expectedState, StringComparison.OrdinalIgnoreCase)
                || (allowMaximized && string.Equals(state, "maximized", StringComparison.OrdinalIgnoreCase)))
                return state!;
            if (DateTime.UtcNow >= deadline)
                throw new TimeoutException("브라우저 창의 복원·최대화를 확인하지 못했습니다. 다시 눌러 주세요.");
            await Task.Delay(50, cancellationToken);
        }
    }

    public async Task ClickAsync(double x, double y, CancellationToken cancellationToken = default)
    {
        await ExecuteSessionCommandWithoutResultAsync(
            "Input.dispatchMouseEvent",
            new { type = "mousePressed", x, y, button = "left", clickCount = 1 },
            cancellationToken);
        await ExecuteSessionCommandWithoutResultAsync(
            "Input.dispatchMouseEvent",
            new { type = "mouseReleased", x, y, button = "left", clickCount = 1 },
            cancellationToken);
    }

    public async Task PressKeyAsync(
        string key,
        string code,
        int virtualKeyCode,
        CancellationToken cancellationToken = default)
    {
        var keyDown = new
        {
            type = "rawKeyDown",
            key,
            code,
            windowsVirtualKeyCode = virtualKeyCode,
            nativeVirtualKeyCode = virtualKeyCode,
        };
        var keyUp = new
        {
            type = "keyUp",
            key,
            code,
            windowsVirtualKeyCode = virtualKeyCode,
            nativeVirtualKeyCode = virtualKeyCode,
        };

        await ExecuteSessionCommandWithoutResultAsync("Input.dispatchKeyEvent", keyDown, cancellationToken);
        await ExecuteSessionCommandWithoutResultAsync("Input.dispatchKeyEvent", keyUp, cancellationToken);
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
        {
            return ValueTask.CompletedTask;
        }

        try
        {
            _socket.Abort();
        }
        finally
        {
            _socket.Dispose();
            _commandLock.Dispose();
        }

        return ValueTask.CompletedTask;
    }

    private Task<JsonElement> ExecuteRootCommandAsync(
        string method,
        object parameters,
        CancellationToken cancellationToken)
    {
        return ExecuteCommandAsync(method, parameters, includeSessionId: false, cancellationToken);
    }

    private Task<JsonElement> ExecuteSessionCommandAsync(
        string method,
        object parameters,
        CancellationToken cancellationToken)
    {
        if (_sessionId is null)
        {
            throw new InvalidOperationException("브라우저 탭 연결이 완료되지 않았습니다.");
        }

        return ExecuteCommandAsync(method, parameters, includeSessionId: true, cancellationToken);
    }

    private async Task ExecuteSessionCommandWithoutResultAsync(
        string method,
        object parameters,
        CancellationToken cancellationToken)
    {
        await ExecuteSessionCommandAsync(method, parameters, cancellationToken);
    }

    private async Task<JsonElement> ExecuteCommandAsync(
        string method,
        object parameters,
        bool includeSessionId,
        CancellationToken cancellationToken)
    {
        using var commandCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        commandCancellation.CancelAfter(CommandTimeout);
        var commandToken = commandCancellation.Token;
        var lockAcquired = false;
        try
        {
            await _commandLock.WaitAsync(commandToken);
            lockAcquired = true;
            var commandId = Interlocked.Increment(ref _nextCommandId);
            object command = includeSessionId
                ? new { id = commandId, sessionId = _sessionId, method, @params = parameters }
                : new { id = commandId, method, @params = parameters };
            var payload = JsonSerializer.SerializeToUtf8Bytes(command);
            await _socket.SendAsync(
                new ArraySegment<byte>(payload),
                WebSocketMessageType.Text,
                true,
                commandToken);

            while (true)
            {
                using var message = await ReceiveMessageAsync(commandToken);
                var root = message.RootElement;
                if (!root.TryGetProperty("id", out var responseId) || responseId.GetInt32() != commandId)
                {
                    continue;
                }

                if (root.TryGetProperty("error", out var error))
                {
                    var exception = new InvalidOperationException($"브라우저 제어 명령이 거부되었습니다: {error}");
                    AppLogger.Error("DevTools", $"명령 실패: {method}", exception);
                    throw exception;
                }

                return root.GetProperty("result").Clone();
            }
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested)
        {
            _socket.Abort();
            var timeoutException = new DevToolsCommandTimeoutException(
                $"브라우저 제어 명령({method}) 응답 시간이 초과되었습니다.",
                exception);
            AppLogger.Error("DevTools", $"명령 시간 초과: {method}", timeoutException);
            throw timeoutException;
        }
        finally
        {
            if (lockAcquired)
            {
                _commandLock.Release();
            }
        }
    }

    private async Task<JsonDocument> ReceiveMessageAsync(CancellationToken cancellationToken)
    {
        using var stream = new MemoryStream();
        var buffer = new byte[64 * 1024];
        WebSocketReceiveResult result;
        do
        {
            result = await _socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
            if (result.MessageType == WebSocketMessageType.Close)
            {
                throw new WebSocketException("브라우저 제어 연결이 종료되었습니다.");
            }

            stream.Write(buffer, 0, result.Count);
        }
        while (!result.EndOfMessage);

        return JsonDocument.Parse(stream.ToArray());
    }
}
