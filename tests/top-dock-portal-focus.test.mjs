import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const run=promisify(execFile);
const xml=value=>value.replaceAll('&','&amp;').replaceAll('"','&quot;');
const nativePlacement='            if (_portal.IsHandleCreated)\n'
  +'                SetWindowPos(_portal.Handle, new IntPtr(-1), 0, 0, 0, 0,\n'
  +'                    0x0001 | 0x0002 | 0x0010 | 0x0200); // NOSIZE | NOMOVE | NOACTIVATE | NOOWNERZORDER';

test('portal animation and geometry preserve foreground, repair native topmost, and retain explicit keyboard focus',
  {skip:process.platform!=='win32',timeout:180_000},async t=>{
    const directory=await mkdtemp(join(tmpdir(),'oneclick-dock-portal-focus-'));
    try{
      const project=source=>`<Project Sdk="Microsoft.NET.Sdk">
        <PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework>
          <UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable>
          <EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup>
        <ItemGroup><Compile Include="Program.cs" /><Compile Include="${xml(source)}" Link="TopDockController.cs" /></ItemGroup>
      </Project>`;
      await writeFile(join(directory,'Program.cs'),probe);
      await writeFile(join(directory,'Probe.csproj'),project(resolve(root,'TopDockController.cs')));
      const args=name=>['run','--project',join(directory,name),'--configuration','Release'];
      const result=await run('dotnet',args('Probe.csproj'),{timeout:100_000,maxBuffer:1024*1024})
        .catch(error=>{throw new Error(`${error.stdout??''}\n${error.stderr??''}`)});
      assert.match(result.stdout,/PASS: portal foreground, actual animation, geometry, native topmost, native flags, keyboard focus, uncreated handle, preferences/);
      const foregroundEvidence=/OWNED_FOREGROUND_OBSERVED=(True|False)/.exec(result.stdout);
      assert.ok(foregroundEvidence,'The owned foreground observation must be reported separately from native flag checks.');
      t.diagnostic('Owned isolated foreground observed: '+foregroundEvidence[1]);

      const source=(await readFile(resolve(root,'TopDockController.cs'),'utf8')).replaceAll('\r\n','\n');
      assert.ok(source.includes(nativePlacement),'The actual portal native placement must be available for sensitivity checks.');
      // Reinsert the previous setter only in an isolated copy. Native flags must
      // catch it even when Windows refuses an observable foreground transition.
      const unsafe=source.replace(nativePlacement,'            _portal.TopMost = true;\n'+nativePlacement);
      await writeFile(join(directory,'UnsafeTopDockController.txt'),unsafe);
      await writeFile(join(directory,'Unsafe.csproj'),project('UnsafeTopDockController.txt'));
      const unsafeResult=await run('dotnet',args('Unsafe.csproj'),{timeout:100_000,maxBuffer:1024*1024})
        .then(value=>({...value,failed:false}),error=>({stdout:error.stdout??'',stderr:error.stderr??'',failed:true}));
      assert.equal(unsafeResult.failed,true,'The activating portal setter unexpectedly passed the foreground regression.');
      assert.match(unsafeResult.stderr,/Portal topmost positioning omitted required nonactivating flags:/);

      // Removing repair entirely must also fail: the managed TopMost value can
      // remain true while native WS_EX_TOPMOST has disappeared.
      const missing=source.replace(nativePlacement,'            // Isolated missing-repair fixture.');
      await writeFile(join(directory,'MissingTopDockController.txt'),missing);
      await writeFile(join(directory,'Missing.csproj'),project('MissingTopDockController.txt'));
      const missingResult=await run('dotnet',args('Missing.csproj'),{timeout:100_000,maxBuffer:1024*1024})
        .then(value=>({...value,failed:false}),error=>({stdout:error.stdout??'',stderr:error.stderr??'',failed:true}));
      assert.equal(missingResult.failed,true,'Removing native portal repair unexpectedly passed the regression.');
      assert.match(missingResult.stderr,/Portal native topmost state was not restored\./);
    }finally{
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-dock-portal-focus-'));
      await rm(directory,{recursive:true,force:true});
    }
  });

const probe=String.raw`
using BrowserThumbnailPrototype;
using System.Diagnostics;
using System.Drawing;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static class Program
{
    private const BindingFlags PrivateInstance=BindingFlags.Instance|BindingFlags.NonPublic;
    private const uint RequiredFlags=0x0001|0x0002|0x0010|0x0200;
    private static readonly nint Topmost=new(-1),NotTopmost=new(-2);

    [STAThread]
    private static void Main()
    {
        Application.SetHighDpiMode(HighDpiMode.DpiUnaware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        using(var unseen=new Form())
        using(var unseenDock=new TopDockController(unseen))
        {
            Check(!unseen.IsHandleCreated,"The unshown fixture already had a native handle.");
            unseenDock.Reposition();
            Check(!unseen.IsHandleCreated,"Inactive geometry repair created an unshown portal handle.");
        }
        using var portal=new Form
        {
            Text="OneClick isolated portal focus",FormBorderStyle=FormBorderStyle.None,
            StartPosition=FormStartPosition.Manual,AutoScaleMode=AutoScaleMode.None,
            Size=new Size(600,100),ShowInTaskbar=false,
        };
        using var input=new Button { Text="Isolated keyboard target",Location=new Point(15,15),Size=new Size(160,30) };
        portal.Controls.Add(input);
        using var other=new Form
        {
            Text="OneClick isolated foreground window",StartPosition=FormStartPosition.Manual,
            AutoScaleMode=AutoScaleMode.None,Size=new Size(220,100),ShowInTaskbar=false,TopMost=true,
        };
        portal.Show();
        using var dock=new TopDockController(portal);
        dock.Enable();
        StopTimers(dock);
        var work=Screen.FromControl(portal).WorkingArea;
        var anchorX=Cursor.Position.X<work.Left+work.Width/2?work.Right-portal.Width:work.Left;
        SetField(dock,"_anchor",new Point(anchorX,work.Top));
        SetField(dock,"_hoverOpenSuppressed",true);
        dock.Reposition();
        StopTimers(dock);
        var handle=Field<Form>(dock,"_handle");
        var button=Field<Button>(dock,"_button");
        other.Location=new Point(work.Left+20,work.Bottom-other.Height-20);
        other.Show();
        var ownedForegroundObserved=TryActivateOwned(other);
        using var monitor=new PortalPositionMonitor(portal.Handle);

        void Observe(Action operation,bool expectPlacement=true)
        {
            ownedForegroundObserved|=TryActivateOwned(other);
            var foreground=GetForegroundWindow();
            monitor.Begin();
            try { operation(); }
            finally { monitor.End(); }
            // Windows may normalize HWND_TOPMOST to HWND_TOP before delivering
            // WINDOWPOS. Observe the actual z-order operation and required flags.
            var placements=monitor.Positions.Where(position=>(position.Flags&0x0004)==0
                &&(position.Flags&(0x0001|0x0002))==(0x0001|0x0002)).ToArray();
            Check(placements.All(position=>(position.Flags&RequiredFlags)==RequiredFlags),
                "Portal topmost positioning omitted required nonactivating flags: "
                    +string.Join(",",placements.Select(position=>$"0x{position.Flags:X}")));
            if(expectPlacement)Check(placements.Length>0,"The monitor did not observe native portal topmost placement: "
                +string.Join(",",monitor.Positions.Select(position=>$"after={position.InsertAfter},flags=0x{position.Flags:X}")));
            Check(monitor.Positions.All(position=>(position.Flags&0x0010)!=0),
                "Portal geometry positioning omitted SWP_NOACTIVATE.");
            Check(GetForegroundWindow()==foreground,"Portal animation or geometry stole foreground focus.");
        }

        // The old managed value deliberately remains true while the native bit is
        // removed. A plain deletion of the old setter cannot pass this fixture.
        Check(SetWindowPos(portal.Handle,NotTopmost,0,0,0,0,RequiredFlags),"Could not demote the isolated portal.");
        Check(portal.TopMost&&!IsTopmost(portal),"Managed/native topmost divergence was not established.");
        Observe(()=>{
            dock.Reposition();
            Check(IsTopmost(portal),"Portal native topmost state was not restored.");
        });
        Check(portal.TopMost,"Native repair changed the managed topmost preference.");

        Observe(()=>{dock.SetExpanded(true);FinishAnimation(dock);});
        Check(dock.IsExpanded&&Field<double>(dock,"_progress")==1d,"The actual expand animation did not finish.");
        Observe(()=>{dock.SetExpanded(false);FinishAnimation(dock);});
        Check(!dock.IsExpanded&&Field<double>(dock,"_progress")==0d,"The actual collapse animation did not finish.");
        Observe(()=>{portal.Size=new Size(620,105);Application.DoEvents();StopTimers(dock);});
        Observe(()=>{portal.Location=new Point(portal.Left+3,portal.Top);Application.DoEvents();StopTimers(dock);});

        // The ordinary geometry path must leave explicit keyboard activation
        // intact. Only the real keyboard-collapse branch is allowed to hand input
        // from the portal to its visible handle.
        dock.SetExpanded(true);FinishAnimation(dock);
        TryActivateOwned(portal);input.Focus();
        Check(portal.ContainsFocus,"The portal did not own keyboard focus for the explicit-collapse fixture.");
        var keyboardForeground=GetForegroundWindow();
        var key=Message.Create(input.Handle,0x0100,new nint(9),nint.Zero); // WM_KEYDOWN/Tab
        ((IMessageFilter)dock).PreFilterMessage(ref key);
        Check(Field<bool>(dock,"_keyboardInput"),"The actual keyboard message did not establish keyboard input intent.");
        dock.SetExpanded(false);FinishAnimation(dock);
        Check(handle.ContainsFocus&&button.Focused
            &&GetForegroundWindow()==(keyboardForeground==portal.Handle?handle.Handle:keyboardForeground),
            "Explicit keyboard collapse did not leave focus on the visible handle button.");

        // Enable/Disable continue to control the managed preference. The new
        // no-activation path is limited to routine frame repair.
        StopTimers(dock);dock.Disable();
        Check(!portal.TopMost,"Disabling dock mode did not restore the floating preference.");
        dock.Enable();StopTimers(dock);Check(portal.TopMost,"Enabling dock mode did not set managed TopMost.");
        AppPreferences.AlwaysOnTop=true;dock.Disable();
        Check(portal.TopMost,"Disabling dock mode lost the enabled floating topmost preference.");
        AppPreferences.AlwaysOnTop=false;
        // Windows may deny a test process foreground rights. The actual native
        // flag oracle remains mandatory and detects the unsafe setter even then;
        // never turn a denied activation into proof of an owned foreground case.
        Console.WriteLine("OWNED_FOREGROUND_OBSERVED="+ownedForegroundObserved);
        Console.WriteLine("PASS: portal foreground, actual animation, geometry, native topmost, native flags, keyboard focus, uncreated handle, preferences");
    }

    private static bool TryActivateOwned(Form form)
    {
        form.Activate();SetForegroundWindow(form.Handle);
        var timer=Stopwatch.StartNew();
        while(GetForegroundWindow()!=form.Handle&&timer.ElapsedMilliseconds<100)
        {
            Application.DoEvents();Thread.Sleep(5);form.Activate();SetForegroundWindow(form.Handle);
        }
        return GetForegroundWindow()==form.Handle;
    }
    private static void FinishAnimation(TopDockController dock)
    {
        var animation=Field<System.Windows.Forms.Timer>(dock,"_animation");
        var timer=Stopwatch.StartNew();var positions=0;
        while(animation.Enabled&&timer.ElapsedMilliseconds<2000)
        {
            Application.DoEvents();Thread.Sleep(5);positions++;
        }
        Check(!animation.Enabled&&positions>0,"The actual dock animation timer failed to complete.");
        Field<System.Windows.Forms.Timer>(dock,"_hover").Stop();
    }
    private static void Check(bool condition,string message){if(!condition)throw new Exception(message);}
    private static T Field<T>(TopDockController dock,string name)=>(T)typeof(TopDockController).GetField(name,PrivateInstance)!.GetValue(dock)!;
    private static void SetField<T>(TopDockController dock,string name,T value)=>typeof(TopDockController).GetField(name,PrivateInstance)!.SetValue(dock,value);
    private static void StopTimers(TopDockController dock)
    {
        Field<System.Windows.Forms.Timer>(dock,"_animation").Stop();
        Field<System.Windows.Forms.Timer>(dock,"_hover").Stop();
    }
    private static bool IsTopmost(Form form)=>(GetWindowLong(form.Handle,-20).ToInt64()&8)!=0;
    private static nint GetWindowLong(nint handle,int index)=>IntPtr.Size==8?GetWindowLongPtr64(handle,index):new nint(GetWindowLong32(handle,index));
    private sealed class PortalPositionMonitor:NativeWindow,IDisposable
    {
        private bool _watching;
        public List<WindowPosition> Positions {get;}=[];
        public PortalPositionMonitor(nint window)=>AssignHandle(window);
        public void Begin(){Positions.Clear();_watching=true;}
        public void End()=>_watching=false;
        protected override void WndProc(ref Message message)
        {
            if(_watching&&message.Msg==0x0046&&message.LParam!=nint.Zero)
                Positions.Add(Marshal.PtrToStructure<WindowPosition>(message.LParam));
            base.WndProc(ref message);
        }
        public void Dispose()=>ReleaseHandle();
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct WindowPosition
    {
        public nint Window,InsertAfter;
        public int X,Y,Width,Height;
        public uint Flags;
    }
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] private static extern nint GetWindowLongPtr64(nint handle,int index);
    [DllImport("user32.dll",EntryPoint="GetWindowLongW")] private static extern int GetWindowLong32(nint handle,int index);
    [DllImport("user32.dll")] private static extern nint GetForegroundWindow();
    [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)] private static extern bool SetForegroundWindow(nint handle);
    [DllImport("user32.dll")][return:MarshalAs(UnmanagedType.Bool)] private static extern bool SetWindowPos(nint handle,nint after,int x,int y,int width,int height,uint flags);
}
namespace BrowserThumbnailPrototype
{
    internal static class AppPreferences
    {
        public static bool AlwaysOnTop {get;set;}
        public static bool IsAlwaysOnTopEnabled()=>AlwaysOnTop;
    }
    internal static class AppLogger
    {
        public static void Error(string area,string message,Exception error)=>throw new Exception("Unexpected dock persistence.",error);
    }
    internal static class PortalWindowShape
    {
        public static Region CreateForeground(Form portal)=>new(new Rectangle(Point.Empty,portal.Size));
        public static Region Create(Size size,int dpi)=>new(new Rectangle(Point.Empty,size));
    }
}
`;
