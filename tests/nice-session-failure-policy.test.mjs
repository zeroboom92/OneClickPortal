import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);

test('actual Nice failure policy alerts on unconfirmed renewal and keeps its notice until recovery',
  { timeout: 180_000 }, async () => {
    const controller = await readFile(new URL('../PortalWorkflowController.cs', import.meta.url), 'utf8');
    const main = await readFile(new URL('../MainForm.cs', import.meta.url), 'utf8');
    const helper = await readFile(new URL('../NiceSessionFailurePolicy.cs', import.meta.url), 'utf8');
    const contract = controller.match(/internal enum SessionSystemState\s*\{[\s\S]*?\n\}/)?.[0];
    const record = controller.match(/internal sealed record SessionSystemResult\([\s\S]*?\);/)?.[0];
    const recovery = main.match(/var recoveryRequired = failed\s*[\s\S]*?\.ToArray\(\);/)?.[0];
    const newlyExpired = main.match(/var newlyExpired = expired\s*[\s\S]*?\.ToArray\(\);/)?.[0];
    const noticeDecision = main.match(/if \(newlyExpired.Length > 0\)[\s\S]*?(?=\r?\n\s*if \(_confirmedExpiredSystems.Count > 0\))/)?.[0];
    const noticeRecord = main.match(/private sealed record SessionNotice\([^;]*;/)?.[0];
    const close = main.match(/closeRecoveredSessionNotice = _sessionNoticeIsSessionStatus[\s\S]*?;/)?.[0];
    const healthyBranch = main.match(/if \(result.State == SessionSystemState.Healthy\)\s*\{([\s\S]*?)\}\s*else if/)?.[1];
    const healthyCleanup = healthyBranch?.match(/_notifiedRecoverySystems\.Remove\(result.SystemName\);/)?.[0];
    assert.ok(contract && record && recovery && newlyExpired && noticeDecision && noticeRecord && close && healthyCleanup,
      'Production contracts, both notice decisions and the confirmed-recovery cleanup must be available.');
    const sourceProbe = closeDecision => probe(recovery, closeDecision, healthyCleanup, newlyExpired, noticeDecision, noticeRecord);
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-nice-failure-policy-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
      </Project>`);
      await writeFile(join(directory, 'Contracts.cs'), `namespace BrowserThumbnailPrototype;\n${contract}\n${record}\n`);
      await writeFile(join(directory, 'NiceSessionFailurePolicy.cs'), helper);
      await writeFile(join(directory, 'Program.cs'), sourceProbe(close));
      const args = ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'];
      const result = await run('dotnet', args, { timeout: 90_000 });
      assert.match(result.stdout, /PASS: Nice renewal failure policy and persistent recovery notice/);

      // Reinsert the dangerous success classification in the isolated source copy.
      // The production files and the user's running application remain untouched.
      const mutant = helper.replaceAll('SessionSystemState.Failed', 'SessionSystemState.Healthy');
      assert.notEqual(mutant, helper, 'The failure-classification mutation must change the copied helper.');
      await writeFile(join(directory, 'NiceSessionFailurePolicy.cs'), mutant);
      await assert.rejects(run('dotnet', args, { timeout: 25_000 }), error => {
        assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /must remain failed/);
        return true;
      });

      // A pending request is not recovery. Removing the outstanding-notice guard
      // must reproduce the premature-close failure in the real decision expression.
      await writeFile(join(directory, 'NiceSessionFailurePolicy.cs'), helper);
      const prematureClose = close.replace(/\s*&& _notifiedRecoverySystems.Count == 0/, '');
      assert.notEqual(prematureClose, close, 'The pending-recovery mutation must change the copied decision.');
      await writeFile(join(directory, 'Program.cs'), sourceProbe(prematureClose));
      await assert.rejects(run('dotnet', args, { timeout: 25_000 }), error => {
        assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /pending request must not close/);
        return true;
      });

      const omittedNice = noticeDecision.replace('newlyExpired.Concat(recoveryRequired).ToArray()', 'newlyExpired');
      assert.notEqual(omittedNice, noticeDecision, 'The mixed-notice mutation must omit the copied recovery messages.');
      await writeFile(join(directory, 'Program.cs'),
        probe(recovery, close, healthyCleanup, newlyExpired, omittedNice, noticeRecord));
      await assert.rejects(run('dotnet', args, { timeout: 25_000 }), error => {
        assert.match(`${error.stdout || ''}\n${error.stderr || ''}`, /mixed notice omitted/);
        return true;
      });
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-nice-failure-policy-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

// Compile the real policy, source-defined result contract and the two actual
// MainForm decision expressions and notice construction. Only the WinForms host
// is replaced by this probe.
function probe(recovery, close, healthyCleanup, newlyExpired, noticeDecision, noticeRecord) {
  return String.raw`
using BrowserThumbnailPrototype;

void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
string[] failures = ["Y_RESET_UNAVAILABLE", "Y_RESET_FAILED", "Y_RESET_UNCONFIRMED",
    "BINDING_UNAVAILABLE", "REQUEST_NOT_TRACKED", "IN_FLIGHT_STALE", "LEGACY_IN_FLIGHT_STALE"];
foreach (var status in failures)
{
    var result = NiceSessionFailurePolicy.FromResult(status);
    Check(result is not null, status + ": failure was discarded.");
    Check(result!.State == SessionSystemState.Failed, status + ": must remain failed.");
    Check(result.RequiresAttention, status + ": missing user attention flag.");
    Check(result.SystemName == "나이스" && !string.IsNullOrWhiteSpace(result.Message), status + ": missing actionable message.");
    Check(!result.Message.Contains(status, StringComparison.Ordinal), status + ": internal result code leaked into user message.");

    var ui = new NoticeProbe();
    var first = ui.Poll(result);
    Check(first.Show && !first.Close, status + ": first failure must show and retain its notice.");
    var repeat = ui.Poll(result);
    Check(!repeat.Show && !repeat.Close, status + ": unchanged failure must retain the notice without reopening it.");
    Check(ui.Poll(new SessionSystemResult("나이스", SessionSystemState.Pending, "요청 중")) == (false, false),
        status + ": pending request must not close the unresolved failure notice.");
    Check(ui.Poll(new SessionSystemResult("업무포털", SessionSystemState.Healthy, "정상")) == (false, false),
        status + ": another system's success must not close the unresolved Nice failure notice.");
    Check(ui.Poll(new SessionSystemResult("나이스", SessionSystemState.Missing, "화면 없음")) == (false, false),
        status + ": a missing page must not close the unresolved failure notice.");
    Check(ui.Poll(result) == (false, false), status + ": retry failure must retain the existing notice.");
    var recovered = ui.Poll(new SessionSystemResult("나이스", SessionSystemState.Healthy, "복구됨"));
    Check(!recovered.Show && recovered.Close, status + ": confirmed recovery must permit closing the notice.");
    Check(ui.Poll(result) == (true, false), status + ": a new failure after confirmed recovery must be announced again.");
}

string?[] existing = [null, "", "Y", "Y_RECENT", "N", "STARTED", "IN_FLIGHT", "LEGACY_IN_FLIGHT",
    "AUTH_RESPONSE", "REQUEST_TIMEOUT", "REQUEST_ABORTED", "REQUEST_EXCEPTION", "NETWORK_ERROR", "HTTP_500", "UNEXPECTED_RESPONSE", "UNKNOWN"];
foreach (var status in existing)
    Check(NiceSessionFailurePolicy.FromResult(status) is null, (status ?? "null") + ": existing classification must stay in its original branch.");

foreach (var state in Enum.GetValues<SessionSystemState>())
    Check(!new SessionSystemResult("기존 시스템", state, "기존 안내").RequiresAttention, "Default attention flag changed an existing caller.");

var legacyNotice = new NoticeProbe();
var legacyFailure = new SessionSystemResult("K-에듀파인", SessionSystemState.Failed, "요청 종료를 확인할 수 없습니다.");
Check(legacyNotice.Poll(legacyFailure) == (true, false), "Existing Edufine recovery guidance must still appear.");
Check(legacyNotice.Poll(legacyFailure) == (false, false), "Existing Edufine recovery notice must remain visible on repeated failure.");

var edufineExpired = new SessionSystemResult("K-에듀파인", SessionSystemState.Expired, "에듀파인 세션이 종료되어 재로그인이 필요합니다.");
var niceFailure = NiceSessionFailurePolicy.FromResult("Y_RESET_UNCONFIRMED")!;
var mixed = new NoticeProbe();
Check(mixed.Poll(edufineExpired, niceFailure).Show, "Mixed expiry and recovery failures must display a notice.");
Check(mixed.NoticeTitle?.Contains("K-에듀파인", StringComparison.Ordinal) == true
    && mixed.NoticeTitle.Contains("나이스", StringComparison.Ordinal), "mixed notice omitted one affected system from its title.");
Check(mixed.NoticeMessage?.Contains(edufineExpired.Message, StringComparison.Ordinal) == true
    && mixed.NoticeMessage.Contains(niceFailure.Message, StringComparison.Ordinal), "mixed notice omitted one affected system's guidance.");
var expiredOnly = new NoticeProbe();
Check(expiredOnly.Poll(edufineExpired).Show, "A single expired system must still display its notice.");
Check(expiredOnly.NoticeTitle == "K-에듀파인 재로그인 필요" && expiredOnly.NoticeMessage == edufineExpired.Message,
    "The existing single-system expiry title and message must remain unchanged.");
Console.WriteLine("PASS: Nice renewal failure policy and persistent recovery notice");

sealed class NoticeProbe
{
    readonly HashSet<string> _notifiedRecoverySystems = [];
    readonly HashSet<string> _notifiedExpiredSystems = [];
    readonly HashSet<string> _confirmedExpiredSystems = [];
    readonly bool _sessionNoticeIsSessionStatus = true;
    internal string? NoticeTitle { get; private set; }
    internal string? NoticeMessage { get; private set; }
    internal (bool Show, bool Close) Poll(params SessionSystemResult[] results)
    {
        foreach (var result in results)
        {
            if (result.State == SessionSystemState.Healthy)
            {
                ${healthyCleanup}
            }
        }
        var expired = results.Where(result => result.State == SessionSystemState.Expired).ToArray();
        var failed = results.Where(result => result.State == SessionSystemState.Failed).ToArray();
        ${newlyExpired}
        ${recovery}
        SessionNotice? sessionNotice = null;
        var maximizeBrowser = false;
        ${noticeDecision}
        var closeRecoveredSessionNotice = false;
        ${close}
        NoticeTitle = sessionNotice?.Title;
        NoticeMessage = sessionNotice?.Message;
        return (sessionNotice is not null, closeRecoveredSessionNotice);
    }
    ${noticeRecord}
}
`;
}
