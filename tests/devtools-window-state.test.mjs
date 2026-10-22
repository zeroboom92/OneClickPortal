import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('actual DevTools transport confirms target window restoration and maximization before completing',
  { timeout: 150_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-window-state-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'DevToolsAutomation.cs'))}" Link="DevToolsAutomation.cs" />
          <Compile Include="${xml(resolve(root, 'BrowserSupport.cs'))}" Link="BrowserSupport.cs" />
          <Compile Include="${xml(resolve(root, 'EducationOffice.cs'))}" Link="EducationOffice.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'],
        { timeout: 90_000, maxBuffer: 1024 * 1024 }).catch(error => {
          assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
        });
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      const scenarios = [
        ['normal', 'waits for delayed maximization of the target window'],
        ['minimized', 'confirms restoration from minimized before requesting maximization'],
        ['fullscreen', 'confirms restoration from fullscreen before requesting maximization'],
        ['restore-to-maximized', 'accepts fullscreen restoration directly to an already maximized target'],
        ['maximized', 'leaves an already maximized target unchanged'],
        ['never-normal', 'times out when the target never leaves minimized state'],
        ['never-maximized', 'times out when acknowledged maximization never takes effect'],
        ['cancellation', 'propagates caller cancellation during state polling'],
        ['restore-rejected', 'propagates a rejected restore without requesting maximization'],
        ['maximize-rejected', 'propagates a rejected maximization'],
        ['transport-closed', 'propagates a disconnected transport without reporting success'],
      ];
      for (const [scenario, name] of scenarios) {
        await t.test(name, async () => {
          const result = await run('dotnet', [assembly, scenario],
            { timeout: 15_000, maxBuffer: 1024 * 1024 }).catch(error => {
              assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
            });
          assert.match(result.stdout, new RegExp('PASS: ' + scenario));
        });
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-window-state-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

// The production session attaches through actual local HTTP and WebSocket CDP
// traffic. Only the browser server is simulated; its target belongs to a window
// different from the originally connected source window.
const probe = String.raw`
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BrowserThumbnailPrototype;

void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
async Task<T> ThrowsAsync<T>(Func<Task> action) where T : Exception
{
    try { await action(); }
    catch (T error) { return error; }
    throw new Exception("Expected " + typeof(T).Name + " was not thrown.");
}

var scenario = args.Single();
var initial = scenario switch {
    "minimized" or "never-normal" or "restore-rejected" => "minimized",
    "fullscreen" or "restore-to-maximized" => "fullscreen",
    "maximized" => "maximized",
    _ => "normal",
};
await using var browser = new FakeBrowser(initial);
switch (scenario)
{
    case "never-normal": browser.NeverCompleteState = "normal"; break;
    case "never-maximized" or "cancellation": browser.NeverCompleteState = "maximized"; break;
    case "restore-rejected": browser.RejectState = "normal"; break;
    case "maximize-rejected": browser.RejectState = "maximized"; break;
    case "transport-closed": browser.DropMethod = "Browser.setWindowBounds"; break;
    case "restore-to-maximized": browser.RestoreToMaximized = true; break;
}
await using var session = await DevToolsSession.ConnectAsync(browser.Port, FakeBrowser.TargetId);
var elapsed = Stopwatch.StartNew();
switch (scenario)
{
    case "never-normal" or "never-maximized":
        await ThrowsAsync<TimeoutException>(() => session.MaximizeTargetWindowAsync());
        Check(elapsed.Elapsed < TimeSpan.FromSeconds(6), "Window transition timeout was not bounded.");
        Check(browser.State == initial, "Fixture unexpectedly completed a forbidden transition.");
        Check(browser.ObservedStates.Count >= 3, "A delayed transition was rejected without polling its state.");
        if (scenario == "never-normal")
            Check(browser.RequestedStates.SequenceEqual(new[] { "normal" }), "Maximization was requested before restore was confirmed.");
        else
            Check(browser.RequestedStates.SequenceEqual(new[] { "maximized" }), "A failed maximization was resent.");
        break;
    case "cancellation":
        using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(180)))
        {
            await ThrowsAsync<OperationCanceledException>(() => session.MaximizeTargetWindowAsync(cancellation.Token));
            Check(cancellation.IsCancellationRequested, "Cancellation did not belong to the caller.");
            Check(elapsed.Elapsed < TimeSpan.FromSeconds(2), "Caller cancellation waited for the transition deadline.");
        }
        Check(browser.State == "normal", "Canceled operation unexpectedly maximized the window.");
        Check(browser.RequestedStates.SequenceEqual(new[] { "maximized" }), "Cancellation did not interrupt the in-progress maximization.");
        break;
    case "restore-rejected" or "maximize-rejected":
        await ThrowsAsync<InvalidOperationException>(() => session.MaximizeTargetWindowAsync());
        Check(browser.RequestedStates.SequenceEqual(new[] { browser.RejectState! }), "A rejected command was retried or followed by another mutation.");
        Check(browser.State == initial, "Rejected transition changed the fixture window.");
        break;
    case "transport-closed":
        await ThrowsAsync<WebSocketException>(() => session.MaximizeTargetWindowAsync());
        Check(browser.State == initial, "Disconnected transport unexpectedly completed maximization.");
        break;
    default:
        await session.MaximizeTargetWindowAsync();
        Check(browser.State == "maximized", "Method completed before the target became maximized.");
        Check(browser.ObservedStates.LastOrDefault() == "maximized", "Method did not confirm the maximized state through CDP.");
        var expected = scenario == "restore-to-maximized" ? new[] { "normal" } : initial switch {
            "minimized" or "fullscreen" => new[] { "normal", "maximized" },
            "normal" => new[] { "maximized" },
            _ => Array.Empty<string>(),
        };
        Check(browser.RequestedStates.SequenceEqual(expected), "Wrong restore/maximize command order.");
        if (initial != "maximized")
            Check(browser.ObservedStates.Count > 2, "Delayed state transitions were not observed.");
        break;
}
Check(browser.Commands.First().Method == "Target.attachToTarget", "Production session did not attach to the target.");
Check(browser.Commands.Count(command => command.Method == "Browser.getWindowForTarget") == 1,
    "Target window identity was not resolved exactly once.");
Check(browser.Commands.Where(command => command.Method is "Browser.getWindowBounds" or "Browser.setWindowBounds")
        .All(command => command.Parameters.GetProperty("windowId").GetInt32() == FakeBrowser.TargetWindowId),
    "A source or unrelated window was read or mutated.");
Check(!browser.Commands.Any(command => command.Parameters.TryGetProperty("windowId", out var id)
        && id.GetInt32() == FakeBrowser.SourceWindowId), "Original source window was selected instead of the task window.");
Console.WriteLine("PASS: " + scenario);

internal sealed record Command(string Method, JsonElement Parameters);

internal sealed class FakeBrowser : IAsyncDisposable
{
    public const string TargetId = "task-tab-in-another-window";
    public const int SourceWindowId = 7;
    public const int TargetWindowId = 41;
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentBag<Task> _handlers = new();
    private readonly Task _accept;
    private string? _pendingState;
    private int _readsBeforeTransition;
    public int Port { get; }
    public string State { get; private set; }
    public string? NeverCompleteState { get; set; }
    public string? RejectState { get; set; }
    public string? DropMethod { get; set; }
    public bool RestoreToMaximized { get; set; }
    public List<Command> Commands { get; } = new();
    public List<string> RequestedStates { get; } = new();
    public List<string> ObservedStates { get; } = new();

    public FakeBrowser(string state)
    {
        State = state;
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        if (Port >= 9222 && Port <= 9232) throw new Exception("Fixture must not touch the real browser port range.");
        _accept = AcceptAsync();
    }

    private async Task AcceptAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
                _handlers.Add(ServeAsync(await _listener.AcceptTcpClientAsync(_stop.Token)));
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using (client)
        {
            try
            {
                var stream = client.GetStream();
                var request = new StringBuilder();
                var oneByte = new byte[1];
                while (!request.ToString().EndsWith("\r\n\r\n", StringComparison.Ordinal))
                {
                    if (await stream.ReadAsync(oneByte, _stop.Token) == 0) return;
                    request.Append((char)oneByte[0]);
                    if (request.Length > 16 * 1024) throw new Exception("Unexpected oversized fixture request.");
                }
                var lines = request.ToString().Split("\r\n");
                var path = lines[0].Split(' ')[1];
                if (path == "/json/version")
                {
                    var body = JsonSerializer.Serialize(new {
                        Browser = "Edg/155.0", webSocketDebuggerUrl = $"ws://127.0.0.1:{Port}/devtools/browser/fixture"
                    });
                    var response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                        + Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n" + body;
                    await stream.WriteAsync(Encoding.UTF8.GetBytes(response), _stop.Token);
                    return;
                }
                if (path != "/devtools/browser/fixture") throw new Exception("Unexpected fixture path: " + path);
                var key = lines.Single(line => line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase))
                    .Split(':', 2)[1].Trim();
                var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
                await stream.WriteAsync(Encoding.ASCII.GetBytes("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n"), _stop.Token);
                using var socket = WebSocket.CreateFromStream(stream, isServer: true, subProtocol: null, keepAliveInterval: Timeout.InfiniteTimeSpan);
                var buffer = new byte[64 * 1024];
                while (!_stop.IsCancellationRequested)
                {
                    using var payload = new MemoryStream();
                    WebSocketReceiveResult message;
                    do
                    {
                        message = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), _stop.Token);
                        if (message.MessageType == WebSocketMessageType.Close) return;
                        payload.Write(buffer, 0, message.Count);
                    } while (!message.EndOfMessage);
                    using var document = JsonDocument.Parse(payload.ToArray());
                    var command = document.RootElement;
                    var id = command.GetProperty("id").GetInt32();
                    var method = command.GetProperty("method").GetString()!;
                    var parameters = command.GetProperty("params").Clone();
                    Commands.Add(new Command(method, parameters));
                    if (DropMethod == method) { socket.Abort(); return; }
                    object? result = null;
                    string? error = null;
                    switch (method)
                    {
                        case "Target.attachToTarget":
                            if (parameters.GetProperty("targetId").GetString() != TargetId) error = "Wrong target attached.";
                            else result = new { sessionId = "fixture-session" };
                            break;
                        case "Browser.getWindowForTarget":
                            if (parameters.GetProperty("targetId").GetString() != TargetId) error = "Wrong target window selected.";
                            else result = new { windowId = TargetWindowId, bounds = new { windowState = State } };
                            break;
                        case "Browser.getWindowBounds":
                            if (parameters.GetProperty("windowId").GetInt32() != TargetWindowId) error = "Wrong window read.";
                            else
                            {
                                if (_pendingState is not null && _readsBeforeTransition-- <= 0)
                                {
                                    State = _pendingState;
                                    _pendingState = null;
                                }
                                ObservedStates.Add(State);
                                result = new { bounds = new { windowState = State } };
                            }
                            break;
                        case "Browser.setWindowBounds":
                            var requested = parameters.GetProperty("bounds").GetProperty("windowState").GetString()!;
                            RequestedStates.Add(requested);
                            if (parameters.GetProperty("windowId").GetInt32() != TargetWindowId) error = "Wrong window changed.";
                            else if (requested == RejectState) error = "Fixture rejected " + requested;
                            else if (requested == "maximized" && State is "minimized" or "fullscreen")
                                error = "Maximization requested before restoration was confirmed.";
                            else
                            {
                                if (requested != NeverCompleteState)
                                {
                                    _pendingState = requested == "normal" && RestoreToMaximized ? "maximized" : requested;
                                    _readsBeforeTransition = 2;
                                }
                                result = new { };
                            }
                            break;
                        default: error = "Unexpected CDP command: " + method; break;
                    }
                    var responseBytes = error is null
                        ? JsonSerializer.SerializeToUtf8Bytes(new { id, result })
                        : JsonSerializer.SerializeToUtf8Bytes(new { id, error = new { code = -32000, message = error } });
                    await socket.SendAsync(new ArraySegment<byte>(responseBytes), WebSocketMessageType.Text, true, _stop.Token);
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (IOException) { /* Client cancellation/disposal can close the transport first. */ }
            catch (WebSocketException) { /* Production DisposeAsync aborts the test client socket. */ }
        }
    }

    public async ValueTask DisposeAsync()
    {
        _stop.Cancel();
        _listener.Stop();
        await _accept;
        await Task.WhenAll(_handlers);
        _stop.Dispose();
    }
}

namespace BrowserThumbnailPrototype
{
    internal static class AppLogger
    {
        public static void Info(string area, string message) { }
        public static void Error(string area, string message, Exception exception) { }
    }
}
`;
