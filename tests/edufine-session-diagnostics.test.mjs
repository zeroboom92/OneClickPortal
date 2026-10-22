import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(new URL('../EdufineSessionDiagnostics.cs', import.meta.url), 'utf8');
const script = source.split('internal static string Script() => """')[1].split('"""')[0];
const runScript = globals => JSON.parse(vm.runInNewContext(script, {
  document: { readyState: 'complete', visibilityState: 'hidden' },
  performance: { timeOrigin: 1792471000000 }, ...globals
}));

function formFixture() {
  const timerWrapper = function () {};
  const resetWrapper = function () {};
  const sessionCheckWrapper = function () {};
  const callbackWrapper = function () {};
  const gfnCallbackWrapper = function () {};
  const form = {
    fv_nowUseEndTime: 2200, fv_aliveYn: 'Y',
    divTopGrp: { form: { staUseTime: { text: '36:40' } } },
    TopFrame_ontimer: timerWrapper, fnResetUseEndCeckTimer: resetWrapper,
    fnSessionCheck: sessionCheckWrapper, fnCallback: callbackWrapper, _gfnCallback: gfnCallbackWrapper,
    __oneClickTimerBaselineV3: { revision: 2, ready: true, lastTickAt: 1792471000,
      lastResetAt: 1792470900, resetAt: null, resetRemaining: null, tickCount: 7,
      correctionCount: 2, lastRawRemaining: -100, lastExpectedRemaining: 2200,
      timerWrapper, resetWrapper },
    __oneClickSessionPolicyV7: { sessionCheckWrapper, callbackWrapper, gfnCallbackWrapper }
  };
  form.ontimer = { _user_handlers: [{ target: form, handler: timerWrapper }] };
  const app = { gv_topFrame: { form }, mainframe: { MainVFrameSet: { TopFrame: { form } } } };
  return { form, app, timerWrapper };
}

test('diagnostics identify timer and callback replacements and actual duplicate registrations', () => {
  const { form, app, timerWrapper } = formFixture();
  let result = runScript({ application: app });
  assert.equal(result.form.aliasesSame, true);
  assert.equal(result.remaining.display, 2200);
  assert.equal(result.baseline.timerIdentity, true);
  assert.equal(result.baseline.resetIdentity, true);
  assert.equal(result.baseline.lastRawRemaining, -100);
  assert.equal(result.handlers.timerMatches, 1);
  assert.equal(result.handlers.duplicates, false);
  assert.equal(result.policy.sessionCheckIdentity, true);
  assert.equal(result.policy.callbackIdentity, true);
  assert.equal(result.policy.gfnCallbackIdentity, true);

  form.TopFrame_ontimer = function replacement() {};
  form.fnResetUseEndCeckTimer = function replacement() {};
  form.fnCallback = function replacement() {};
  form.ontimer._user_handlers.push({ target: form, handler: timerWrapper });
  result = runScript({ application: app });
  assert.equal(result.baseline.timerIdentity, false);
  assert.equal(result.baseline.resetIdentity, false);
  assert.equal(result.policy.callbackIdentity, false);
  assert.equal(result.handlers.timerMatches, 2);
  assert.equal(result.handlers.currentTimerMatches, 0);
  assert.equal(result.handlers.duplicates, true);
});

test('diagnostics distinguish unavailable forms, divergent aliases and unknown handler shape', () => {
  let result = runScript({});
  assert.equal(result.form.present, false);
  assert.equal(result.form.aliasesSame, null);
  assert.equal(result.remaining.internal, null);
  assert.equal(result.handlers.known, false);
  assert.equal(result.baseline.timerIdentity, null);
  const { form, app } = formFixture();
  app.gv_topFrame.form = undefined;
  delete form.ontimer;
  result = runScript({ application: app });
  assert.equal(result.form.mainPresent, true);
  assert.equal(result.remaining.internal, 2200);
  assert.equal(result.handlers.total, null);
  app.gv_topFrame.form = {};
  result = runScript({ application: app });
  assert.equal(result.form.aliasesSame, false);
  assert.equal(result.remaining.internal, null);
});

test('diagnostics never read identity, page contents or serialize unknown properties', () => {
  const { form, app } = formFixture();
  const forbidden = () => { throw new Error('Private property was accessed'); };
  for (const object of [form, app]) {
    for (const key of ['url', 'targetId', 'account', 'school', 'student', 'document'])
      Object.defineProperty(object, key, { get: forbidden });
  }
  const state = { inFlight: false, startedAt: 10, completedAt: 12, result: 'Y', requestSequence: 1,
    diagnosticEvents: [{ at: 12, code: 'RESPONSE_Y', remaining: 2400, requestId: 1,
      account: 'PRIVATE_PAYLOAD', text: 'PRIVATE_PAYLOAD' }] };
  Object.defineProperty(state, 'account', { get: forbidden });
  const document = { readyState: 'complete', visibilityState: 'hidden' };
  for (const key of ['body', 'URL', 'location', 'title']) Object.defineProperty(document, key, { get: forbidden });
  const result = runScript({ application: app, document, __oneClickEdufineServerKeepAliveV4: state,
    location: new Proxy({}, { get: forbidden }) });
  assert.equal(result.state.result, 'Y');
  assert.equal(result.state.diagnosticEvents.length, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_PAYLOAD'), false);
  assert.deepEqual(Object.keys(result.state.diagnosticEvents[0]).sort(), ['at', 'code', 'remaining', 'requestId']);
});

test('diagnostics bound event history and reject injected strings and nonfinite values', () => {
  const { form, app } = formFixture();
  form.fv_aliveYn = 'PRIVATE_PAYLOAD';
  form.fv_nowUseEndTime = Infinity;
  form.divTopGrp.form.staUseTime.text = { toString() { throw new Error('Must not coerce arbitrary data'); } };
  const state = { inFlight: 'true', result: 'PRIVATE_PAYLOAD\nFORGED_LOG', requestSequence: NaN,
    diagnosticEvents: Array.from({ length: 30 }, (_, at) => ({ at, code: 'TICK', remaining: -Infinity,
      requestId: 'PRIVATE_PAYLOAD' })) };
  state.diagnosticEvents[29].code = 'PRIVATE_PAYLOAD';
  let result = runScript({ application: app, __oneClickEdufineServerKeepAliveV4: state });
  assert.equal(result.alive, null);
  assert.equal(result.remaining.internal, null);
  assert.equal(result.remaining.display, null);
  assert.equal(result.state.inFlight, null);
  assert.equal(result.state.result, 'UNKNOWN');
  assert.equal(result.state.requestSequence, null);
  assert.equal(result.state.diagnosticEvents.length, 15);
  assert.equal(result.state.diagnosticEvents[0].at, 14);
  assert.equal(result.state.diagnosticEvents[0].remaining, null);
  assert.equal(result.state.diagnosticEvents[0].requestId, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_PAYLOAD'), false);
  state.result = 'ERROR_-401';
  result = runScript({ application: app, __oneClickEdufineServerKeepAliveV4: state });
  assert.equal(result.state.result, 'ERROR');
});

test('actual C# formatter independently sanitizes malformed, oversized and hostile diagnostic JSON',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-session-diagnostics-'));
    const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root, 'EdufineSessionDiagnostics.cs'))}" Link="EdufineSessionDiagnostics.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), String.raw`
using System.Text.Json;
using BrowserThumbnailPrototype;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
Check(EdufineSessionDiagnostics.Format(null).Contains("EMPTY"), "Null input must be handled.");
Check(EdufineSessionDiagnostics.Format("{").Contains("INVALID_JSON"), "Invalid JSON must be handled.");
Check(EdufineSessionDiagnostics.Format("[]").Contains("INVALID_SCHEMA"), "Wrong schema must be rejected.");
Check(EdufineSessionDiagnostics.Format(new string('x', 32769)).Contains("TOO_LARGE"), "Large input must be bounded.");
var events = Enumerable.Range(0, 30).Select(at => new { at, code = "TICK", remaining = 2200, requestId = 1, account = "PRIVATE_PAYLOAD" });
var input = JsonSerializer.Serialize(new { schema = 1, readyState = "complete", visibility = "hidden", timeOrigin = 1792471000000L,
    alive = "PRIVATE_PAYLOAD", account = "PRIVATE_PAYLOAD", baseline = new { ready = true, tickCount = 3 },
    state = new { result = "PRIVATE_PAYLOAD\nFORGED_LOG", diagnosticEvents = events } });
var output = EdufineSessionDiagnostics.Format(input);
Check(!output.Contains("PRIVATE_PAYLOAD") && !output.Contains("FORGED_LOG") && !output.Contains('\n') && !output.Contains('\r'), "Private or multiline data leaked.");
using var parsed = JsonDocument.Parse(output);
Check(parsed.RootElement.GetProperty("alive").ValueKind == JsonValueKind.Null, "Unknown alive value leaked.");
Check(parsed.RootElement.GetProperty("state").GetProperty("result").ValueKind == JsonValueKind.Null, "Unknown state leaked.");
var history = parsed.RootElement.GetProperty("state").GetProperty("diagnosticEvents");
Check(history.GetArrayLength() == 16 && history[0].GetProperty("at").GetInt32() == 14, "History must keep only latest 16 events.");
output = EdufineSessionDiagnostics.Format("{\"schema\":1,\"timeOrigin\":1e500,\"remaining\":{\"internal\":\"PRIVATE_PAYLOAD\"},\"state\":{\"diagnosticEvents\":[{\"at\":1,\"code\":\"PRIVATE_PAYLOAD\"}]}}");
using var invalidNumbers = JsonDocument.Parse(output);
Check(invalidNumbers.RootElement.GetProperty("timeOrigin").ValueKind == JsonValueKind.Null, "Nonfinite numeric data leaked.");
Check(invalidNumbers.RootElement.GetProperty("remaining").GetProperty("internal").ValueKind == JsonValueKind.Null, "Coerced numeric string leaked.");
Check(invalidNumbers.RootElement.GetProperty("state").GetProperty("diagnosticEvents").GetArrayLength() == 0, "Unknown event code leaked.");
Console.WriteLine("PASS: diagnostic formatter privacy and bounds");
`);
      const run = promisify(execFile);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: diagnostic formatter privacy and bounds/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-session-diagnostics-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
