import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const source = await readFile(new URL('../MainForm.cs', import.meta.url), 'utf8');
function method(signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `Missing production method: ${signature}`);
  const body = source.indexOf('{', start);
  let depth = 1;
  let end = body + 1;
  while (depth && end < source.length) {
    if (source[end] === '{') depth++;
    if (source[end] === '}') depth--;
    end++;
  }
  return source.slice(start, end);
}

test('missing channel rolls back the connection before showing its diagnosis', () => {
  const connect = method('private async Task ConnectSelectedBrowserAsync()');
  const failure = connect.split('if (_devToolsPort is null)')[1].split('else')[0];
  assert.ok(failure.indexOf('ResetFailedBrowserConnection();') >= 0);
  assert.ok(failure.indexOf('ResetFailedBrowserConnection();') < failure.indexOf('MessageBox.Show('));
  assert.match(failure, /keepPendingTaskAfterFailure = _pendingTaskKind is not null/);
  assert.match(failure, /EdgeChannelDiagnostics.DescribeFailure/);
});

test('actual failure rollback restores retry controls; launch waits for a bounded real channel',
  { timeout: 100_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-connection-state-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
      </Project>`);
      const methods = [
        'private void ResetFailedBrowserConnection()',
        'private void UpdateConnectionControls()',
        'private async Task<DevToolsPortProbe> WaitForLaunchedEdgeChannelAsync(int port, EducationOffice office,',
      ].map(method).join('\n');
      await writeFile(join(directory, 'Program.cs'), probe.replace('/* METHODS */', methods));
      await run('dotnet', ['build', join(directory, 'Probe.csproj'), '-c', 'Release', '--nologo'],
        { timeout: 60_000, maxBuffer: 1024 * 1024 }).catch(error => {
          throw new Error(`${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
        });
      const result = await run('dotnet', [join(directory, 'bin', 'Release', 'net8.0', 'Probe.dll')],
        { timeout: 25_000, maxBuffer: 1024 * 1024 });
      assert.match(result.stdout, /PASS: failed state, retry controls, delayed channel, startup target, timeout, closing/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-connection-state-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using System.Drawing;
await new Probe().Run();
class Probe
{
    private IntPtr _sourceWindow = new(123);
    private bool _sourceTransparent = true;
    private string? _connectedProcessName = "Edge";
    private int? _devToolsPort;
    private long _connectionGeneration = 4;
    private bool _workflowRunning = true;
    private bool _isClosing;
    private bool IsDisposed => false;
    private bool Disposing => false;
    private readonly Control _connectButton = new(), _launchBrowserButton = new(), _refreshButton = new(),
        _browserWindows = new(), _settingsButton = new(), _notificationsButton = new(), _closeButton = new();
    private readonly Control[] _taskButtons = [new(), new()];
    private void RefreshNotificationSourceStatus() { }
    void Check(bool passed, string message) { if (!passed) throw new Exception(message); }

    public async Task Run()
    {
        ResetFailedBrowserConnection();
        Check(_sourceWindow == IntPtr.Zero && !_sourceTransparent && _connectedProcessName is null
            && _devToolsPort is null && _connectionGeneration == 5, "Failed connection was retained.");
        _workflowRunning = false;
        UpdateConnectionControls();
        Check(_connectButton.Text == "연결" && _connectButton.Enabled && _browserWindows.Enabled
            && _launchBrowserButton.Enabled && _settingsButton.Enabled && _taskButtons.All(button => !button.Enabled),
            "Retry controls were not restored.");
        _sourceWindow = new(456); _devToolsPort = 9223;
        UpdateConnectionControls();
        Check(_connectButton.Text == "연결 해제" && !_browserWindows.Enabled && _taskButtons.All(button => button.Enabled),
            "Successful connection controls regressed.");

        var office = new EducationOffice();
        var count = 0;
        DevToolsDiscovery.Probe = (port, selected, token) => {
            Check(port == 9223 && ReferenceEquals(selected, office) && token.CanBeCanceled, "Wrong startup probe.");
            return Task.FromResult(new DevToolsPortProbe(port,
                ++count < 2 ? DevToolsProbeStatus.Unreachable : DevToolsProbeStatus.Ready, []));
        };
        Check((await WaitForLaunchedEdgeChannelAsync(9223, office)).Status == DevToolsProbeStatus.Ready && count == 2,
            "Slow browser startup was rejected.");
        count = 0;
        DevToolsDiscovery.Probe = (port, selected, token) => {
            count++; return Task.FromResult(new DevToolsPortProbe(port, DevToolsProbeStatus.NoPortalTarget, []));
        };
        Check((await WaitForLaunchedEdgeChannelAsync(9223, office)).Status == DevToolsProbeStatus.NoPortalTarget && count == 1,
            "A ready channel with a loading portal should be accepted.");
        DevToolsDiscovery.Probe = (port, selected, token) =>
            Task.FromResult(new DevToolsPortProbe(port, DevToolsProbeStatus.InvalidResponse, []));
        Check((await WaitForLaunchedEdgeChannelAsync(9223, office)).Status == DevToolsProbeStatus.InvalidResponse,
            "Timeout lost the last diagnostic result.");
        _isClosing = true;
        DevToolsDiscovery.Probe = (port, selected, token) => throw new Exception("Probe after closing.");
        await WaitForLaunchedEdgeChannelAsync(9223, office);
        Console.WriteLine("PASS: failed state, retry controls, delayed channel, startup target, timeout, closing");
    }
    /* METHODS */
}
class Control
{
    public bool Visible, Enabled;
    public string? Text, AccessibleName;
    public Color BackColor, ForeColor;
}
class EducationOffice { }
enum PortalBrowser { Edge, Chrome }
enum DevToolsProbeStatus { Ready, NoPortalTarget, Unreachable, InvalidResponse }
record DevToolsPortProbe(int Port, DevToolsProbeStatus Status, IReadOnlyList<string> OfficeCodes);
static class DevToolsDiscovery
{
    public static Func<int, EducationOffice, CancellationToken, Task<DevToolsPortProbe>> Probe = null!;
    public static Task<DevToolsPortProbe> ProbePortAsync(int port, EducationOffice office, CancellationToken token, PortalBrowser browser) => Probe(port, office, token);
}
`;
