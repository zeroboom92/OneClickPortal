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

test('actual approval polling schedule honors active/background intervals and independent full scans',
  { timeout: 120_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-approval-polling-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup>
          <Compile Include="${xml(resolve(root, 'ApprovalPollingSchedule.cs'))}" Link="ApprovalPollingSchedule.cs" />
        </ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        { timeout: 100_000 });
      assert.match(result.stdout, /PASS: initial, 5s boundary, 60s boundary, force, active transitions, reset, independent full scans/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-approval-polling-'));
      await rm(directory, { recursive: true, force: true });
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;

void Check(bool passed, string message) { if (!passed) throw new Exception(message); }

var schedule = new ApprovalPollingSchedule();
const long start = 10_000;
Check(schedule.IsDue(start, true), "Initial active read must be due.");
Check(schedule.IsDue(start, false), "Initial background read must be due.");
Check(schedule.RequiresFullScan(start, false), "Initial read must inspect the full page.");
Check(schedule.RequiresFullScan(start, true), "Initial forced read must inspect the full page.");

// Queries are pure: only recording an attempt changes the schedule.
Check(schedule.IsDue(start, true), "Checking due time unexpectedly recorded an attempt.");
schedule.RecordAttempt(start, fullScan: true);
Check(!schedule.IsDue(start, true), "A recorded attempt must suppress an immediate repeat.");
Check(!schedule.IsDue(start + 4_999, true), "Active polling ran before 5 seconds.");
Check(schedule.IsDue(start + 5_000, true), "Active polling did not run at 5 seconds.");
Check(!schedule.IsDue(start + 59_999, false), "Background polling ran before 60 seconds.");
Check(schedule.IsDue(start + 60_000, false), "Background polling did not run at 60 seconds.");
Check(!schedule.RequiresFullScan(start + 59_999, false), "Full scan ran before 60 seconds.");
Check(schedule.RequiresFullScan(start + 60_000, false), "Full scan did not run at 60 seconds.");
Check(schedule.RequiresFullScan(start, true), "A forced read must bypass the full scan interval.");
Check(!schedule.RequiresFullScan(start, false), "A force query changed the recorded scan time.");

// Activity is evaluated at the current call, without creating another timer or resetting elapsed time.
Check(!schedule.IsDue(start + 8_000, false), "Inactive polling used the active interval.");
Check(schedule.IsDue(start + 8_000, true), "Becoming active must use elapsed time since the last attempt.");
schedule.RecordAttempt(start + 8_000, fullScan: false);
Check(!schedule.IsDue(start + 12_999, true), "A quick read failed to restart the active attempt interval.");
Check(schedule.IsDue(start + 13_000, true), "Active attempt boundary changed after a quick read.");
Check(!schedule.IsDue(start + 13_000, false), "Becoming inactive must select the background interval.");
Check(!schedule.IsDue(start + 67_999, false), "Inactive attempt interval began before the last attempt.");
Check(schedule.IsDue(start + 68_000, false), "Inactive attempt interval did not begin at the last attempt.");

schedule.Reset();
Check(schedule.IsDue(start, true) && schedule.IsDue(start, false), "Reset retained the last attempt.");
Check(schedule.RequiresFullScan(start, false), "Reset retained the last full scan.");
schedule.RecordAttempt(start, fullScan: false);
Check(schedule.RequiresFullScan(start, false), "A quick read incorrectly supplied the missing full scan.");

schedule.Reset();
schedule.RecordAttempt(start, fullScan: true);
for (long elapsed = 5_000; elapsed < 60_000; elapsed += 5_000)
{
    Check(schedule.IsDue(start + elapsed, true), "Quick read not due at its active boundary.");
    Check(!schedule.RequiresFullScan(start + elapsed, false), "Quick reads caused an early full scan.");
    schedule.RecordAttempt(start + elapsed, fullScan: false);
}
Check(schedule.IsDue(start + 60_000, true), "Quick read not due at 60 seconds.");
Check(schedule.RequiresFullScan(start + 60_000, false), "Repeated quick reads postponed the full scan.");
schedule.RecordAttempt(start + 60_000, fullScan: true);
Check(!schedule.RequiresFullScan(start + 119_999, false), "Full scan recording failed to restart its own interval.");
Check(schedule.RequiresFullScan(start + 120_000, false), "Second full scan boundary changed.");

Console.WriteLine("PASS: initial, 5s boundary, 60s boundary, force, active transitions, reset, independent full scans");
`;
