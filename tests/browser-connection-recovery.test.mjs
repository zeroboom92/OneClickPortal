import { browserForegroundStub } from './helpers/browser-foreground-fixture.mjs';
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
const main = await readFile(resolve(root, 'MainForm.cs'), 'utf8');
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
function method(signature) {
  const start = main.indexOf(signature);
  assert.ok(start >= 0, `Missing production method: ${signature}`);
  const body = main.indexOf('{', start);
  let depth = 1;
  let end = body + 1;
  while (depth && end < main.length) {
    if (main[end] === '{') depth++;
    if (main[end] === '}') depth--;
    end++;
  }
  return main.slice(start, end);
}

test('connection failure clears connection state before selecting a window for a manual retry', () => {
  const connect = method('private async Task ConnectSelectedBrowserAsync()');
  const failure = connect.slice(connect.indexOf('if (_devToolsPort is null)'), connect.indexOf('var controller ='));
  assert.ok(failure.indexOf('ResetFailedBrowserConnection();') < failure.indexOf('TrySelectVerifiedLoginWindowAsync('));
  assert.ok(failure.indexOf('TrySelectVerifiedLoginWindowAsync(') < failure.indexOf('MessageBox.Show('));
  assert.match(failure, /DescribeFailure\([\s\S]*loginWindowSelected\)/);
  assert.doesNotMatch(method('private async Task<bool> TrySelectVerifiedLoginWindowAsync('), /ConnectSelectedBrowserAsync|PrepareApplicationTargetsAsync|ShowWindow|Process\.Start/);
  assert.match(connect, /await BrowserEndpointOwner\.ForProcessAsync\(/);
  assert.ok(connect.indexOf('out var selectedProcessId') < connect.indexOf('await DevToolsDiscovery.InspectPortalPortsAsync('),
    'Window ownership should be captured before the first asynchronous probe.');
  assert.match(connect, /currentProcessId != selectedProcessId/);
});

test('production retry selection uses a real Windows TCP owner and isolated window fixtures',
  { timeout: 100_000, skip: process.platform !== 'win32' }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-connection-recovery-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>${['BrowserEndpointOwner.cs', 'DevToolsAutomation.cs', 'BrowserSupport.cs', 'EducationOffice.cs']
          .map(name => `<Compile Include="${xml(resolve(root, name))}" Link="${name}" />`).join('\n')}</ItemGroup>
      </Project>`);
      const methods = [
        'private void RefreshBrowserWindows()',
        'private async Task<bool> TrySelectVerifiedLoginWindowAsync(',
        'private void SelectLaunchedPortalEdge(',
        'private static bool IsWindowOwnedBy(',
      ].map(method).join('\n');
      await writeFile(join(directory, 'Program.cs'), probe.replace('/* METHODS */', methods));
      await writeFile(join(directory, 'BrowserForeground.cs'), browserForegroundStub);
      await run('dotnet', ['build', join(directory, 'Probe.csproj'), '-c', 'Release', '--nologo'],
        { timeout: 60_000, maxBuffer: 1024 * 1024 }).catch(error => {
          throw new Error(`${error.stdout}\n${error.stderr}`, { cause: error });
        });
      for (const scenario of ['verified', 'unverified', 'ambiguous', 'changed-owner', 'missing', 'connected']) {
        await t.test(scenario, async () => {
          const result = await run('dotnet', [join(directory, 'bin/Release/net8.0/Probe.dll'), scenario],
            { timeout: 15_000, maxBuffer: 1024 * 1024 });
          assert.match(result.stdout, new RegExp('PASS: ' + scenario));
        });
      }
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-connection-recovery-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using System.Net;
using System.Net.Sockets;
using BrowserThumbnailPrototype;

var scenario = args.Single();
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
using var listener = new TcpListener(IPAddress.Loopback, 0);
listener.Start();
var port = ((IPEndPoint)listener.LocalEndpoint).Port;
var owner = (uint)Environment.ProcessId;
foreach (var browser in new[] { PortalBrowser.Edge, PortalBrowser.Chrome })
{
    var name = BrowserSupport.GetProcessName(browser);
    var otherName = BrowserSupport.GetProcessName(browser == PortalBrowser.Edge ? PortalBrowser.Chrome : PortalBrowser.Edge);
    var old = new BrowserWindowItem(new(1), name, "이전 일반 창");
    var similar = new BrowserWindowItem(new(2), name, "업무포털");
    var owned = new BrowserWindowItem(new(3), name, "로그인 완료");
    var other = new BrowserWindowItem(new(4), otherName, "업무포털");
    NativeMethods.Owners.Clear();
    NativeMethods.Owners[old.Handle] = owner + 1;
    NativeMethods.Owners[similar.Handle] = owner + 2;
    NativeMethods.Owners[owned.Handle] = owner;
    NativeMethods.Owners[other.Handle] = owner;
    BrowserWindowFinder.Windows = [old, similar, owned, other];
    BrowserWindowFinder.Calls = 0;
    var form = new SelectionProbe();
    form.Windows.Items.Add(old); // The UI still holds a window from before login.
    form.Windows.SelectedItem = old;
    var mismatch = new DevToolsPortProbe(port, DevToolsProbeStatus.WindowMismatch, ["jbe"],
        SelectedProcessId: owner + 1, EndpointProcessId: owner);
    DevToolsDiscoveryResult result = new(null, [mismatch]);
    switch (scenario)
    {
        case "verified":
            Check(await form.Recover(browser, result) && ReferenceEquals(form.Windows.SelectedItem, owned), "The verified login window was not selected from a fresh list.");
            Check(!form.Connected && BrowserWindowFinder.Calls == 1, "Recovery connected automatically or used a stale list.");
            var retried = BrowserEndpointOwner.ForProcess(new(null, [new(port, DevToolsProbeStatus.Ready, ["jbe"])]),
                NativeMethods.Owners[form.Windows.SelectedItem!.Handle]);
            Check(retried.Port == port, "A manual retry would still reject the reselected window.");
            break;
        case "unverified":
            foreach (var status in new[] { DevToolsProbeStatus.WindowOwnerUnavailable, DevToolsProbeStatus.Ready,
                DevToolsProbeStatus.NoPortalTarget, DevToolsProbeStatus.BrowserMismatch })
                Check(!await form.Recover(browser, new(null, [mismatch with { Status = status }])), "An ineligible endpoint changed selection.");
            Check(!await form.Recover(browser, new(null, [mismatch with { EndpointProcessId = null }])), "Unknown ownership was guessed.");
            Check(!await form.Recover(browser, new(null, [mismatch with { EndpointProcessId = 0 }])), "Zero ownership was guessed.");
            Check(!await form.Recover(browser, new(port, [mismatch])), "A successful discovery was treated as a failed selection.");
            Check(ReferenceEquals(form.Windows.SelectedItem, old) && BrowserWindowFinder.Calls == 0, "Unverified selection refreshed or replaced a window.");
            break;
        case "ambiguous":
            Check(!await form.Recover(browser, new(null, [mismatch, mismatch with { Port = port + 1 }])), "Multiple channels were guessed.");
            Check(!await form.Recover(browser, new(null, [mismatch, mismatch with { Status = DevToolsProbeStatus.WindowOwnerUnavailable }])), "A second unverified channel was ignored.");
            Check(!await form.Recover(browser, new(null, [mismatch, mismatch with { Status = DevToolsProbeStatus.Ambiguous }])), "An ambiguous channel was ignored.");
            var second = new BrowserWindowItem(new(5), name, "두 번째 전용 창");
            NativeMethods.Owners[second.Handle] = owner;
            BrowserWindowFinder.Windows.Add(second);
            Check(!await form.Recover(browser, result) && form.Windows.SelectedItem is null, "Multiple windows in one process were guessed.");
            break;
        case "changed-owner":
            Check(!await form.Recover(browser, new(null, [mismatch with { EndpointProcessId = owner + 1 }])), "A changed endpoint owner was accepted.");
            Check(ReferenceEquals(form.Windows.SelectedItem, old) && BrowserWindowFinder.Calls == 0, "Changed ownership replaced the previous selection.");
            break;
        case "missing":
            BrowserWindowFinder.Windows.Remove(owned);
            Check(!await form.Recover(browser, result) && form.Windows.SelectedItem is null, "Another browser or similar title replaced a missing login window.");
            BrowserWindowFinder.Windows.Add(owned);
            NativeMethods.Owners.Remove(owned.Handle);
            Check(!await form.Recover(browser, result) && form.Windows.SelectedItem is null, "A vanished window retained authorization.");
            break;
        case "connected":
            form.Connected = true;
            Check(!await form.Recover(browser, result) && ReferenceEquals(form.Windows.SelectedItem, old), "An existing connection was replaced.");
            form.Connected = false;
            form.Closing = true;
            Check(!await form.Recover(browser, result) && BrowserWindowFinder.Calls == 0, "Closing UI was accessed.");
            break;
    }
    Check(AppLogger.Lines.All(line => !line.Contains("로그인 완료") && !line.Contains("이전 일반 창")
        && !line.Contains("http")), "Window titles or URLs leaked into diagnostics.");
}
Console.WriteLine("PASS: " + scenario);

class SelectionProbe
{
    private IntPtr _sourceWindow;
    private bool _isClosing;
    private bool IsDisposed => false;
    private bool Disposing => false;
    private string? _connectedProcessName;
    private readonly WindowCombo _browserWindows = new();
    public WindowCombo Windows => _browserWindows;
    public bool Connected { get => _sourceWindow != IntPtr.Zero; set => _sourceWindow = value ? new(7) : IntPtr.Zero; }
    public bool Closing { set => _isClosing = value; }
    private void SetConnectionStatus(string status) { }
    public Task<bool> Recover(PortalBrowser browser, DevToolsDiscoveryResult result) => TrySelectVerifiedLoginWindowAsync(browser, result);
    /* METHODS */
}
class WindowCombo
{
    public List<BrowserWindowItem> Items { get; } = [];
    public BrowserWindowItem? SelectedItem;
    public int SelectedIndex { set => SelectedItem = Items[value]; }
    public void BeginUpdate() { }
    public void EndUpdate() { }
}
record BrowserWindowItem(IntPtr Handle, string ProcessName, string Title);
static class BrowserWindowFinder
{
    public static List<BrowserWindowItem> Windows = [];
    public static int Calls;
    public static List<BrowserWindowItem> FindVisibleBrowserWindows() { Calls++; return Windows.ToList(); }
}
static class NativeMethods
{
    public static Dictionary<IntPtr, uint> Owners = [];
    public static uint GetWindowThreadProcessId(IntPtr handle, out uint processId)
    { processId = Owners.GetValueOrDefault(handle); return processId == 0 ? 0u : 1u; }
}
namespace BrowserThumbnailPrototype
{
    static class AppLogger
    {
        public static List<string> Lines = [];
        public static void Info(string area, string message) => Lines.Add(message);
        public static void Error(string area, string message, Exception error) => Lines.Add(message);
    }
}
`;
