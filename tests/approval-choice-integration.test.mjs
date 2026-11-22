import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=name=>readFile(join(root,name),'utf8');

test('the real toolbar button and its badge share the opt-in choice handler without changing the toolbar layout',async()=>{
  const [main,badge,menu]=await Promise.all(['MainForm.cs','MainForm.ApprovalBadge.cs','MainForm.ApprovalMenu.cs'].map(read));
  const build=main.split('private void BuildTaskButtons()')[1].split('private void ConfigureOverviewTaskButtonPanel(')[0];
  assert.match(build,/task\.Kind == PortalTaskKind\.Approval/);
  assert.match(build,/RequestApprovalActionAsync\(\)/);
  assert.match(build,/else[\s\S]*RunWorkflowAsync\(task\.Kind\)/);
  assert.match(badge,/_approvalBadge\.Click \+= \(_, _\) => _approvalButton\?\.PerformClick\(\)/);
  assert.match(menu,/AppPreferences\.IsNiceApprovalMenuEnabled\(\)/);
  assert.match(menu,/RunWorkflowAsync\(PortalTaskKind\.Approval\)/);
  assert.match(main,/private const int WidgetWidth = 832;/);
  assert.match(main,/private const int WidgetHeight = 40;/);
  assert.match(main,/private const int FloatingWidgetWidth = 590;/);
  assert.match(main,/private const int FloatingWidgetHeight = 66;/);
  assert.match(main,/new\[\] \{ 30, 251, 8, 163, 3, 163, 102, 32, 32, 32 \}/);
  const ctor=main.split('internal MainForm(')[1].split('private void InitializeTray()')[0];
  assert.match(ctor,/InitializeApprovalMenu\(\)/);
  const dispose=main.split('protected override void Dispose(bool disposing)')[1].split('private void OnWindowsSessionSwitch(')[0];
  assert.match(dispose,/DisposeApprovalMenu\(\)/);
});

test('count display is cleared through the production monitor and connection lifecycle instead of using expired data',async()=>{
  const [main,monitor]=await Promise.all(['MainForm.cs','MainForm.NiceApprovals.cs'].map(read));
  const stop=monitor.split('private void StopNiceApprovalMonitoring()')[1].split('private void CancelNiceApprovalReadForExpiredSession()')[0];
  const expiry=monitor.split('private void CancelNiceApprovalReadForExpiredSession()')[1].split('private void SetNiceApprovalStatus(')[0];
  assert.match(stop,/SetNiceApprovalMenuCount\(null\)/);
  assert.match(expiry,/SetNiceApprovalMenuCount\(null\)/);
  const apply=monitor.split('private void ApplyNiceApprovalResult(')[1];
  assert.match(apply,/SetNiceApprovalMenuCount\(count\)/);
  assert.match(apply,/SetNiceApprovalMenuCount\(null\)/);
  const disconnect=main.split('private void DisconnectBrowser()')[1].split('private void CheckSourceWindow()')[0];
  assert.match(disconnect,/CloseApprovalMenu\(\)/);
  assert.match(disconnect,/StopNiceApprovalMonitoring\(\)/);
});

test('the actual settings save handler commits menu opt-in only after OK and always restores dock and preview resources',
  {timeout:120000},async()=>{
    const main=await read('MainForm.cs');
    const handler=main.slice(main.indexOf('    private void OpenSettings()'),main.indexOf('    private void ApplyWindowOpacity()'));
    assert.ok(handler.includes('AppPreferences.IsNiceApprovalMenuEnabled()'));
    assert.ok(handler.indexOf('dialog.ShowDialog(this) != DialogResult.OK')<handler.indexOf('AppPreferences.SetNiceApprovalMenuEnabled('));
    const directory=await mkdtemp(join(tmpdir(),'oneclick-approval-choice-integration-'));
    try{
      await writeFile(join(directory,'Probe.csproj'),`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>`);
      await writeFile(join(directory,'Program.cs'),probe.replace('/* PRODUCTION_SETTINGS_HANDLER */',handler));
      const result=await promisify(execFile)('dotnet',['run','--project',join(directory,'Probe.csproj'),'--configuration','Release','--nologo'],
        {timeout:100000,maxBuffer:1024*1024}).catch(error=>{throw new Error(`${error.stdout??''}\n${error.stderr??''}`);});
      assert.match(result.stdout,/PASS: settings cancel, explicit opt-in, stored initial value, explicit opt-out, save failure, dock pause and preview cleanup/);
    }finally{
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-approval-choice-integration-'));
      await rm(directory,{recursive:true,force:true});
    }
  });

const probe=String.raw`
using BrowserThumbnailPrototype;
void Check(bool condition,string message){if(!condition)throw new Exception(message);}
AppPreferences.Reset();
SettingsForm.NextResult=DialogResult.Cancel;SettingsForm.NextMenu=true;
var canceled=new MainForm();canceled.Open();
Check(!AppPreferences.Menu&&AppPreferences.Writes.Count==0,"Cancel persisted a setting.");
Check(!SettingsForm.LastInitialMenu&&canceled.Dock.Pauses==0&&!canceled.Dock.IsExpanded
  &&canceled.Background.Opacity==AppPreferences.GetWindowOpacityPercent()&&SettingsForm.Disposals==1
  &&canceled.MenuCloses==1&&!canceled.PresentationEnabled,"Cancel leaked UI resources.");
SettingsForm.NextResult=DialogResult.OK;SettingsForm.NextMenu=true;
var enabled=new MainForm();enabled.Open();
Check(AppPreferences.Menu&&AppPreferences.Writes.Contains("menu:True")&&enabled.PresentationEnabled
  &&enabled.TimerUpdates==1,"OK did not commit and apply explicit opt-in.");
Check(enabled.Dock.Pauses==0&&!enabled.Dock.IsExpanded,"Saving leaked the dock pause.");
AppPreferences.Writes.Clear();SettingsForm.NextResult=DialogResult.Cancel;SettingsForm.NextMenu=false;
var cancelDisable=new MainForm();cancelDisable.Open();
Check(SettingsForm.LastInitialMenu&&AppPreferences.Menu&&AppPreferences.Writes.Count==0,"Opening did not load the saved opt-in or cancel changed it.");
SettingsForm.NextResult=DialogResult.OK;SettingsForm.NextMenu=false;
var disabled=new MainForm();disabled.Open();
Check(!AppPreferences.Menu&&!disabled.PresentationEnabled&&AppPreferences.Writes.Contains("menu:False"),"Explicit opt-out was not applied.");
Check(!AppPreferences.Writes.Contains("startup")&&!AppPreferences.Writes.Contains("display"),
  "Saving an unrelated option rewrote the startup command or the stored display mode.");
AppPreferences.Writes.Clear();SettingsForm.NextStartup=true;SettingsForm.NextDisplay=PortalDisplayMode.FloatingWindow;
var explicitChanges=new MainForm();explicitChanges.Open();
Check(AppPreferences.Writes.Count(value=>value=="startup")==1&&AppPreferences.Writes.Count(value=>value=="display")==1
  &&AppPreferences.Startup,"An explicit startup or display change was not persisted exactly once.");
SettingsForm.NextStartup=false;SettingsForm.NextDisplay=PortalDisplayMode.TopDock;AppPreferences.Startup=false;
AppPreferences.ThrowMenuSave=true;SettingsForm.NextMenu=true;
var failed=new MainForm();failed.Open();
Check(!AppPreferences.Menu&&MessageBox.Shows==1&&failed.Dock.Pauses==0&&!failed.Dock.IsExpanded
  &&failed.Background.Opacity==AppPreferences.GetWindowOpacityPercent(),"Failed save leaked an opt-in or UI resources.");
Check(SettingsForm.Disposals==6,"Settings dialogs were not disposed exactly once.");
Console.WriteLine("PASS: settings cancel, explicit opt-in, stored initial value, explicit opt-out, save failure, dock pause and preview cleanup");

namespace BrowserThumbnailPrototype{
 internal enum PortalDisplayMode{TopDock,FloatingWindow}
 internal enum PortalBrowser{Edge,Chrome}
 internal enum DialogResult{Cancel,OK}
 internal enum MessageBoxButtons{OK}
 internal enum MessageBoxIcon{Warning}
 internal static class MessageBox{internal static int Shows;internal static void Show(object owner,string message,string title,MessageBoxButtons buttons,MessageBoxIcon icon)=>Shows++;}
 internal static class AppLogger{internal static void Info(string area,string message){}internal static void Error(string area,string message,Exception exception){}}
 internal static class AppPreferences{
  internal static bool Menu,ThrowMenuSave,Startup;internal static List<string> Writes=[];private static string office="TEST";
  internal static void Reset(){Menu=false;ThrowMenuSave=false;Startup=false;Writes.Clear();}
  public static bool IsNiceApprovalMenuEnabled()=>Menu;
  public static void SetNiceApprovalMenuEnabled(bool value){if(ThrowMenuSave)throw new IOException("test");Menu=value;Writes.Add("menu:"+value);}
  public static bool IsWindowsStartupEnabled()=>Startup;public static bool IsPortalAutoRefreshEnabled()=>true;
  public static bool IsUsageTelemetryEnabled()=>false;public static bool IsAlwaysOnTopEnabled()=>false;
  public static string GetEducationOfficeCode()=>office;public static int GetWindowOpacityPercent()=>80;
  public static PortalBrowser GetLoginBrowser()=>PortalBrowser.Edge;
  public static void SetEducationOfficeCode(string value){office=value;Writes.Add("office");}
  public static void SetWindowsStartupEnabled(bool value){Startup=value;Writes.Add("startup");}
  public static void SetPortalAutoRefreshEnabled(bool value)=>Writes.Add("refresh");
  public static void SetUsageTelemetryEnabled(bool value)=>Writes.Add("telemetry");
  public static void SetAlwaysOnTopEnabled(bool value)=>Writes.Add("topmost");
  public static void SetWindowOpacityPercent(int value)=>Writes.Add("opacity");
  public static void SetDisplayMode(PortalDisplayMode value)=>Writes.Add("display");
  public static void SetLoginBrowser(PortalBrowser value)=>Writes.Add("browser");
 }
 internal sealed class SettingsForm:IDisposable{
  internal static DialogResult NextResult;internal static bool NextMenu,LastInitialMenu,NextStartup;internal static int Disposals;
  internal static PortalDisplayMode NextDisplay=PortalDisplayMode.TopDock;
  public SettingsForm(bool startup,bool refresh,bool telemetry,bool top,string office,int opacity,PortalDisplayMode display,
    PortalBrowser browser=PortalBrowser.Edge,bool niceApprovalMenuEnabled=false){LastInitialMenu=niceApprovalMenuEnabled;NiceApprovalMenuEnabled=niceApprovalMenuEnabled;}
  public event EventHandler? WindowOpacityPreviewChanged;
  public bool NiceApprovalMenuEnabled{get;private set;}public bool WindowsStartupEnabled=>NextStartup;
  public bool PortalAutoRefreshEnabled=>true;public bool UsageTelemetryEnabled=>false;public bool AlwaysOnTopEnabled=>false;
  public string EducationOfficeCode=>"TEST";public int WindowOpacityPercent=>60;
  public PortalDisplayMode DisplayMode=>NextDisplay;public PortalBrowser LoginBrowser=>PortalBrowser.Edge;
  public DialogResult ShowDialog(object owner){NiceApprovalMenuEnabled=NextMenu;WindowOpacityPreviewChanged?.Invoke(this,EventArgs.Empty);return NextResult;}
  public void Dispose()=>Disposals++;
 }
 internal sealed class FakeBackground{internal int Opacity;internal void SetOpacityPercent(int value)=>Opacity=value;}
 internal sealed class FakeDock{
  public bool Enabled=>true;public bool IsExpanded{get;private set;}internal int Pauses;
  public void SetExpanded(bool value)=>IsExpanded=value;
  public IDisposable SuspendAutoHide(){Pauses++;return new Pause(this);}
  private sealed class Pause(FakeDock owner):IDisposable{private bool disposed;public void Dispose(){if(!disposed){owner.Pauses--;disposed=true;}}}
 }
 public sealed class MainForm{
  private readonly FakeDock _topDock=new();private readonly FakeBackground _background=new();
  private PortalDisplayMode _displayMode=PortalDisplayMode.TopDock;private IntPtr _sourceWindow=IntPtr.Zero;
  internal FakeDock Dock=>_topDock;internal FakeBackground Background=>_background;
  internal bool TopMost;internal bool PresentationEnabled;internal int TimerUpdates,MenuCloses;
  internal void Open()=>OpenSettings();
  private void ApplyWindowOpacity()=>_background.SetOpacityPercent(AppPreferences.GetWindowOpacityPercent());
  private void ApplyDisplayMode(PortalDisplayMode value)=>_displayMode=value;
  private void UpdateAutoRefreshTimer()=>TimerUpdates++;
  private void DisconnectBrowser(){}
  private void SetStatus(string value){}
  private void CloseApprovalMenu()=>MenuCloses++;
  private void RefreshApprovalActionPresentation()=>PresentationEnabled=AppPreferences.IsNiceApprovalMenuEnabled();
  /* PRODUCTION_SETTINGS_HANDLER */
 }
}
`;
