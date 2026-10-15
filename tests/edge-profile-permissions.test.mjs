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

test('certificate permissions merge safely into an isolated Edge profile', { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'oneclick-edge-permissions-'));
  try {
    await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
      <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable><NoWarn>CA1416</NoWarn></PropertyGroup>
      <ItemGroup>
        <Compile Include="${xml(resolve(root, 'EdgeIntegrationPolicy.cs'))}" Link="EdgeIntegrationPolicy.cs" />
        <Compile Include="${xml(resolve(root, 'EducationOffice.cs'))}" Link="EducationOffice.cs" />
      </ItemGroup>
    </Project>`);
    await writeFile(join(directory, 'Program.cs'), probe);
    const result = await run('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'], { timeout: 100_000 });
    assert.match(result.stdout, /PASS: 17 offices, scoped merge, blocked permission repair, idempotence, live lock, stale lock, malformed preferences/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('oneclick-edge-permissions-'));
    await rm(directory, { recursive: true, force: true });
  }
});

const probe = String.raw`
using System.Reflection;
using System.Text.Json.Nodes;
using BrowserThumbnailPrototype;

var method = typeof(EdgeIntegrationPolicy).GetMethod("PrepareProfile", BindingFlags.NonPublic | BindingFlags.Static)!;
bool Prepare(string path, EducationOffice office) => (bool)method.Invoke(null, [path, office])!;
void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
string PreferencesPath(string path) => Path.Combine(path, "Default", "Preferences");
JsonObject Read(string path) => JsonNode.Parse(File.ReadAllText(PreferencesPath(path)))!.AsObject();
void Save(string path, JsonObject preferences) => File.WriteAllText(PreferencesPath(path), preferences.ToJsonString());
var probeRoot = Path.Combine(Path.GetTempPath(), "oneclick-edge-probe-" + Guid.NewGuid().ToString("N"));
try
{
    foreach (var office in EducationOfficeCatalog.All)
    {
        var path = Path.Combine(probeRoot, office.Code);
        Check(Prepare(path, office), "New profile preparation failed: " + office.Code);
        var preferences = Read(path);
        var exceptions = preferences["profile"]!["content_settings"]!["exceptions"]!.AsObject();
        foreach (var permission in new[] { "local_network", "loopback_network", "local_network_access" })
        {
            var entries = exceptions[permission]!.AsObject();
            Check(entries.Count == 3, "Permissions extended beyond the three official sites.");
            foreach (var uri in new[] { office.PortalUri, office.NiceUri, office.EdufineUri })
                Check(entries[$"{uri.Scheme}://{uri.Host}:{uri.Port},*"]!["setting"]!.GetValue<int>() == 1,
                    "Missing local certificate permission: " + uri.Host);
        }
        var pairs = preferences["protocol_handler"]!["allowed_origin_protocol_pairs"]!.AsObject();
        Check(pairs.Count == 1 && pairs[office.EdufineUri.GetLeftPart(UriPartial.Authority)]!["wxsclient"]!.GetValue<bool>(),
            "WXSClient scope changed.");

        // A repeat must preserve the file, including last_modified timestamps.
        var original = File.ReadAllBytes(PreferencesPath(path));
        Check(Prepare(path, office), "Repeat preparation failed.");
        Check(original.SequenceEqual(File.ReadAllBytes(PreferencesPath(path))), "Repeat preparation rewrote preferences.");
    }

    var selected = EducationOfficeCatalog.GetByCode("goe");
    var profilePath = Path.Combine(probeRoot, "existing");
    Directory.CreateDirectory(Path.Combine(profilePath, "Default"));
    var seeded = JsonNode.Parse("""
        {"homepage":"https://example.org/","protocol_handler":{"allowed_origin_protocol_pairs":{"https://example.org":{"custom":true}}},
         "profile":{"content_settings":{"exceptions":{"popups":{"https://example.org:443,*":{"setting":2}},
         "local_network_access":{"https://goe.eduptl.kr:443,*":{"setting":2,"custom_metadata":"keep"},
         "https://unrelated.org:443,*":{"setting":2}}}}}}
        """)!.AsObject();
    Save(profilePath, seeded);
    Check(Prepare(profilePath, selected), "Existing blocked profile was not repaired.");
    var merged = Read(profilePath);
    Check(merged["homepage"]!.GetValue<string>() == "https://example.org/", "Unrelated setting changed.");
    Check(merged["protocol_handler"]!["allowed_origin_protocol_pairs"]!["https://example.org"]!["custom"]!.GetValue<bool>(), "Unrelated protocol lost.");
    Check(merged["profile"]!["content_settings"]!["exceptions"]!["popups"]!.ToJsonString()
        == seeded["profile"]!["content_settings"]!["exceptions"]!["popups"]!.ToJsonString(), "Popup settings changed.");
    var local = merged["profile"]!["content_settings"]!["exceptions"]!["local_network_access"]!;
    Check(local["https://goe.eduptl.kr:443,*"]!["setting"]!.GetValue<int>() == 1, "Blocked portal not allowed.");
    Check(local["https://goe.eduptl.kr:443,*"]!["custom_metadata"]!.GetValue<string>() == "keep", "Site metadata lost.");
    Check(local["https://unrelated.org:443,*"]!["setting"]!.GetValue<int>() == 2, "Unrelated origin changed.");

    // Emulate Windows Chromium's lifetime write handle and FILE_SHARE_READ.
    Save(profilePath, seeded);
    var before = File.ReadAllBytes(PreferencesPath(profilePath));
    var temporaryPath = Path.Combine(profilePath, "Default", "Preferences.oneclickportal.tmp");
    File.WriteAllText(temporaryPath, "another writer");
    using (var runningBrowser = new FileStream(Path.Combine(profilePath, "lockfile"), FileMode.OpenOrCreate, FileAccess.Write, FileShare.Read))
    {
        Check(!Prepare(profilePath, selected), "Running profile should require a restart.");
        Check(before.SequenceEqual(File.ReadAllBytes(PreferencesPath(profilePath))), "Running profile was overwritten.");
        Check(File.ReadAllText(temporaryPath) == "another writer", "Failed lock mutated a temporary file.");
    }
    Check(Prepare(profilePath, selected), "Stale unlocked lockfile prevented repair.");
    using (var runningBrowser = new FileStream(Path.Combine(profilePath, "lockfile"), FileMode.Open, FileAccess.Write, FileShare.Read))
        Check(Prepare(profilePath, selected), "Already prepared live profile should be reusable without writes.");

    File.WriteAllText(PreferencesPath(profilePath), "{broken json");
    Check(!Prepare(profilePath, selected), "Malformed preferences should fail without replacement.");
    Check(File.ReadAllText(PreferencesPath(profilePath)) == "{broken json", "Malformed preferences were discarded.");
    Console.WriteLine("PASS: 17 offices, scoped merge, blocked permission repair, idempotence, live lock, stale lock, malformed preferences");
}
finally
{
    var temporaryRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
    if (!Path.GetFullPath(probeRoot).StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(probeRoot).StartsWith("oneclick-edge-probe-", StringComparison.Ordinal))
        throw new Exception("Probe cleanup path is outside the temporary test directory.");
    if (Directory.Exists(probeRoot)) Directory.Delete(probeRoot, recursive: true);
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
