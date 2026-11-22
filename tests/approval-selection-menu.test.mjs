import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {execFile} from 'node:child_process';

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const xml = text => text.replaceAll('&','&amp;').replaceAll('"','&quot;');

test('actual WinForms approval menu preserves default routing, explicit selection, badge presentation and popup lifetime',
  {timeout:120000}, async () => {
    const directory = await mkdtemp(join(tmpdir(),'oneclick-approval-selection-'));
    try {
      const badge = await readFile(join(root,'MainForm.ApprovalBadge.cs'),'utf8');
      const setter = badge.slice(badge.indexOf('    private void SetApprovalBadge('),badge.indexOf('    private void InitializeApprovalBadge()'));
      const initializer = badge.slice(badge.indexOf('    private void InitializeApprovalBadge()'),badge.indexOf('    private void PositionApprovalBadge()'));
      assert.ok(setter.includes('RefreshApprovalActionPresentation()'));
      const project = join(directory,'Probe.csproj');
      await writeFile(project,`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup>${[
        'MainForm.ApprovalMenu.cs','TaskCountBadge.cs','GlassTaskButton.cs',
      ].map(name=>`<Compile Include="${xml(resolve(root,name))}" Link="${name}" />`).join('')}</ItemGroup></Project>`);
      await writeFile(join(directory,'Program.cs'),probe.replace('/* BADGE_SETTER */',setter).replace('/* BADGE_INITIALIZER */',initializer));
      const result = await run('dotnet',['run','--project',project,'--configuration','Release','--nologo'],
        {timeout:100000,maxBuffer:1024*1024});
      assert.match(result.stdout,/PASS: default direct, explicit choices, live counts, stale counts, badge, guards, bounds, pause, toggle, settings and disposal/);
    } finally {
      assert.equal(dirname(resolve(directory)),resolve(tmpdir()));
      assert.ok(basename(directory).startsWith('oneclick-approval-selection-'));
      await rm(directory,{recursive:true,force:true});
    }
  });

const probe = String.raw`
using System.Reflection;
using BrowserThumbnailPrototype;

internal static class Program
{
    private static void Check(bool condition,string message) {if(!condition)throw new Exception(message);}
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        AppPreferences.Choose = false;
        using var f = new MainForm();
        f.Show();
        f.SetEdufine(3,"TEST EXISTING DESCRIPTION");
        Check(f.Button.AccessibleName == "결재 · 결재대기 3건", "Default accessible name changed.");
        Check(f.Tip == "TEST EXISTING DESCRIPTION\n클릭하면 결재대기 목록을 엽니다.", "Default tooltip changed.");
        var width = f.Button.Width;
        f.Request().GetAwaiter().GetResult();
        Check(f.Routes.SequenceEqual(new[]{PortalTaskKind.Approval}),"Default button did not directly route to Edufine.");
        Check(f.Menu is null && f.Pauses == 0,"Default button created a popup or pause.");
        f.Routes.Clear();
        AppPreferences.Choose = true;
        f.Refresh();
        Check(f.Button.AccessibleName == "결재 · 에듀파인 또는 나이스 선택" && f.Button.Width == width,
            "Choice setting changed width or did not update accessibility.");
        f.SetNice(7);
        f.Request().GetAwaiter().GetResult();
        Check(f.Menu is {Visible:true} && f.Pauses == 1 && f.Routes.Count == 0,
            "Choice button navigated before selection or did not hold auto-hide.");
        Check(f.Menu!.Items.Count == 2 && !f.Menu!.ShowImageMargin && !f.Menu!.ShowCheckMargin,
            "Choice popup has extra controls.");
        Check(f.Menu!.Items[0].Text == "에듀파인 결재대기 [3건]" && f.Menu!.Items[1].Text == "나이스 결재대기 [7건]",
            "Fresh system counts missing.");
        var area = Screen.FromControl(f.Button).WorkingArea;
        Check(area.Contains(f.Menu!.Bounds),"Popup went outside the monitor working area.");
        ((ToolStripMenuItem)f.Menu!.Items[1]).PerformClick();
        Check(f.Routes.SequenceEqual(new[]{PortalTaskKind.NiceApproval}) && !f.Menu!.Visible && f.Pauses == 0,
            "Nice selection did not route once and release pause.");
        f.Routes.Clear();
        f.Request().GetAwaiter().GetResult();
        ((ToolStripMenuItem)f.Menu!.Items[0]).PerformClick();
        Check(f.Routes.SequenceEqual(new[]{PortalTaskKind.Approval}) && f.Pauses == 0,"Edufine selection route failed.");
        f.Routes.Clear();
        f.Request().GetAwaiter().GetResult();
        f.SetEdufine(9,"UPDATED MONITOR DESCRIPTION");
        f.SetNice(11);
        Check(f.Button.AccessibleName.Contains("또는 나이스 선택") && f.Tip.Contains("또는 나이스"),
            "A polling update overwrote choice presentation.");
        Check(f.Menu!.Items[0].Text.EndsWith("[9건]") && f.Menu!.Items[1].Text.EndsWith("[11건]"),
            "Open menu counts did not update.");
        f.StaleCounts(); f.Refresh();
        Check(f.Menu!.Items[0].Text == "에듀파인 결재대기" && f.Menu!.Items[1].Text == "나이스 결재대기",
            "Stale counts were presented as current.");
        f.SetEdufine(0,"ZERO"); f.SetNice(0);
        Check(f.Menu!.Items[0].Text.EndsWith("[0건]") && f.Menu!.Items[1].Text.EndsWith("[0건]"),"Real zero became unknown.");
        f.Expired.Add("K-에듀파인");f.Refresh();
        Check(f.Menu!.Items[0].Text == "에듀파인 결재대기" && f.Menu!.Items[1].Text.EndsWith("[0건]")
            && f.Menu!.Items.Cast<ToolStripMenuItem>().All(i=>i.Enabled),"One expired system blocked the other choice.");
        f.CloseMenu();Check(f.Pauses == 0,"Explicit close did not release pause.");
        f.Request().GetAwaiter().GetResult();
        f.Request().GetAwaiter().GetResult();
        Check(!f.Menu!.Visible && f.Pauses == 0 && f.Routes.Count == 0,"Second click did not collapse the menu.");
        f.Request().GetAwaiter().GetResult();
        f.Menu!.Close(ToolStripDropDownCloseReason.Keyboard);
        Check(f.Pauses == 0,"Escape-style close retained auto-hide pause.");
        f.Request().GetAwaiter().GetResult();
        f.Location = new Point(f.Left+1,f.Top);
        Check(!f.Menu!.Visible && f.Pauses == 0,"Moving owner did not close the popup.");
        f.Request().GetAwaiter().GetResult();
        f.Hide();
        Check(!f.Menu!.Visible && f.Pauses == 0,"Hiding owner did not close the popup.");
        f.Show();
        f.Request().GetAwaiter().GetResult();
        AppPreferences.Choose = false;f.Refresh();
        Check(!f.Menu!.Visible && f.Pauses == 0 && f.Tip == "ZERO\n클릭하면 결재대기 목록을 엽니다.",
            "Disabling selection did not close popup or restore normal presentation.");
        AppPreferences.Choose = true; f.Refresh();
        f.ClickBadge();
        Check(f.Menu!.Visible && f.Routes.Count == 0,"Badge did not use the same explicit choice path.");
        f.CloseMenu();
        foreach(var guard in new[]{"disconnected","workflow","disabled","closing"})
        {
            f.Guard(guard,true);f.Request().GetAwaiter().GetResult();
            Check(!f.Menu!.Visible && f.Pauses == 0 && f.Routes.Count == 0,"Guard did not prevent opening: "+guard);
            f.Guard(guard,false);
        }
        f.Request().GetAwaiter().GetResult();f.Guard("workflow",true);
        ((ToolStripMenuItem)f.Menu!.Items[1]).PerformClick();
        Check(f.Routes.Count == 0 && f.Pauses == 0,"A stale menu selection bypassed the workflow guard.");
        f.Guard("workflow",false);
        f.Request().GetAwaiter().GetResult();f.DisposeMenu();f.DisposeMenu();
        Check(f.Menu is null && f.Pauses == 0,"Disposal did not clean the popup or was not idempotent.");
        f.Request().GetAwaiter().GetResult();Check(f.Routes.Count == 0,"Disposed menu accepted another request.");
        Console.WriteLine("PASS: default direct, explicit choices, live counts, stale counts, badge, guards, bounds, pause, toggle, settings and disposal");
    }
}

namespace BrowserThumbnailPrototype
{
    internal enum PortalTaskKind {Approval,NiceApproval}
    internal static class AppPreferences {public static bool Choose;public static bool IsNiceApprovalMenuEnabled()=>Choose;}
    internal sealed class DockPauseProbe
    {
        public int Pauses;
        public IDisposable SuspendAutoHide(){Pauses++;return new Scope(this);}
        private sealed class Scope(DockPauseProbe owner):IDisposable
        {
            private bool disposed;
            public void Dispose(){if(!disposed){disposed=true;owner.Pauses--;}}
        }
    }
    public sealed partial class MainForm:Form
    {
        private bool connected=true;
        private bool _isClosing;
        private bool _workflowRunning;
        private readonly GlassTaskButton? _approvalButton=new(){Text="결재",Width=47,Height=24,Left=5,Top=5};
        private readonly TaskCountBadge _approvalBadge=new();
        private DateTimeOffset? _approvalBadgeReadAt;
        private readonly ToolTip _statusTip=new();
        private readonly Panel _rootLayout=new(),_overviewTaskButtonPanel=new();
        private readonly HashSet<string> _confirmedExpiredSystems=[];
        private readonly DockPauseProbe? _topDock=new();
        internal readonly List<PortalTaskKind> Routes=[];
        public MainForm()
        {
            ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;Location=new Point(-30000,-30000);Size=new Size(100,60);
            Controls.Add(_approvalButton!);
            _approvalButton!.Click+=async(_,_)=>await RequestApprovalActionAsync();
            InitializeApprovalMenu();InitializeApprovalBadge();
        }
        protected override bool ShowWithoutActivation=>true;
        private bool IsBrowserConnected()=>connected;
        private Task RunWorkflowAsync(PortalTaskKind kind){Routes.Add(kind);return Task.CompletedTask;}
        private void PositionApprovalBadge(){}
        private void RefreshNotificationSourceStatus(){}
        /* BADGE_SETTER */
        /* BADGE_INITIALIZER */
        internal GlassTaskButton Button=>_approvalButton!;
        internal ContextMenuStrip? Menu=>_approvalChoiceMenu;
        internal int Pauses=>_topDock!.Pauses;
        internal string Tip=>_statusTip.GetToolTip(_approvalButton!) ?? string.Empty;
        internal HashSet<string> Expired=>_confirmedExpiredSystems;
        internal Task Request()=>RequestApprovalActionAsync();
        internal new void Refresh()=>RefreshApprovalActionPresentation();
        internal void SetEdufine(int? count,string description)=>SetApprovalBadge(count,description);
        internal void SetNice(int? count)=>SetNiceApprovalMenuCount(count);
        internal void CloseMenu()=>CloseApprovalMenu();
        internal void DisposeMenu()=>DisposeApprovalMenu();
        internal void StaleCounts(){_approvalBadgeReadAt=DateTimeOffset.UtcNow.AddMinutes(-3);_niceApprovalMenuReadAt=_approvalBadgeReadAt;}
        internal void ClickBadge()=>typeof(Control).GetMethod("OnClick",BindingFlags.Instance|BindingFlags.NonPublic)!.Invoke(_approvalBadge,[EventArgs.Empty]);
        internal void Guard(string name,bool value)
        {
            if(name=="disconnected")connected=!value;
            else if(name=="workflow")_workflowRunning=value;
            else if(name=="disabled")_approvalButton!.Enabled=!value;
            else if(name=="closing")_isClosing=value;
        }
    }
}
`;
