import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { browserForegroundStub } from './helpers/browser-foreground-fixture.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('actual DevTools discovery handles local HTTP failures without touching running browsers',
  { timeout: 150_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-devtools-discovery-'));
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
      await writeFile(join(directory, 'BrowserForeground.cs'), browserForegroundStub);
      await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'],
        { timeout: 90_000, maxBuffer: 1024 * 1024 }).catch(error => {
          assert.fail([error.message, error.stdout, error.stderr].filter(Boolean).join('\n'));
        });
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      const cases = [
        ['official-sites', 'recognizes exact HTTPS portal, NEIS and Edufine hosts for every education office'],
        ['wrong-office', 'reports another office without treating it as the selected portal'],
        ['host-spoofing', 'rejects host substrings, user information, insecure URLs and non-page targets'],
        ['malformed', 'classifies malformed metadata and target JSON without escaping discovery'],
        ['unreachable', 'classifies refused connections and silent endpoints as unreachable'],
        ['redirect', 'does not follow a local endpoint redirect'],
        ['socket-validation', 'accepts only matching local browser WebSocket addresses'],
        ['proxy', 'bypasses an environment proxy for both local discovery requests'],
        ['browser-separation', 'matches the selected Edge or Chrome browser before inspecting targets'],
        ['port-isolation', 'keeps all probe failures and refuses ambiguous ready ports'],
        ['cancellation', 'propagates user cancellation through HTTP and aggregate discovery'],
      ];
      for (const [scenario, name] of cases) {
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
      assert.ok(basename(directory).startsWith('oneclick-devtools-discovery-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using BrowserThumbnailPrototype;

var scenario = args.Single();
var selected = EducationOfficeCatalog.GetByCode("goe");
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
string Targets(params DevToolsTarget[] targets) => JsonSerializer.Serialize(targets);
DevToolsTarget Target(string url, string type = "page") => new("target-id", type, "fixture", url);
string Version(string socket, string browser = "Edg/155.0") => JsonSerializer.Serialize(new { Browser = browser, webSocketDebuggerUrl = socket });
string LocalSocket(FakeEndpoint server) => $"ws://127.0.0.1:{server.Port}/devtools/browser/fixture-id";
void SetNormal(FakeEndpoint server, string targets)
{
    server.Respond = path => FakeEndpoint.Json(path == "/json/version" ? Version(LocalSocket(server)) : targets);
}
async Task InvalidSocket(string socket)
{
    await using var server = new FakeEndpoint();
    server.Respond = _ => FakeEndpoint.Json(Version(socket.Replace("{port}", server.Port.ToString())));
    try { await DevToolsDiscovery.GetBrowserWebSocketUriAsync(server.Port); }
    catch (InvalidOperationException) { return; }
    throw new Exception("Unsafe browser socket was accepted: " + socket);
}
async Task Canceled(Func<CancellationToken, Task> action)
{
    using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(80));
    try { await action(cancellation.Token); }
    catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { return; }
    throw new Exception("Explicit user cancellation was swallowed.");
}

switch (scenario)
{
    case "official-sites":
        await using (var server = new FakeEndpoint())
        {
            foreach (var office in EducationOfficeCatalog.All)
                foreach (var uri in new[] { office.PortalUri, office.NiceUri, office.EdufineUri })
                {
                    SetNormal(server, Targets(Target(uri.AbsoluteUri)));
                    var result = await DevToolsDiscovery.ProbePortAsync(server.Port, office);
                    Check(result.Port == server.Port && result.Status == DevToolsProbeStatus.Ready,
                        "Official site was not ready: " + uri);
                    Check(result.OfficeCodes.SequenceEqual(new[] { office.Code }), "Wrong office diagnosis: " + uri);
                }
            SetNormal(server, Targets(Target(selected.PortalUri.AbsoluteUri, "iframe")));
            Check((await DevToolsDiscovery.ProbePortAsync(server.Port, selected)).Status == DevToolsProbeStatus.Ready,
                "Official portal iframe should be recognized.");
        }
        break;

    case "wrong-office":
        await using (var server = new FakeEndpoint())
        {
            SetNormal(server, Targets(Target("https://sen.eduptl.kr/"), Target("https://sen.neis.go.kr/")));
            var result = await DevToolsDiscovery.ProbePortAsync(server.Port, selected);
            Check(result.Status == DevToolsProbeStatus.NoPortalTarget, "Another office was selected.");
            Check(result.OfficeCodes.SequenceEqual(new[] { "sen" }), "Other office must be reported once.");
            SetNormal(server, "[]");
            result = await DevToolsDiscovery.ProbePortAsync(server.Port, selected);
            Check(result.Status == DevToolsProbeStatus.NoPortalTarget && result.OfficeCodes.Count == 0,
                "An empty browser must be distinguished from a failed channel.");
        }
        break;

    case "host-spoofing":
        await using (var server = new FakeEndpoint())
        {
            var urls = new[] {
                "https://goe.eduptl.kr.evil.example/", "https://evil.example/?return=goe.eduptl.kr",
                "https://evil.example/goe.neis.go.kr", "https://goe.eduptl.kr@evil.example/",
                "https://prefix-goe.eduptl.kr/", "http://goe.eduptl.kr/", "not-a-url-goe.eduptl.kr",
            };
            foreach (var url in urls)
            {
                SetNormal(server, Targets(Target(url)));
                var result = await DevToolsDiscovery.ProbePortAsync(server.Port, selected);
                Check(result.Status == DevToolsProbeStatus.NoPortalTarget && result.OfficeCodes.Count == 0,
                    "Non-official address was recognized: " + url);
            }
            SetNormal(server, Targets(Target(selected.PortalUri.AbsoluteUri, "service_worker")));
            Check((await DevToolsDiscovery.ProbePortAsync(server.Port, selected)).Status == DevToolsProbeStatus.NoPortalTarget,
                "A worker is not an interactive portal target.");
            SetNormal(server, Targets(Target("https://GOE.EDUPTL.KR/path?office=goe")));
            Check((await DevToolsDiscovery.ProbePortAsync(server.Port, selected)).Status == DevToolsProbeStatus.Ready,
                "A valid case-insensitive HTTPS host was rejected.");
        }
        break;

    case "malformed":
        await using (var server = new FakeEndpoint())
        {
            foreach (var body in new[] { "<html>blocked</html>", "{}", "null", "[]", "{\"webSocketDebuggerUrl\":1}" })
            {
                server.Respond = _ => FakeEndpoint.Json(body);
                var result = await DevToolsDiscovery.ProbePortAsync(server.Port, selected);
                Check(result.Status == DevToolsProbeStatus.InvalidResponse, "Malformed version escaped diagnosis: " + body);
                Check(!string.IsNullOrWhiteSpace(result.FailureKind), "Malformed version omitted the failure type.");
            }
            foreach (var body in new[] { "<html>blocked</html>", "{}", "null", "[null]", "[{}]",
                "[{\"id\":\"a\",\"type\":\"page\",\"url\":null}]" })
            {
                SetNormal(server, body);
                Check((await DevToolsDiscovery.ProbePortAsync(server.Port, selected)).Status == DevToolsProbeStatus.InvalidResponse,
                    "Malformed target list escaped diagnosis: " + body);
            }
        }
        break;

    case "unreachable":
        int unusedPort;
        await using (var closed = new FakeEndpoint()) { unusedPort = closed.Port; }
        var refused = await DevToolsDiscovery.ProbePortAsync(unusedPort, selected);
        Check(refused.Status == DevToolsProbeStatus.Unreachable, "Connection refusal was not isolated.");
        await using (var silent = new FakeEndpoint())
        {
            silent.Respond = _ => null;
            var timer = Stopwatch.StartNew();
            var timeout = await DevToolsDiscovery.ProbePortAsync(silent.Port, selected);
            Check(timeout.Status == DevToolsProbeStatus.Unreachable, "Silent channel did not report timeout.");
            Check(timer.Elapsed < TimeSpan.FromSeconds(5), "Silent channel exceeded its timeout bound.");
        }
        break;

    case "redirect":
        await using (var destination = new FakeEndpoint())
        await using (var redirect = new FakeEndpoint())
        {
            SetNormal(destination, Targets(Target(selected.PortalUri.AbsoluteUri)));
            redirect.Respond = _ => FakeEndpoint.Redirect($"http://127.0.0.1:{destination.Port}/json/version");
            var result = await DevToolsDiscovery.ProbePortAsync(redirect.Port, selected);
            Check(result.Status != DevToolsProbeStatus.Ready, "A redirect was accepted as a DevTools endpoint.");
            Check(destination.Requests.IsEmpty, "Discovery followed the redirect.");
        }
        break;

    case "socket-validation":
        await using (var server = new FakeEndpoint())
        {
            foreach (var host in new[] { "127.0.0.1", "localhost", "[::1]" })
            {
                var socket = $"ws://{host}:{server.Port}/devtools/browser/fixture-id";
                server.Respond = _ => FakeEndpoint.Json(Version(socket));
                Check((await DevToolsDiscovery.GetBrowserWebSocketUriAsync(server.Port)).AbsoluteUri == new Uri(socket).AbsoluteUri,
                    "Valid local browser socket was rejected: " + socket);
            }
        }
        foreach (var socket in new[] {
            "ws://evil.example:{port}/devtools/browser/id", "ws://127.0.0.1:1/devtools/browser/id",
            "http://127.0.0.1:{port}/devtools/browser/id", "wss://127.0.0.1:{port}/devtools/browser/id",
            "ws://user:secret@127.0.0.1:{port}/devtools/browser/id", "ws://127.0.0.1:{port}/devtools/browser/id?token=secret",
            "ws://127.0.0.1:{port}/devtools/browser/id#fragment", "ws://127.0.0.1:{port}/devtools/page/id",
            "ws://127.0.0.1:{port}/devtools/browser/", "not-a-socket",
        }) await InvalidSocket(socket);
        break;

    case "proxy":
        await using (var proxy = new FakeEndpoint())
        await using (var server = new FakeEndpoint())
        {
            proxy.Respond = _ => FakeEndpoint.Json("{\"proxy\":\"must not be used\"}");
            var proxyUri = $"http://127.0.0.1:{proxy.Port}";
            foreach (var name in new[] { "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy" })
                Environment.SetEnvironmentVariable(name, proxyUri);
            Environment.SetEnvironmentVariable("NO_PROXY", "");
            Environment.SetEnvironmentVariable("no_proxy", "");
            SetNormal(server, Targets(Target(selected.PortalUri.AbsoluteUri)));
            Check((await DevToolsDiscovery.ProbePortAsync(server.Port, selected)).Status == DevToolsProbeStatus.Ready,
                "Environment proxy prevented loopback discovery.");
            Check(server.Requests.Contains("/json/version") && server.Requests.Contains("/json/list"),
                "The real local endpoints were not reached.");
            Check(proxy.Requests.IsEmpty, "Local discovery leaked to a proxy.");
        }
        break;

    case "port-isolation":
        var calls = new ConcurrentBag<int>();
        async Task<DevToolsPortProbe> Probe(int port, CancellationToken token)
        {
            calls.Add(port);
            await Task.Delay(port == 9223 ? 30 : 1, token);
            var status = port switch {
                9222 => DevToolsProbeStatus.Unreachable,
                9223 or 9227 => DevToolsProbeStatus.Ready,
                9224 => DevToolsProbeStatus.InvalidResponse,
                _ => DevToolsProbeStatus.NoPortalTarget,
            };
            return new(port, status, status == DevToolsProbeStatus.Ready ? new[] { selected.Code } : Array.Empty<string>());
        }
        var discovery = await DevToolsDiscovery.InspectPortalPortsAsync(selected, Probe);
        Check(discovery.Port is null, "Multiple ready channels were silently guessed.");
        Check(discovery.Probes.Where(p => p.Port is 9223 or 9227).All(p => p.Status == DevToolsProbeStatus.Ambiguous),
            "Ambiguous ready channels did not preserve their diagnosis.");
        Check(calls.Order().SequenceEqual(Enumerable.Range(9222, 11)), "The supported port range was not inspected exactly once.");
        Check(discovery.Probes.Count == 11 && discovery.Probes.Any(p => p.Status == DevToolsProbeStatus.InvalidResponse)
            && discovery.Probes.Any(p => p.Status == DevToolsProbeStatus.Unreachable), "Failure diagnostics were discarded.");
        var absent = await DevToolsDiscovery.InspectPortalPortsAsync(selected,
            (port, token) => Task.FromResult(new DevToolsPortProbe(port, DevToolsProbeStatus.Unreachable, Array.Empty<string>())));
        Check(absent.Port is null && absent.Probes.Count == 11, "A missing channel was not reported completely.");
        var unique = await DevToolsDiscovery.InspectPortalPortsAsync(selected,
            (port, token) => Task.FromResult(new DevToolsPortProbe(port,
                port == 9227 ? DevToolsProbeStatus.Ready : DevToolsProbeStatus.Unreachable,
                port == 9227 ? new[] { selected.Code } : Array.Empty<string>())));
        Check(unique.Port == 9227 && unique.Probes.Count == 11, "One ready channel was not selected.");
        break;

    case "browser-separation":
        await using (var server = new FakeEndpoint())
        {
            foreach (var browser in new[] { PortalBrowser.Edge, PortalBrowser.Chrome })
            {
                var matching = browser == PortalBrowser.Edge ? "Edg/155.0" : "Chrome/155.0";
                var other = browser == PortalBrowser.Edge ? "Chrome/155.0" : "Edg/155.0";
                foreach (var product in new[] { other, "HeadlessChrome/155.0", "Chromium/155.0", "" })
                {
                    server.Requests.Clear();
                    server.Respond = path => FakeEndpoint.Json(path == "/json/version" ? Version(LocalSocket(server), product)
                        : Targets(Target(selected.PortalUri.AbsoluteUri)));
                    var mismatch = await DevToolsDiscovery.ProbePortAsync(server.Port, selected, browser: browser);
                    Check(mismatch.Status == DevToolsProbeStatus.BrowserMismatch, "Wrong browser was not diagnosed: " + product);
                    Check(server.Requests.SequenceEqual(new[] { "/json/version" }), "Wrong browser targets were inspected.");
                }
                server.Respond = path => FakeEndpoint.Json(path == "/json/version" ? Version(LocalSocket(server), matching)
                    : Targets(Target(selected.PortalUri.AbsoluteUri)));
                Check((await DevToolsDiscovery.ProbePortAsync(server.Port, selected, browser: browser)).Status == DevToolsProbeStatus.Ready,
                    "Selected browser was rejected: " + matching);
                Check((await DevToolsDiscovery.ProbePortAsync(server.Port, selected)).Status == DevToolsProbeStatus.Ready,
                    "Browser-neutral diagnosis rejected a valid channel.");
            }
        }
        break;

    case "cancellation":
        await using (var server = new FakeEndpoint())
        {
            server.Respond = _ => null;
            await Canceled(async token => { await DevToolsDiscovery.ProbePortAsync(server.Port, selected, token); });
            await Canceled(async token => { await DevToolsDiscovery.GetTargetsAsync(server.Port, token); });
            await Canceled(async token => { await DevToolsDiscovery.GetBrowserWebSocketUriAsync(server.Port, token); });
        }
        await Canceled(async token => {
            await DevToolsDiscovery.InspectPortalPortsAsync(selected, async (port, probeToken) => {
                await Task.Delay(Timeout.Infinite, probeToken);
                return new DevToolsPortProbe(port, DevToolsProbeStatus.Unreachable, Array.Empty<string>());
            }, token);
        });
        break;

    default: throw new Exception("Unknown test scenario.");
}
Console.WriteLine("PASS: " + scenario);

internal sealed class FakeEndpoint : IAsyncDisposable
{
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private readonly ConcurrentBag<Task> _handlers = new();
    private readonly Task _accept;
    public int Port { get; }
    public ConcurrentQueue<string> Requests { get; } = new();
    public Func<string, string?> Respond { get; set; } = _ => Json("{}");

    public FakeEndpoint()
    {
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        if (Port >= 9222 && Port <= 9232) throw new Exception("Fixture must not use the real browser port range.");
        _accept = AcceptAsync();
    }

    public static string Json(string body) => "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
        + Encoding.UTF8.GetByteCount(body) + "\r\nConnection: close\r\n\r\n" + body;
    public static string Redirect(string destination) => "HTTP/1.1 302 Found\r\nLocation: " + destination
        + "\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

    private async Task AcceptAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token);
                _handlers.Add(ServeAsync(client));
            }
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
                var buffer = new byte[2048];
                while (!request.ToString().Contains("\r\n\r\n", StringComparison.Ordinal))
                {
                    var length = await stream.ReadAsync(buffer, _stop.Token);
                    if (length == 0) return;
                    request.Append(Encoding.ASCII.GetString(buffer, 0, length));
                    if (request.Length > 16 * 1024) throw new Exception("Unexpected oversized fixture request.");
                }
                var path = request.ToString().Split(' ')[1];
                Requests.Enqueue(path);
                var response = Respond(path);
                if (response is null) await Task.Delay(Timeout.Infinite, _stop.Token);
                else await stream.WriteAsync(Encoding.UTF8.GetBytes(response), _stop.Token);
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
            catch (IOException) { /* A canceled client may close its socket first. */ }
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
