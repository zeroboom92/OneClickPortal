import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');

test('the real dock handle recovers native topmost visibility without taking focus or bypassing pauses',
  {skip:process.platform !== 'win32', timeout:120_000}, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'oneclick-top-dock-visibility-'));
    try {
      await writeFile(join(directory, 'Probe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework>
          <UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup>
        <ItemGroup><Compile Include="${xml(resolve(root, 'TopDockController.cs'))}" Link="TopDockController.cs" /></ItemGroup>
      </Project>`);
      await writeFile(join(directory, 'Program.cs'), probe);
      const result = await promisify(execFile)('dotnet', ['run', '--project', join(directory, 'Probe.csproj'), '--configuration', 'Release'],
        {timeout:110_000, maxBuffer:1024 * 1024}).catch(error => {
          throw new Error(`${error.stdout ?? ''}\n${error.stderr ?? ''}`);
        });
      assert.match(result.stdout, /PASS: covered topmost, native demotion, focus, hidden, disabled, modal, suspension, disposal, 96 DPI/);

      // Prove the same native coverage check detects the previous implementation.
      // Only a temporary source copy loses the repair call; the product is untouched.
      const currentSource = await readFile(resolve(root, 'TopDockController.cs'), 'utf8');
      const originalBehavior = currentSource.replace(/^\s*if \(visible\) EnsureHandleOnTop\(\);\r?\n/m, '\n');
      assert.notEqual(originalBehavior, currentSource, 'The repair call for the sensitivity fixture was not found.');
      await writeFile(join(directory, 'LegacyTopDockController.txt'), originalBehavior);
      await writeFile(join(directory, 'LegacyProbe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework>
          <UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable>
          <EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>
        <ItemGroup><Compile Include="Program.cs" /><Compile Include="LegacyTopDockController.txt" Link="TopDockController.cs" /></ItemGroup>
      </Project>`);
      const legacyResult = await promisify(execFile)('dotnet', ['run', '--project', join(directory, 'LegacyProbe.csproj'), '--configuration', 'Release'],
        {timeout:110_000, maxBuffer:1024 * 1024}).then(value => ({...value, failed:false}), error => ({
          stdout:error.stdout ?? '', stderr:error.stderr ?? '', failed:true,
        }));
      assert.equal(legacyResult.failed, true, 'The previous visibility behavior unexpectedly passed the native coverage regression.');
      assert.match(legacyResult.stderr, /A visible topmost handle remained behind another topmost window\./);

      // Reintroducing Form.TopMost's activating setter must also fail, even when
      // Windows foreground policy prevents an observable foreground transition.
      const unsafeBehavior = currentSource.replace(
        '        SetWindowPos(window, new IntPtr(-1),',
        '        _handle.TopMost = true;\n        SetWindowPos(window, new IntPtr(-1),');
      assert.notEqual(unsafeBehavior, currentSource, 'The native repair call for the unsafe-setter fixture was not found.');
      await writeFile(join(directory, 'UnsafeTopDockController.txt'), unsafeBehavior);
      await writeFile(join(directory, 'UnsafeProbe.csproj'), `<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework>
          <UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable>
          <EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>
        <ItemGroup><Compile Include="Program.cs" /><Compile Include="UnsafeTopDockController.txt" Link="TopDockController.cs" /></ItemGroup>
      </Project>`);
      const unsafeResult = await promisify(execFile)('dotnet', ['run', '--project', join(directory, 'UnsafeProbe.csproj'), '--configuration', 'Release'],
        {timeout:110_000, maxBuffer:1024 * 1024}).then(value => ({...value, failed:false}), error => ({
          stdout:error.stdout ?? '', stderr:error.stderr ?? '', failed:true,
        }));
      assert.equal(unsafeResult.failed, true, 'The activating Form.TopMost setter unexpectedly passed the native focus regression.');
      assert.match(unsafeResult.stderr, /Handle positioning omitted SWP_NOACTIVATE:/);
    } finally {
      assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-top-dock-visibility-'));
      await rm(directory, {recursive:true, force:true});
    }
  });

const probe = String.raw`
using BrowserThumbnailPrototype;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class Program
{
    private const BindingFlags PrivateInstance = BindingFlags.Instance | BindingFlags.NonPublic;
    private const uint PositionFlags = 0x0001 | 0x0002 | 0x0010 | 0x0200; // NOSIZE, NOMOVE, NOACTIVATE, NOOWNERZORDER
    private static readonly nint Topmost = new(-1), NotTopmost = new(-2);

    [STAThread]
    private static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.DpiUnaware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using var portal = new Form
        {
            Text = "OneClick isolated dock regression", FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual, AutoScaleMode = AutoScaleMode.None,
            Size = new Size(600, 110), ShowInTaskbar = false,
        };
        using var cover = new Form
        {
            Text = "OneClick isolated covering window", FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual, AutoScaleMode = AutoScaleMode.None,
            ShowInTaskbar = false, TopMost = true,
        };
        portal.Show();
        using var dock = new TopDockController(portal);
        dock.Enable();
        var handle = Field<Form>(dock, "_handle");
        var button = Field<Button>(dock, "_button");
        StopTimers(dock);
        // Choose a position away from the existing cursor. Never move the cursor or
        // send input to any browser or other application.
        var work = Screen.FromControl(portal).WorkingArea;
        var desiredX = Cursor.Position.X < work.Left + work.Width / 2 ? work.Right - portal.Width : work.Left;
        SetField(dock, "_anchor", new Point(desiredX, work.Top));
        SetField(dock, "_hoverOpenSuppressed", true);
        SetField(dock, "_expanded", false);
        SetField(dock, "_progress", 0d);
        dock.Reposition();
        StopTimers(dock);
        Check(handle.Visible && !dock.IsExpanded, "The collapsed handle was not visible.");
        Check(portal.DeviceDpi == 96 && handle.Size == new Size(104, 32)
            && button.Size == handle.ClientSize && button.Text == "▼ 업무포털",
            "The compact 96 DPI handle dimensions or label changed.");
        var label = TextRenderer.MeasureText(button.Text, button.Font, Size.Empty,
            TextFormatFlags.SingleLine | TextFormatFlags.NoPadding);
        Check(label.Width <= button.ClientSize.Width - 8 && label.Height <= button.ClientSize.Height - 4,
            "The collapsed label no longer fits inside the compact button.");
        using var positionMonitor = new HandlePositionMonitor(handle.Handle);

        void Cover()
        {
            cover.Bounds = handle.Bounds;
            if (!cover.Visible) cover.Show();
            Check(SetWindowPos(cover.Handle, Topmost, 0, 0, 0, 0, PositionFlags), "Could not raise the isolated covering window.");
            Check(RootAtCenter(handle) == cover.Handle, "The isolated covering window did not actually cover the handle.");
        }
        void Demote()
        {
            Check(SetWindowPos(handle.Handle, NotTopmost, 0, 0, 0, 0, PositionFlags), "Could not demote the isolated handle.");
            Check(!IsTopmost(handle), "Native demotion did not remove WS_EX_TOPMOST.");
        }
        void TickWithoutFocusChange()
        {
            var foreground = GetForegroundWindow();
            positionMonitor.BeginTick();
            try { Tick(dock); }
            finally { positionMonitor.EndTick(); }
            Check(positionMonitor.Flags.All(flags => (flags & 0x0010) != 0),
                "Handle positioning omitted SWP_NOACTIVATE: "
                    + string.Join(", ", positionMonitor.Flags.Select(flags => $"0x{flags:X}")));
            Check(GetForegroundWindow() == foreground, "Visibility repair took foreground focus.");
        }

        Cover();
        Check(handle.Visible && handle.TopMost && IsTopmost(handle), "The covering case did not retain visible/topmost state.");
        TickWithoutFocusChange();
        Check(RootAtCenter(handle) == handle.Handle, "A visible topmost handle remained behind another topmost window.");
        Check(positionMonitor.Flags.Count > 0, "The native position monitor did not observe visibility repair.");

        Cover();
        Demote();
        Check(handle.TopMost, "The managed TopMost property unexpectedly tracked native demotion; regression fixture is ineffective.");
        TickWithoutFocusChange();
        Check(IsTopmost(handle) && RootAtCenter(handle) == handle.Handle,
            "The native topmost state was not restored when the managed property was still true.");

        SetField(dock, "_expanded", true);
        Cover(); Demote(); TickWithoutFocusChange();
        Check(!IsTopmost(handle) && RootAtCenter(handle) == cover.Handle,
            "An expanded menu raised the handle over active controls.");
        SetField(dock, "_expanded", false);
        TickWithoutFocusChange();
        Check(IsTopmost(handle), "A collapsed menu did not resume visibility repair.");

        Field<System.Windows.Forms.Timer>(dock, "_animation").Start();
        Cover(); Demote(); TickWithoutFocusChange();
        Check(!IsTopmost(handle) && RootAtCenter(handle) == cover.Handle,
            "An animating menu raised the handle before reaching its idle state.");
        StopTimers(dock);
        TickWithoutFocusChange();
        Check(IsTopmost(handle), "Finishing animation did not permit visibility repair.");

        SetField<Control?>(dock, "_dragControl", button);
        Cover(); Demote(); TickWithoutFocusChange();
        Check(!IsTopmost(handle) && RootAtCenter(handle) == cover.Handle,
            "An active drag raised the handle over the user's interaction.");
        SetField<Control?>(dock, "_dragControl", null);
        TickWithoutFocusChange();
        Check(IsTopmost(handle), "Finishing a drag did not permit visibility repair.");

        using (dock.SuspendAutoHide())
        {
            Cover(); Demote(); TickWithoutFocusChange();
            Check(!IsTopmost(handle) && RootAtCenter(handle) == cover.Handle,
                "A suspended dock raised itself over active work.");
        }
        Check(IsTopmost(handle) && RootAtCenter(handle) == handle.Handle, "Resuming the dock did not restore its discoverable handle.");

        portal.Enabled = false;
        Cover(); Demote(); TickWithoutFocusChange();
        Check(!IsTopmost(handle) && RootAtCenter(handle) == cover.Handle, "A disabled portal raised its handle.");
        portal.Enabled = true;
        TickWithoutFocusChange();
        Check(IsTopmost(handle) && RootAtCenter(handle) == handle.Handle, "Re-enabling the portal did not restore its handle.");

        using (var dialog = new Form
        {
            Text = "OneClick isolated modal", ShowInTaskbar = false, StartPosition = FormStartPosition.Manual,
            Bounds = new Rectangle(work.Left + 20, work.Top + 150, 220, 100),
        })
        {
            Exception? failure = null;
            dialog.Shown += (_, _) =>
            {
                try
                {
                    // Keep the test portal enabled so this checks the modal guard
                    // independently of the ordinary disabled-owner guard.
                    portal.Enabled = true;
                    Check(dialog.Modal && dialog.Visible, "The isolated modal guard fixture was not modal.");
                    Cover(); Demote(); TickWithoutFocusChange();
                    Check(!IsTopmost(handle) && RootAtCenter(handle) == cover.Handle,
                        "The handle raised itself while a modal dialog was visible.");
                }
                catch (Exception exception) { failure = exception; }
                finally { dialog.Close(); }
            };
            dialog.ShowDialog(portal);
            portal.Enabled = true;
            if (failure is not null) throw failure;
        }
        StopTimers(dock);
        TickWithoutFocusChange();
        Check(IsTopmost(handle) && RootAtCenter(handle) == handle.Handle, "Closing the modal did not permit visibility repair.");

        Demote();
        portal.Hide();
        TickWithoutFocusChange();
        Check(!handle.Visible && !IsTopmost(handle), "A hidden portal revived its handle.");
        portal.Show();
        StopTimers(dock);
        SetField(dock, "_hoverOpenSuppressed", true);
        TickWithoutFocusChange();
        Check(handle.Visible && IsTopmost(handle), "Showing the portal did not restore its handle.");

        dock.Disable();
        Demote();
        TickWithoutFocusChange();
        Check(!dock.Enabled && !handle.Visible && !IsTopmost(handle) && !portal.TopMost,
            "Disabled dock monitoring revived the handle or changed the floating preference.");
        dock.Enable();
        StopTimers(dock);
        SetField(dock, "_hoverOpenSuppressed", true);
        TickWithoutFocusChange();
        Check(handle.Visible && IsTopmost(handle), "Enabling the dock again did not reveal the handle.");

        var retiredHandle = handle.Handle;
        dock.Dispose();
        TickWithoutFocusChange();
        Check(handle.IsDisposed && !IsWindow(retiredHandle) && !dock.Enabled,
            "Disposal left a native handle or allowed monitoring to resume.");
        Console.WriteLine("PASS: covered topmost, native demotion, focus, hidden, disabled, modal, suspension, disposal, 96 DPI");
    }

    private static void Check(bool passed, string message) { if (!passed) throw new Exception(message); }
    private static T Field<T>(TopDockController dock, string name) => (T)typeof(TopDockController).GetField(name, PrivateInstance)!.GetValue(dock)!;
    private static void SetField<T>(TopDockController dock, string name, T value) => typeof(TopDockController).GetField(name, PrivateInstance)!.SetValue(dock, value);
    private static void StopTimers(TopDockController dock)
    {
        Field<System.Windows.Forms.Timer>(dock, "_hover").Stop();
        Field<System.Windows.Forms.Timer>(dock, "_animation").Stop();
    }
    private static void Tick(TopDockController dock) => typeof(TopDockController).GetMethod("UpdateAutoHide", PrivateInstance)!.Invoke(dock, null);
    private static bool IsTopmost(Form value) => (GetWindowLong(value.Handle, -20).ToInt64() & 8) != 0;
    private static nint RootAtCenter(Form value) => GetAncestor(WindowFromPoint(new NativePoint(
        value.Left + value.Width / 2, value.Top + value.Height / 2)), 2);
    private static nint GetWindowLong(nint handle, int index) => IntPtr.Size == 8
        ? GetWindowLongPtr64(handle, index) : new nint(GetWindowLong32(handle, index));
    private sealed class HandlePositionMonitor : NativeWindow, IDisposable
    {
        private bool _watching;
        public List<uint> Flags { get; } = [];
        public HandlePositionMonitor(nint handle) => AssignHandle(handle);
        public void BeginTick() { Flags.Clear(); _watching = true; }
        public void EndTick() => _watching = false;
        protected override void WndProc(ref Message message)
        {
            if (_watching && message.Msg == 0x0046 && message.LParam != nint.Zero) // WM_WINDOWPOSCHANGING
                Flags.Add(Marshal.PtrToStructure<WindowPosition>(message.LParam).Flags);
            base.WndProc(ref message);
        }
        public void Dispose() => ReleaseHandle();
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPosition
    {
        public nint Window, InsertAfter;
        public int X, Y, Width, Height;
        public uint Flags;
    }
    [StructLayout(LayoutKind.Sequential)] private readonly record struct NativePoint(int X, int Y);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern nint GetWindowLongPtr64(nint handle, int index);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowLong32(nint handle, int index);
    [DllImport("user32.dll")] private static extern nint WindowFromPoint(NativePoint point);
    [DllImport("user32.dll")] private static extern nint GetAncestor(nint handle, uint flags);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool IsWindow(nint handle);
    [DllImport("user32.dll")] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowPos(nint handle, nint after, int x, int y, int width, int height, uint flags);
}

namespace BrowserThumbnailPrototype
{
    internal static class AppRelease
    {
        public const bool IsBeta = false;
        // This stub is unused by the stable controller, which only reads its normal
        // saved anchor. No drag/save path is invoked and no key is created or written.
        public static string SettingsKeyPath { get; } = @"Software\OneClickPortalIsolatedTests\" + Guid.NewGuid().ToString("N");
    }
    internal static class AppPreferences { public static bool IsAlwaysOnTopEnabled() => false; }
    internal static class AppLogger { public static void Error(string area, string message, Exception exception) => throw new Exception("Unexpected dock persistence.", exception); }
    internal static class PortalWindowShape
    {
        public static Region CreateForeground(Form portal) => new(new Rectangle(Point.Empty, portal.Size));
        public static Region Create(Size size, int dpi) => new(new Rectangle(Point.Empty, size));
    }
}
`;
