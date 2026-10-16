import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
const [launcher, main, devtools] = await Promise.all([
  'ControlledEdgeLauncher.cs', 'MainForm.cs', 'DevToolsAutomation.cs',
].map(file => readFile(resolve(root, file), 'utf8')));

test('successful reuse returns before profile permission writes and a second Edge process', () => {
  const login = main.split('private async Task LaunchControlledEdgeAsync()')[1]
    .split('internal void RequestPortalTask(')[0];
  const reuse = login.split('if (await ControlledEdgeLauncher.TryReuseAsync(educationOffice))')[1]
    .split('var edgePath = FindEdgeExecutable();')[0];
  const refreshAt = reuse.indexOf('RefreshBrowserWindows();');
  const selectAt = reuse.indexOf('SelectLaunchedPortalEdge();');
  const returnAt = reuse.indexOf('return;', selectAt);
  assert.ok(refreshAt >= 0 && selectAt > refreshAt && returnAt > selectAt,
    'Reuse must refresh, select the launched portal window and return within its success branch.');
  assert.doesNotMatch(reuse, /PrepareControlledProfile|Process\.Start|Preferences|lockfile/);
  assert.ok(login.indexOf('ControlledEdgeLauncher.TryReuseAsync') < login.indexOf('PrepareControlledProfile'));
  assert.ok(login.indexOf('return;', login.indexOf('ControlledEdgeLauncher.TryReuseAsync'))
    < login.indexOf('PrepareControlledProfile'));
  assert.match(login, /if \(!EdgeIntegrationPolicy\.PrepareControlledProfile\(educationOffice\)\)/);
  assert.ok(login.indexOf('PrepareControlledProfile') < login.indexOf('Process.Start(startInfo)'));
});

test('production reuse creates a visible new window and waits for activate plus maximize', () => {
  const entry = launcher.split('internal static async Task<bool> TryReuseAsync(')[0];
  assert.match(entry, /CancellationTokenSource\.CreateLinkedTokenSource\(cancellationToken\)/);
  assert.match(entry, /CancelAfter\(TimeSpan\.FromSeconds\(8\)\)/);
  assert.match(entry, /DevToolsSession\.CreateTargetAsync\(port, uri, token, newWindow: true\)/);
  assert.match(entry, /await session\.ActivateTargetAsync\(token\);\s*await session\.MaximizeTargetWindowAsync\(token\);/);
  assert.match(entry, /TryReuseAcrossPortsAsync\(office,/);
  assert.match(launcher, /new HttpClientHandler \{ UseProxy = false, AllowAutoRedirect = false \}/);
  const create = devtools.split('public static async Task<string> CreateTargetAsync(')[1]
    .split('public static async Task<DevToolsSession> ConnectAsync(')[0];
  assert.match(create, /bool newWindow = false/);
  assert.match(create, /new \{ url = uri\.AbsoluteUri, newWindow \}/);
});

test('actual controlled Edge reuse implementation with offline version and browser fixtures',
  { timeout: 120_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-edge-reuse-test-'));
    try {
      const project = join(directory, 'Probe.csproj');
      await writeFile(project, `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'ControlledEdgeLauncher.cs'))}" Link="ControlledEdgeLauncher.cs" />
          <Compile Include="${xml(resolve(root, 'EducationOffice.cs'))}" Link="EducationOffice.cs" />
        </ItemGroup>
      </Project>`);
      const selection = main.slice(main.indexOf('private void SelectLaunchedPortalEdge()'),
        main.indexOf('    /// <summary>', main.indexOf('private void SelectLaunchedPortalEdge()')));
      assert.ok(selection.includes('_sourceWindow') && selection.includes('_browserWindows.Items'));
      await writeFile(join(directory, 'Program.cs'), probe.replace('/* PRODUCTION_SELECTION */', selection));
      await run('dotnet', ['build', project, '--configuration', 'Release', '--nologo'],
        { timeout: 80_000, maxBuffer: 1024 * 1024 }).catch(error => {
          throw new Error(error.stdout + error.stderr, { cause: error });
        });
      const assembly = join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll');
      const cases = [
        ['versions', 'accepts local Edge metadata; rejects Chrome, remote sockets and malformed metadata'],
        ['available-port', 'occupied base port selects and releases an alternate port; exhaustion has a clear failure'],
        ['alternate-port', 'parallel production-range probing reuses the official portal on an alternate port'],
        ['multiport-ambiguity', 'multiple compatible endpoints prefer one official portal and reject ambiguous reuse'],
        ['reuse-existing', 'activates the one exact HTTPS portal page without creating another window'],
        ['create-window', 'creates one official portal window when there is no official portal page'],
        ['ambiguous', 'multiple official portal pages cause no browser mutation'],
        ['invalid-version', 'ineligible browser version prevents target enumeration and all mutations'],
        ['empty-id', 'missing existing or newly created target identity prevents activation'],
        ['failures', 'known failures at each browser operation return false for the guarded fallback'],
        ['cancellation', 'internal operation timeout falls back; explicit user cancellation propagates'],
        ['launched-selection', 'actual launched-window selection changes only one unconnected Edge portal candidate'],
      ];
      for (const [scenario, name] of cases) {
        await t.test(name, async () => {
          const result = await run('dotnet', [assembly, scenario], { timeout: 15_000, maxBuffer: 1024 * 1024 });
          assert.ok(result.stdout.includes('PASS: ' + scenario), result.stdout);
        });
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-edge-reuse-test-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Text.Json;
using System.Net.WebSockets;
using System.Net;
using System.Net.Sockets;

void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
JsonElement Version(string browser = "Edg/155.0.4283.45", string socket = "ws://127.0.0.1:9222/devtools/browser/test-id") =>
    JsonSerializer.SerializeToElement(new { Browser = browser, webSocketDebuggerUrl = socket });
var scenario = args.Single();
var office = EducationOfficeCatalog.GetByCode("jbe");
const int port = 9222;

if (scenario == "available-port")
{
    var listeners = new List<TcpListener>();
    try
    {
        void Occupy(int candidate)
        {
            var listener = new TcpListener(IPAddress.Loopback, candidate) { ExclusiveAddressUse = true };
            try { listener.Start(); listeners.Add(listener); }
            catch (SocketException) { listener.Stop(); } // An existing local service already occupies it.
        }
        Occupy(port);
        var available = ControlledEdgeLauncher.FindAvailablePort();
        Check(available > port && available <= port + 10, "Occupied 9222 was reused or alternate port escaped discovery range.");
        var released = new TcpListener(IPAddress.Loopback, available) { ExclusiveAddressUse = true };
        try { released.Start(); } // A successful probe must immediately release its reservation.
        finally { released.Stop(); }
        foreach (var candidate in Enumerable.Range(port + 1, 10)) Occupy(candidate);
        var exhausted = false;
        try { ControlledEdgeLauncher.FindAvailablePort(); }
        catch (InvalidOperationException exception) { exhausted = exception.Message.Contains("9222~9232"); }
        Check(exhausted, "Occupied discovery range did not fail clearly.");
    }
    finally { foreach (var listener in listeners) listener.Stop(); }
}
else if (scenario == "alternate-port")
{
    var fixture = new PortReuseFixture(office) { RequireParallelProbe = true };
    fixture.Endpoints[9227] = [new("alternate-portal", "page", "업무포털", office.PortalUri.AbsoluteUri)];
    using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(3));
    Check(await fixture.Run(deadline.Token), "Alternate local Edge was not reused.");
    Check(fixture.ProbedPorts.Order().SequenceEqual(Enumerable.Range(9222, 11)), "Reuse skipped part of the discovery range.");
    Check(fixture.Mutations.SequenceEqual(new[] { "activate:9227:alternate-portal" }), "Alternate Edge was recreated or the wrong endpoint was activated.");
}
else if (scenario == "multiport-ambiguity")
{
    var preferred = new PortReuseFixture(office);
    preferred.Endpoints[9222] = [];
    preferred.Endpoints[9232] = [new("official", "page", "업무포털", office.PortalUri.AbsoluteUri)];
    Check(await preferred.Run(), "Unique official portal was not preferred over an empty compatible Edge.");
    Check(preferred.Mutations.SequenceEqual(new[] { "activate:9232:official" }), "Empty compatible Edge received a new portal window.");
    foreach (var withPortals in new[] { false, true })
    {
        var ambiguous = new PortReuseFixture(office);
        ambiguous.Endpoints[9222] = withPortals ? [new("first", "page", "업무포털", office.PortalUri.AbsoluteUri)] : [];
        ambiguous.Endpoints[9223] = withPortals ? [new("second", "page", "업무포털", office.PortalUri.AbsoluteUri)] : [];
        Check(!await ambiguous.Run() && ambiguous.Mutations.Count == 0, "Ambiguous endpoints were guessed or mutated.");
    }
    var duplicate = new PortReuseFixture(office);
    duplicate.Endpoints[9223] = [new("a", "page", "업무포털", office.PortalUri.AbsoluteUri), new("b", "page", "업무포털", office.PortalUri.AbsoluteUri)];
    duplicate.Endpoints[9224] = [new("c", "page", "업무포털", office.PortalUri.AbsoluteUri)];
    Check(!await duplicate.Run() && duplicate.Mutations.Count == 0, "An ambiguous portal endpoint was ignored during selection.");
}
else if (scenario == "versions")
{
    foreach (var host in new[] { "127.0.0.1", "localhost", "[::1]" })
        Check(ControlledEdgeLauncher.IsReusableVersion(Version(socket: $"ws://{host}:{port}/devtools/browser/test-id"), port), "Local Edge socket rejected: " + host);
    foreach (var browser in new[] { "Chrome/155.0.0.0", "HeadlessChrome/155.0.0.0", "Edge/155.0.0.0", "EdgA/155.0.0.0", "edg/155.0.0.0", "" })
        Check(!ControlledEdgeLauncher.IsReusableVersion(Version(browser), port), "Unexpected browser accepted: " + browser);
    foreach (var socket in new[] {
        "ws://example.org:9222/devtools/browser/test-id", "ws://localhost.evil:9222/devtools/browser/test-id",
        "ws://127.0.0.1:9223/devtools/browser/test-id", "wss://127.0.0.1:9222/devtools/browser/test-id",
        "http://127.0.0.1:9222/devtools/browser/test-id", "ws://user:secret@127.0.0.1:9222/devtools/browser/test-id",
        "ws://127.0.0.1:9222/devtools/page/test-id", "ws://127.0.0.1:9222/browser/test-id",
        "ws://127.0.0.1:9222/devtools/browser/", "", "not a uri" })
        Check(!ControlledEdgeLauncher.IsReusableVersion(Version(socket: socket), port), "Untrusted socket accepted: " + socket);
    foreach (var json in new[] { "null", "[]", "42", "{}", "{\"Browser\":42,\"webSocketDebuggerUrl\":true}", "{\"Browser\":\"Edg/155.0\"}" })
    {
        using var doc = JsonDocument.Parse(json);
        Check(!ControlledEdgeLauncher.IsReusableVersion(doc.RootElement, port), "Malformed version accepted.");
    }
}
else if (scenario == "reuse-existing")
{
    var fixture = new ReuseFixture(office);
    fixture.Targets = [
        new("nice", "page", "나이스", office.NiceUri.AbsoluteUri),
        new("frame", "iframe", "embedded", office.PortalUri.AbsoluteUri),
        new("fake", "page", "업무포털", "https://jbe.eduptl.kr.evil.invalid/"),
        new("insecure", "page", "업무포털", "http://jbe.eduptl.kr/"),
        new("portal", "page", "업무포털", "https://JBE.EDUPTL.KR/bpm_man_mn00_001.do"),
    ];
    Check(await fixture.Run(), "Existing official portal failed to reuse.");
    Check(fixture.Events.SequenceEqual(new[] { "version", "targets", "activate:portal" }), "Existing page created another window or activated the wrong target.");
    Check(fixture.CreateCalls == 0 && fixture.ActivateCalls == 1, "Wrong existing page operation counts.");
}
else if (scenario == "create-window")
{
    foreach (var candidateOffice in EducationOfficeCatalog.All)
    {
        var fixture = new ReuseFixture(candidateOffice);
        fixture.Targets = [
            new("frame", "iframe", "embedded", candidateOffice.PortalUri.AbsoluteUri),
            new("http", "page", "업무포털", "http://" + candidateOffice.PortalDomain + "/"),
            new("fake", "page", "업무포털", "https://" + candidateOffice.PortalDomain + ".evil.invalid/"),
            new("opaque", "page", "업무포털", "not an absolute uri"),
        ];
        Check(await fixture.Run(), "Official window creation failed: " + candidateOffice.Code);
        Check(fixture.Events.SequenceEqual(new[] { "version", "targets", "create", "activate:created-portal" }), "Window was not created and activated exactly once.");
        Check(fixture.CreateCalls == 1 && fixture.ActivateCalls == 1 && fixture.CreatedUri == candidateOffice.PortalUri, "New window URI escaped the selected official portal.");
    }
}
else if (scenario == "ambiguous")
{
    var fixture = new ReuseFixture(office);
    fixture.Targets = [new("a", "page", "업무포털", office.PortalUri.AbsoluteUri), new("b", "page", "업무포털", office.PortalUri.AbsoluteUri + "different")];
    Check(!await fixture.Run(), "Duplicate portal pages were guessed.");
    Check(fixture.Events.SequenceEqual(new[] { "version", "targets" }) && fixture.CreateCalls == 0 && fixture.ActivateCalls == 0,
        "Ambiguous targets were mutated.");
}
else if (scenario == "invalid-version")
{
    foreach (var invalid in new[] { Version("Chrome/155.0.0.0"), Version(socket: "ws://remote.invalid:9222/devtools/browser/id") })
    {
        var fixture = new ReuseFixture(office) { Metadata = invalid };
        Check(!await fixture.Run() && fixture.Events.SequenceEqual(new[] { "version" }), "Invalid browser reached target operations.");
    }
}
else if (scenario == "empty-id")
{
    foreach (var empty in new[] { "", " " })
    {
        var existing = new ReuseFixture(office) { Targets = [new(empty, "page", "업무포털", office.PortalUri.AbsoluteUri)] };
        Check(!await existing.Run() && existing.ActivateCalls == 0 && existing.CreateCalls == 0, "Empty existing target ID was activated.");
        var created = new ReuseFixture(office) { CreatedId = empty };
        Check(!await created.Run() && created.ActivateCalls == 0 && created.CreateCalls == 1, "Empty created target ID was activated.");
    }
}
else if (scenario == "failures")
{
    foreach (var stage in new[] { "version", "targets", "create", "activate" })
    foreach (var error in new Exception[] { new HttpRequestException("offline"), new IOException("transport"), new JsonException("invalid"),
        new InvalidOperationException("closed"), new WebSocketException("closed"), new TimeoutException("devtools timeout") })
    {
        var fixture = new ReuseFixture(office) { FailureStage = stage, Failure = error };
        Check(!await fixture.Run(), "Known failure did not fall back: " + stage + "/" + error.GetType().Name);
        Check(fixture.Events.Last().StartsWith(stage, StringComparison.Ordinal), "Operations continued after a failed stage.");
        Check(fixture.CreateCalls <= 1 && fixture.ActivateCalls <= 1, "Failed attempt repeated a mutation.");
    }
}
else if (scenario == "cancellation")
{
    using var operation = new CancellationTokenSource();
    operation.Cancel();
    var timedOut = new ReuseFixture(office) { FailureStage = "version", Failure = new OperationCanceledException(operation.Token) };
    Check(!await timedOut.Run(operation.Token), "Internal timeout did not fall back.");
    using var user = new CancellationTokenSource();
    user.Cancel();
    var cancelled = new ReuseFixture(office) { FailureStage = "version", Failure = new OperationCanceledException(user.Token) };
    var propagated = false;
    try { await cancelled.Run(user.Token, user.Token); }
    catch (OperationCanceledException) { propagated = true; }
    Check(propagated && cancelled.Events.SequenceEqual(new[] { "version" }), "Explicit user cancellation did not stop reuse.");
}
else if (scenario == "launched-selection")
{
    var previous = new BrowserWindowItem("chrome", "이전에 선택한 창");
    var portal = new BrowserWindowItem("msedge", "전북 업무포털 - Microsoft Edge");
    var secondPortal = new BrowserWindowItem("msedge", "다른 업무포털 - Microsoft Edge");
    var chromePortal = new BrowserWindowItem("chrome", "업무포털 - Chrome");
    var niceOnly = new BrowserWindowItem("msedge", "나이스 - Microsoft Edge");
    var fixture = new MainFormSelectionProbe();
    fixture.Items.AddRange([previous, portal]);
    fixture.Selected = previous;
    fixture.Select();
    Check(ReferenceEquals(fixture.Selected, portal), "Single unconnected Edge portal was not selected.");
    fixture.Select();
    Check(ReferenceEquals(fixture.Selected, portal), "Repeated selection changed the correct window.");

    fixture.Selected = previous;
    fixture.Connected = true;
    fixture.Select();
    Check(ReferenceEquals(fixture.Selected, previous), "Existing browser connection was changed.");
    fixture.Connected = false;
    fixture.Items.Add(secondPortal);
    fixture.Select();
    Check(ReferenceEquals(fixture.Selected, previous), "Duplicate Edge portal candidates were guessed.");

    fixture.Items.Clear();
    fixture.Items.AddRange([previous, niceOnly, chromePortal]);
    fixture.Select();
    Check(ReferenceEquals(fixture.Selected, previous), "A Chrome portal or Nice-only title was chosen.");
    fixture.Items.Clear();
    fixture.Select();
    Check(ReferenceEquals(fixture.Selected, previous), "No candidates changed the user's selection.");

    var mixedCaseEdge = new BrowserWindowItem("MSEDGE", "업무포털");
    fixture.Items.AddRange([previous, chromePortal, mixedCaseEdge]);
    fixture.Select();
    Check(ReferenceEquals(fixture.Selected, mixedCaseEdge), "The unique Edge portal was confused with a Chrome portal.");
}
else throw new Exception("Unknown fixture scenario.");
Console.WriteLine("PASS: " + scenario);

internal sealed class ReuseFixture(EducationOffice office)
{
    public JsonElement Metadata = JsonSerializer.SerializeToElement(new { Browser = "Edg/155.0.4283.45", webSocketDebuggerUrl = "ws://127.0.0.1:9222/devtools/browser/test-id" });
    public List<DevToolsTarget> Targets = [];
    public readonly List<string> Events = [];
    public int CreateCalls, ActivateCalls;
    public Uri? CreatedUri;
    public string CreatedId = "created-portal";
    public string? FailureStage;
    public Exception? Failure;

    public Task<bool> Run(CancellationToken operationToken = default, CancellationToken userToken = default)
    {
        void Validate(int port, CancellationToken token)
        {
            if (port != 9222 || token != operationToken) throw new Exception("Wrong endpoint or cancellation token.");
        }
        void Fail(string stage) { if (FailureStage == stage) throw Failure!; }
        return ControlledEdgeLauncher.TryReuseAsync(office,
            (port, token) => { Validate(port, token); Events.Add("version"); Fail("version"); return Task.FromResult(Metadata); },
            (port, token) => { Validate(port, token); Events.Add("targets"); Fail("targets"); return Task.FromResult(Targets); },
            (port, uri, token) => { Validate(port, token); Events.Add("create"); CreateCalls++; CreatedUri = uri; Fail("create"); return Task.FromResult(CreatedId); },
            (port, id, token) => { Validate(port, token); Events.Add("activate:" + id); ActivateCalls++; Fail("activate"); return Task.CompletedTask; },
            operationToken, userToken);
    }
}

internal sealed class PortReuseFixture(EducationOffice office)
{
    public readonly Dictionary<int, List<DevToolsTarget>> Endpoints = [];
    public readonly List<int> ProbedPorts = [];
    public readonly List<string> Mutations = [];
    public bool RequireParallelProbe;
    private readonly TaskCompletionSource _allProbes = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public Task<bool> Run(CancellationToken operationToken = default) =>
        ControlledEdgeLauncher.TryReuseAcrossPortsAsync(office,
            async (candidate, token) =>
            {
                lock (ProbedPorts)
                {
                    ProbedPorts.Add(candidate);
                    if (ProbedPorts.Count == 11) _allProbes.TrySetResult();
                }
                if (RequireParallelProbe) await _allProbes.Task.WaitAsync(token);
                if (!Endpoints.ContainsKey(candidate)) throw new HttpRequestException("No endpoint.");
                return JsonSerializer.SerializeToElement(new { Browser = "Edg/155.0.4283.45", webSocketDebuggerUrl = $"ws://127.0.0.1:{candidate}/devtools/browser/id" });
            },
            (candidate, token) => Task.FromResult(Endpoints[candidate]),
            (candidate, uri, token) => { Mutations.Add("create:" + candidate); return Task.FromResult("created"); },
            (candidate, id, token) => { Mutations.Add($"activate:{candidate}:{id}"); return Task.CompletedTask; },
            operationToken);
}

internal sealed record BrowserWindowItem(string ProcessName, string Title);
internal sealed class BrowserWindowComboStub
{
    public List<BrowserWindowItem> Items { get; } = [];
    public BrowserWindowItem? SelectedItem;
}
internal sealed class MainFormSelectionProbe
{
    private IntPtr _sourceWindow;
    private readonly BrowserWindowComboStub _browserWindows = new();
    public List<BrowserWindowItem> Items => _browserWindows.Items;
    public BrowserWindowItem? Selected { get => _browserWindows.SelectedItem; set => _browserWindows.SelectedItem = value; }
    public bool Connected { set => _sourceWindow = value ? new IntPtr(1) : IntPtr.Zero; }
    public void Select() => SelectLaunchedPortalEdge();
    /* PRODUCTION_SELECTION */
}

namespace BrowserThumbnailPrototype
{
    internal sealed record DevToolsTarget(string Id, string Type, string Title, string Url);
    // The tested overload injects every operation; these unused public adapters must
    // never contact the actual local browser during an offline test.
    internal static class DevToolsDiscovery
    {
        public const int DefaultPort = 9222;
        public static Task<List<DevToolsTarget>> GetTargetsAsync(int port, CancellationToken token) => throw new Exception("Unexpected real browser adapter.");
    }
    internal sealed class DevToolsSession : IAsyncDisposable
    {
        public static Task<string> CreateTargetAsync(int port, Uri uri, CancellationToken token, bool newWindow = false) => throw new Exception("Unexpected real create adapter.");
        public static Task<DevToolsSession> ConnectAsync(int port, string id, CancellationToken token) => throw new Exception("Unexpected real connect adapter.");
        public Task ActivateTargetAsync(CancellationToken token) => throw new Exception("Unexpected real activate adapter.");
        public Task MaximizeTargetWindowAsync(CancellationToken token) => throw new Exception("Unexpected real maximize adapter.");
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
    internal static class AppLogger { public static void Info(string area, string message) { } }
}
`;
