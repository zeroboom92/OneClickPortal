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

test('actual DevTools foreground confirmation requires focused page and stable verified native HWND',
  { timeout: 150_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-devtools-foreground-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          ${['DevToolsAutomation.cs', 'BrowserSupport.cs', 'EducationOffice.cs'].map(name =>
            `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('\n')}
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'],
        { timeout: 90_000, maxBuffer: 1024 * 1024 }).catch(error => {
          assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
        });
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      for (const scenario of ['stable', 'unfocused', 'no-native-window', 'wrong-process', 'changing-hwnd',
        'unstable-focus', 'focus-lost-during-await', 'evaluate-rejected', 'focus-rejected', 'evaluate-hung', 'transport-closed',
        'reconfirmation-failed', 'pre-cancelled', 'cancelled-during-confirmation']) {
        await t.test(scenario, async () => {
          const result = await run('dotnet', [assembly, scenario],
            { timeout: 15_000, maxBuffer: 1024 * 1024 }).catch(error => {
              assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
            });
          assert.match(result.stdout, new RegExp('PASS: ' + scenario));
        });
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-devtools-foreground-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

// The actual production session uses a dedicated loopback HTTP/WebSocket server.
// Native foreground validation is injected and never touches a real app/window.
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
var scenario = args.Single();
await using var browser = new FakeBrowser(scenario);
BrowserForeground.ExpectedPort = browser.Port;
BrowserForeground.Read = read => scenario switch {
    "no-native-window" => IntPtr.Zero,
    "wrong-process" => IntPtr.Zero, // The native adapter's ownership mismatch result.
    "changing-hwnd" => new IntPtr(read % 2 == 0 ? 23 : 22),
    "focus-lost-during-await" => browser.FocusReads >= 2 ? IntPtr.Zero : new IntPtr(22),
    _ => new IntPtr(22)
};
await using var session = await DevToolsSession.ConnectAsync(browser.Port, FakeBrowser.TargetId);
if (scenario == "reconfirmation-failed")
{
    await session.ConfirmForegroundWindowAsync(default);
    Check(session.PresentedWindowHandle == new IntPtr(22), "Setup did not establish a prior confirmation.");
    browser.ForceUnfocused = true;
}
using var cancellation = new CancellationTokenSource();
if (scenario == "pre-cancelled") cancellation.Cancel();
if (scenario == "cancelled-during-confirmation") cancellation.CancelAfter(20);
var watch = Stopwatch.StartNew();
Exception? failure = null;
try { await session.ConfirmForegroundWindowAsync(cancellation.Token); }
catch (Exception error) { failure = error; }
watch.Stop();
if (scenario == "stable")
{
    Check(failure is null, "Stable focused target failed: " + failure);
    Check(session.PresentedWindowHandle == new IntPtr(22), "Confirmed native HWND was not recorded.");
    Check(BrowserForeground.ReadCount >= 2 && browser.FocusReads >= 2, "A single optimistic sample was treated as confirmation.");
    Check(watch.ElapsedMilliseconds >= 40, "Two confirmations were not separated by the stability interval.");
}
else
{
    if (scenario is "pre-cancelled" or "cancelled-during-confirmation")
        Check(failure is OperationCanceledException cancelled && cancelled.CancellationToken == cancellation.Token,
            "Caller cancellation was swallowed or replaced: " + failure);
    else Check(failure is BrowserForegroundException, "Unconfirmed browser focus did not produce a foreground failure: " + failure);
    Check(session.PresentedWindowHandle == IntPtr.Zero, "Unconfirmed target was recorded as presented.");
    if (scenario == "pre-cancelled") Check(browser.FocusReads == 0 && BrowserForeground.ReadCount == 0,
        "Pre-cancelled confirmation performed a side effect.");
}
Check(watch.Elapsed < TimeSpan.FromSeconds(5) && browser.FocusReads <= 20 && browser.BringRequests <= 8,
    "Foreground confirmation did not remain bounded.");
Check(browser.Commands.All(command => command is "Target.attachToTarget" or "Runtime.evaluate" or "Page.bringToFront"),
    "Confirmation navigated, closed, typed into or changed an unrelated target.");
Console.WriteLine("PASS: " + scenario);

internal sealed class FakeBrowser : IAsyncDisposable
{
    public const string TargetId = "foreground-probe-page";
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentBag<Task> _handlers = new();
    private readonly Task _accept;
    private readonly string _scenario;
    public int Port { get; }
    public int FocusReads { get; private set; }
    public int BringRequests { get; private set; }
    public bool ForceUnfocused { get; set; }
    public List<string> Commands { get; } = [];
    public FakeBrowser(string scenario)
    {
        _scenario = scenario;
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        if (Port is >= 9222 and <= 9232) throw new Exception("Fixture port must differ from the actual browser port range.");
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
                    if (request.Length > 16 * 1024) throw new Exception("Fixture received an oversized request.");
                }
                var lines = request.ToString().Split("\r\n");
                var path = lines[0].Split(' ')[1];
                if (path == "/json/version")
                {
                    var body = JsonSerializer.Serialize(new { Browser = "Edg/156.0", webSocketDebuggerUrl = $"ws://127.0.0.1:{Port}/devtools/browser/fixture" });
                    await stream.WriteAsync(Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                        + Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n" + body), _stop.Token);
                    return;
                }
                if (path != "/devtools/browser/fixture") throw new Exception("Unexpected fixture path.");
                var key = lines.Single(line => line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase)).Split(':', 2)[1].Trim();
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
                    Commands.Add(method);
                    object? result = null;
                    string? error = null;
                    switch (method)
                    {
                        case "Target.attachToTarget":
                            if (command.GetProperty("params").GetProperty("targetId").GetString() != TargetId) error = "Wrong target attached.";
                            else result = new { sessionId = "foreground-fixture-session" };
                            break;
                        case "Page.bringToFront":
                            BringRequests++;
                            if (_scenario == "focus-rejected") error = "Foreground request rejected.";
                            else result = new { };
                            break;
                        case "Runtime.evaluate":
                            FocusReads++;
                            if (_scenario == "transport-closed") { socket.Abort(); return; }
                            if (_scenario == "evaluate-hung") await Task.Delay(Timeout.Infinite, _stop.Token);
                            var expression = command.GetProperty("params").GetProperty("expression").GetString()!;
                            if (!expression.Contains("document.hasFocus", StringComparison.Ordinal)) error = "Only document focus may be read.";
                            else if (_scenario == "evaluate-rejected") error = "Focus evaluation rejected.";
                            else
                            {
                                var focused = !ForceUnfocused && (_scenario switch {
                                    "unfocused" or "focus-rejected" => false,
                                    "unstable-focus" => FocusReads % 2 == 1,
                                    _ => true
                                });
                                result = new { result = new { type = "boolean", value = focused } };
                            }
                            break;
                        default: error = "Unexpected command."; break;
                    }
                    var response = error is null ? JsonSerializer.SerializeToUtf8Bytes(new { id, result })
                        : JsonSerializer.SerializeToUtf8Bytes(new { id, error = new { code = -32000, message = error } });
                    await socket.SendAsync(new ArraySegment<byte>(response), WebSocketMessageType.Text, true, _stop.Token);
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (IOException) { }
            catch (WebSocketException) { }
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
    internal sealed class BrowserForegroundException(string message, Exception? inner = null) : InvalidOperationException(message, inner);
    internal static class BrowserForeground
    {
        internal static int ExpectedPort;
        internal static int ReadCount;
        internal static Func<int, IntPtr> Read = _ => throw new Exception("Native adapter not configured.");
        internal static IntPtr ReadForegroundBrowserWindow(int port)
        {
            if (port != ExpectedPort) throw new Exception("Confirmation used a different browser port.");
            return Read(++ReadCount);
        }
    }
    internal static class AppLogger
    {
        public static void Info(string area, string message) { }
        public static void Error(string area, string message, Exception exception) { }
    }
}
`;
