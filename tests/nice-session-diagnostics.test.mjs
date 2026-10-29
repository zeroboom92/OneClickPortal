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
const source = fs.readFileSync(new URL('../NiceSessionDiagnostics.cs', import.meta.url), 'utf8');
const script = source.split('internal static string Script() => """')[1].split('"""')[0];
const runScript = globals => JSON.parse(vm.runInNewContext(script, {
  document: { readyState: 'complete', visibilityState: 'hidden' },
  performance: { timeOrigin: 1793161187210.1 }, ...globals
}));

function fixture() {
  const original = function () {};
  const wrapper = function () {};
  const timer = { value: '49분 30초' };
  const main = { disposed: false, lookup(id) { assert.equal(id, 'optTime'); return timer; } };
  const jquery = { ajax: wrapper, __oneClickAjaxWrapperV3: wrapper, __oneClickOriginalAjaxV3: original };
  const state = { inFlight: false, startedAt: 1000, completedAt: 1100, result: 'Y', reported: true,
    requestSequence: 3, requestId: 3, ownerSource: 'program', serverResult: 'Y',
    timerResetResult: 'Y', timerResetAt: 1100, diagnosticEvents: [
      { at: 1000, code: 'REQUEST_START', remaining: 2400, requestId: 3 },
      { at: 1100, code: 'RESPONSE_Y', remaining: 2970, requestId: 3 }
    ] };
  return { main, jquery, state, timer, globals: { voMainApp: main, jQuery: jquery, __oneClickNiceServerKeepAliveV3: state } };
}

test('diagnostics distinguish the live ajax binding and record actual request and reset states', () => {
  const f = fixture();
  let result = runScript(f.globals);
  assert.equal(result.timeOrigin, 1793161187210.1);
  assert.deepEqual(result.main, { present: true, disposed: false });
  assert.equal(result.remaining.display, 2970);
  assert.deepEqual(result.binding, { jqueryPresent: true, ajaxIdentity: true, originalIdentity: false });
  assert.equal(result.state.requestSequence, 3);
  assert.equal(result.state.serverResult, 'Y');
  assert.equal(result.state.timerResetResult, 'Y');
  assert.equal(result.state.timerResetAt, 1100);
  assert.equal(result.state.ownerSource, 'program');
  f.jquery.ajax = f.jquery.__oneClickOriginalAjaxV3;
  f.state.result = 'Y_RESET_FAILED';
  f.state.timerResetResult = 'Y_RESET_FAILED';
  result = runScript(f.globals);
  assert.equal(result.binding.ajaxIdentity, false);
  assert.equal(result.binding.originalIdentity, true);
  assert.equal(result.state.result, 'Y_RESET_FAILED');
  assert.equal(result.state.serverResult, 'Y');
  assert.equal(result.state.timerResetResult, 'Y_RESET_FAILED');
});

test('diagnostics handle unavailable state, missing main and bounded timer-only DOM fallback', () => {
  let result = runScript({});
  assert.equal(result.main.present, false);
  assert.equal(result.main.disposed, null);
  assert.equal(result.remaining.display, null);
  assert.equal(result.binding.ajaxIdentity, null);
  assert.equal(result.state.result, null);
  assert.deepEqual(result.state.diagnosticEvents, []);
  const document = { readyState: 'complete', visibilityState: 'hidden', querySelectorAll(selector) {
    assert.equal(selector, '[id$="optTime"],[aria-label="세션 종료 시간"]');
    return [{ innerText: '01분 05초' }];
  } };
  result = runScript({ document });
  assert.equal(result.remaining.display, 65);
  document.querySelectorAll = () => [{ innerText: '1분 00초' }, { innerText: '2분 00초' }];
  assert.equal(runScript({ document }).remaining.display, null);
  document.querySelectorAll = () => Array.from({ length: 5 }, () => ({ innerText: '1분 00초' }));
  assert.equal(runScript({ document }).remaining.display, null);
  document.querySelectorAll = () => [{ innerText: '1분 60초' }];
  assert.equal(runScript({ document }).remaining.display, null);
  const main = { disposed: false, lookup() { throw new Error('not loaded'); } };
  document.querySelectorAll = () => [{ textContent: '50분 00초' }];
  assert.equal(runScript({ voMainApp: main, document }).remaining.display, 3000);
});

test('diagnostics never inspect account, credentials, broad page contents or function source', () => {
  const f = fixture();
  const forbidden = () => { throw new Error('Private property was accessed'); };
  for (const object of [f.main, f.jquery, f.state, f.timer]) {
    for (const key of ['account', 'student', 'school', 'url', 'targetId', 'cookies'])
      Object.defineProperty(object, key, { get: forbidden });
  }
  f.jquery.ajax.toString = forbidden;
  f.main.callAppMethod = forbidden;
  const document = { readyState: 'complete', visibilityState: 'hidden', querySelectorAll: forbidden };
  for (const key of ['body', 'URL', 'location', 'title', 'cookie']) Object.defineProperty(document, key, { get: forbidden });
  f.state.diagnosticEvents[0].account = 'PRIVATE_PAYLOAD';
  f.state.diagnosticEvents[0].text = 'PRIVATE_PAYLOAD';
  const before = JSON.stringify(f.state);
  const result = runScript({ ...f.globals, document, location: new Proxy({}, { get: forbidden }) });
  assert.equal(result.state.result, 'Y');
  assert.equal(JSON.stringify(result).includes('PRIVATE_PAYLOAD'), false);
  assert.equal(JSON.stringify(f.state), before);
  assert.deepEqual(Object.keys(result.state.diagnosticEvents[0]).sort(), ['at', 'code', 'remaining', 'requestId']);
});

test('diagnostics bound event history and reject unsafe numbers, injected results and non-timer text', () => {
  const f = fixture();
  f.timer.value = { toString() { throw new Error('Must not coerce arbitrary page data'); } };
  Object.assign(f.state, { inFlight: 'true', result: 'PRIVATE_PAYLOAD\nFORGED_LOG', reported: 'true',
    requestSequence: NaN, requestId: Number.MAX_SAFE_INTEGER + 1, startedAt: 1.5,
    ownerSource: 'PRIVATE_PAYLOAD', serverResult: 'HTTP_401', timerResetResult: 'PRIVATE_PAYLOAD',
    timerResetAt: Infinity, diagnosticEvents: Array.from({ length: 30 }, (_, at) => ({
      at, code: 'REQUEST_START', remaining: -Infinity, requestId: 'PRIVATE_PAYLOAD', account: 'PRIVATE_PAYLOAD'
    })) });
  f.state.diagnosticEvents[29].code = 'PRIVATE_PAYLOAD';
  const result = runScript(f.globals);
  assert.equal(result.remaining.display, null);
  assert.equal(result.state.result, 'UNKNOWN');
  assert.equal(result.state.serverResult, 'HTTP_ERROR');
  for (const key of ['inFlight', 'reported', 'requestSequence', 'requestId', 'startedAt', 'ownerSource', 'timerResetResult', 'timerResetAt'])
    assert.equal(result.state[key], null, key);
  assert.equal(result.state.diagnosticEvents.length, 15);
  assert.equal(result.state.diagnosticEvents[0].at, 14);
  assert.equal(result.state.diagnosticEvents[0].remaining, null);
  assert.equal(result.state.diagnosticEvents[0].requestId, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_PAYLOAD'), false);
});

test('actual C# formatter independently validates privacy, schema, history, numeric bounds and depth',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-nice-diagnostics-'));
    const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root, 'NiceSessionDiagnostics.cs'))}" Link="NiceSessionDiagnostics.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), String.raw`
using System.Text.Json;
using BrowserThumbnailPrototype;
void Check(bool condition, string message) { if (!condition) throw new Exception(message); }
Check(NiceSessionDiagnostics.Format(null).Contains("EMPTY"), "Null input must be handled.");
Check(NiceSessionDiagnostics.Format("{").Contains("INVALID_JSON"), "Invalid JSON must be handled.");
Check(NiceSessionDiagnostics.Format("[]").Contains("INVALID_SCHEMA"), "Wrong schema must be rejected.");
Check(NiceSessionDiagnostics.Format("{\"schema\":1.5}").Contains("INVALID_SCHEMA"), "Fractional schema must be rejected.");
Check(NiceSessionDiagnostics.Format(new string('x', 32769)).Contains("TOO_LARGE"), "Large input must be bounded.");
Check(NiceSessionDiagnostics.Format("{\"schema\":1,\"ignored\":" + new string('[', 13) + "0" + new string(']', 13) + "}").Contains("INVALID_JSON"), "Nested input must be bounded.");
var events = Enumerable.Range(0, 30).Select(at => new { at, code = "REQUEST_START", remaining = 2200, requestId = 1, account = "PRIVATE_PAYLOAD" });
var input = JsonSerializer.Serialize(new { schema = 1, readyState = "complete", visibility = "hidden", timeOrigin = 1793161187210.1,
    account = "PRIVATE_PAYLOAD", main = new { present = true, disposed = false }, remaining = new { display = 2200 },
    binding = new { jqueryPresent = true, ajaxIdentity = false, originalIdentity = true },
    state = new { result = "PRIVATE_PAYLOAD\nFORGED_LOG", ownerSource = "PRIVATE_PAYLOAD", serverResult = "Y", timerResetResult = "Y_RESET_FAILED", timerResetAt = 12,
        diagnosticEvents = events } });
var output = NiceSessionDiagnostics.Format(input);
Check(!output.Contains("PRIVATE_PAYLOAD") && !output.Contains("FORGED_LOG") && !output.Contains('\n') && !output.Contains('\r'), "Private or multiline data leaked.");
using var parsed = JsonDocument.Parse(output);
Check(parsed.RootElement.GetProperty("main").GetProperty("present").GetBoolean(), "Main presence lost.");
Check(!parsed.RootElement.GetProperty("binding").GetProperty("ajaxIdentity").GetBoolean(), "Mismatch lost.");
Check(parsed.RootElement.GetProperty("state").GetProperty("result").ValueKind == JsonValueKind.Null, "Unknown state leaked.");
Check(parsed.RootElement.GetProperty("state").GetProperty("ownerSource").ValueKind == JsonValueKind.Null, "Unknown source leaked.");
Check(parsed.RootElement.GetProperty("state").GetProperty("serverResult").GetString() == "Y", "Server result lost.");
Check(parsed.RootElement.GetProperty("state").GetProperty("timerResetResult").GetString() == "Y_RESET_FAILED", "Reset result lost.");
Check(parsed.RootElement.GetProperty("timeOrigin").GetDouble() == 1793161187210.1, "Fractional performance origin lost.");
var history = parsed.RootElement.GetProperty("state").GetProperty("diagnosticEvents");
Check(history.GetArrayLength() == 16 && history[0].GetProperty("at").GetInt32() == 14, "History must keep only latest 16 events.");
Check(history[0].EnumerateObject().Count() == 4, "Event properties must be fixed.");
output = NiceSessionDiagnostics.Format("{\"schema\":1,\"timeOrigin\":1e500,\"remaining\":{\"display\":\"PRIVATE_PAYLOAD\"},\"state\":{\"result\":\"HTTP_401\",\"requestId\":9007199254740992,\"requestSequence\":1.5,\"reported\":\"true\",\"diagnosticEvents\":[{\"at\":1,\"code\":\"PRIVATE_PAYLOAD\"}]}}");
using var invalidNumbers = JsonDocument.Parse(output);
Check(invalidNumbers.RootElement.GetProperty("timeOrigin").ValueKind == JsonValueKind.Null, "Nonfinite numeric data leaked.");
Check(invalidNumbers.RootElement.GetProperty("remaining").GetProperty("display").ValueKind == JsonValueKind.Null, "Coerced numeric string leaked.");
var invalidState = invalidNumbers.RootElement.GetProperty("state");
Check(invalidState.GetProperty("requestId").ValueKind == JsonValueKind.Null, "Unsafe integer leaked.");
Check(invalidState.GetProperty("requestSequence").ValueKind == JsonValueKind.Null, "Fractional counter leaked.");
Check(invalidState.GetProperty("reported").ValueKind == JsonValueKind.Null, "Coerced boolean leaked.");
Check(invalidState.GetProperty("result").GetString() == "HTTP_ERROR", "HTTP error was not normalized.");
Check(invalidState.GetProperty("diagnosticEvents").GetArrayLength() == 0, "Unknown event code leaked.");
Console.WriteLine("PASS: NICE diagnostic formatter privacy and bounds");
`);
      const run = promisify(execFile);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: NICE diagnostic formatter privacy and bounds/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-nice-diagnostics-'));
      await rm(directory, { recursive: true, force: true });
    }
  });
