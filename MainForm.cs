using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;

namespace BrowserThumbnailPrototype;

public sealed class MainForm : Form
{
    private const int WidgetWidth = 550;
    private const int WidgetHeight = 66;

    private readonly TableLayoutPanel _rootLayout = new();
    private readonly Label _brandLabel = new();
    private readonly ComboBox _browserWindows = new();
    private readonly Label _statusLabel = new();
    private readonly FlowLayoutPanel _topTaskButtonPanel = new();
    private readonly FlowLayoutPanel _bottomTaskButtonPanel = new();
    private readonly Button _refreshButton = new();
    private readonly Button _launchBrowserButton = new();
    private readonly Button _connectButton = new();
    private readonly Button _settingsButton = new();
    private readonly Button _closeButton = new();
    private readonly List<Button> _taskButtons = new();
    private readonly System.Windows.Forms.Timer _healthTimer = new() { Interval = 1000 };
    private readonly System.Windows.Forms.Timer _portalSessionTimer = new() { Interval = 60 * 1000 };
    private readonly SemaphoreSlim _portalOperationGate = new(1, 1);

    private IntPtr _sourceWindow;
    private bool _workflowRunning;
    private bool _portalSessionCheckRunning;
    private bool _applyingWindowShape;
    private bool _isClosing;
    private string? _connectedProcessName;
    private int? _devToolsPort;
    private CancellationTokenSource? _workflowCancellationSource;
    private CancellationTokenSource? _sessionCheckCancellationSource;
    private int _sourceExtendedStyle;
    private bool _sourceTransparent;

    public MainForm()
    {
        Text = "원클릭 업무포털";
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        TopMost = AppPreferences.IsAlwaysOnTopEnabled();
        MinimumSize = new Size(540, WidgetHeight);
        Size = new Size(WidgetWidth, WidgetHeight);
        ShowInTaskbar = true;
        BackColor = Color.White;
        ForeColor = Color.FromArgb(34, 40, 50);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("맑은 고딕", 9F);

        BuildUi();
        ApplyWindowOpacity();
        AppLogger.Info("Application", "프로그램 시작");

        Shown += (_, _) =>
        {
            PositionAtSavedLocationOrBottomRight();
            RefreshBrowserWindows();
        };
        LocationChanged += (_, _) =>
        {
            if (Visible)
            {
                try
                {
                    AppPreferences.SetWindowLocation(Location);
                }
                catch (Exception exception)
                {
                    AppLogger.Error("Preferences", "프로그램 위치 저장 실패", exception);
                }
            }
        };
        FormClosed += (_, _) =>
        {
            AppLogger.Info("Application", "프로그램 종료");
            DisconnectBrowser();
        };
        FormClosing += (_, _) =>
        {
            _isClosing = true;
            _healthTimer.Stop();
            _portalSessionTimer.Stop();
            _workflowCancellationSource?.Cancel();
            _sessionCheckCancellationSource?.Cancel();
        };
        _healthTimer.Tick += (_, _) => CheckSourceWindow();
        _healthTimer.Start();
        _portalSessionTimer.Tick += async (_, _) => await CheckPortalSessionsInBackgroundAsync();
    }

    private void BuildUi()
    {
        _rootLayout.Dock = DockStyle.Fill;
        _rootLayout.ColumnCount = 1;
        _rootLayout.RowCount = 2;
        _rootLayout.Padding = new Padding(8, 4, 8, 4);
        _rootLayout.BackColor = Color.White;
        _rootLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        _rootLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 50));
        Controls.Add(_rootLayout);

        var topRow = CreateTopRow();
        var bottomRow = CreateBottomRow();

        _brandLabel.Text = "원클릭업무포털";
        _brandLabel.Font = new Font(Font, FontStyle.Bold);
        _brandLabel.ForeColor = Color.FromArgb(42, 106, 190);
        _brandLabel.AutoSize = false;
        _brandLabel.Width = 102;
        _brandLabel.Height = 28;
        _brandLabel.TextAlign = ContentAlignment.MiddleLeft;
        _brandLabel.Margin = new Padding(0);
        _brandLabel.Dock = DockStyle.Fill;
        topRow.Controls.Add(_brandLabel, 0, 0);

        _statusLabel.AutoSize = false;
        _statusLabel.Width = 158;
        _statusLabel.Height = 28;
        _statusLabel.AutoEllipsis = true;
        _statusLabel.ForeColor = Color.FromArgb(92, 102, 116);
        _statusLabel.TextAlign = ContentAlignment.MiddleLeft;
        _statusLabel.Margin = new Padding(0);
        _statusLabel.Dock = DockStyle.Fill;
        topRow.Controls.Add(_statusLabel, 1, 0);

        topRow.Controls.Add(CreateSeparator(), 2, 0);

        BuildTaskButtons();
        topRow.Controls.Add(_topTaskButtonPanel, 3, 0);

        StyleButton(_settingsButton, "⚙", 30, Color.FromArgb(241, 244, 248), Color.FromArgb(74, 84, 100));
        _settingsButton.Font = new Font("Segoe UI Symbol", 12F, FontStyle.Regular);
        _settingsButton.AccessibleName = "설정";
        _settingsButton.Click += (_, _) => OpenSettings();
        topRow.Controls.Add(_settingsButton, 4, 0);

        _browserWindows.DropDownStyle = ComboBoxStyle.DropDownList;
        _browserWindows.Width = 92;
        _browserWindows.DropDownWidth = 360;
        _browserWindows.Height = 28;
        _browserWindows.BackColor = Color.FromArgb(248, 249, 251);
        _browserWindows.ForeColor = Color.FromArgb(45, 52, 64);
        _browserWindows.Margin = new Padding(0, 0, 4, 0);
        var connectionControls = new FlowLayoutPanel
        {
            AutoSize = true,
            WrapContents = false,
            FlowDirection = FlowDirection.LeftToRight,
            Height = 28,
            Margin = new Padding(0),
            Padding = new Padding(0),
        };
        connectionControls.Controls.Add(_browserWindows);

        StyleButton(_refreshButton, "↻", 28, Color.FromArgb(241, 244, 248), Color.FromArgb(74, 84, 100));
        _refreshButton.AccessibleName = "브라우저 창 새로고침";
        _refreshButton.Click += (_, _) => RefreshBrowserWindows();
        connectionControls.Controls.Add(_refreshButton);

        StyleButton(_launchBrowserButton, "로그인", 54, Color.FromArgb(49, 124, 213), Color.White);
        _launchBrowserButton.Click += async (_, _) => await LaunchControlledEdgeAsync();
        connectionControls.Controls.Add(_launchBrowserButton);

        StyleButton(_connectButton, "연결", 76, Color.FromArgb(45, 162, 126), Color.White);
        _connectButton.AccessibleName = "브라우저 연결";
        _connectButton.Click += async (_, _) =>
        {
            if (_sourceWindow != IntPtr.Zero)
            {
                DisconnectBrowser();
                RefreshBrowserWindows();
                return;
            }

            await ConnectSelectedBrowserAsync();
        };
        connectionControls.Controls.Add(_connectButton);

        bottomRow.Controls.Add(connectionControls, 0, 0);

        bottomRow.Controls.Add(CreateSeparator(), 1, 0);
        bottomRow.Controls.Add(_bottomTaskButtonPanel, 2, 0);

        StyleButton(_closeButton, "X", 30, Color.FromArgb(255, 239, 241), Color.FromArgb(160, 70, 82));
        _closeButton.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
        _closeButton.AccessibleName = "닫기";
        _closeButton.Click += (_, _) => Close();
        bottomRow.Controls.Add(_closeButton, 3, 0);

        _rootLayout.Controls.Add(topRow, 0, 0);
        _rootLayout.Controls.Add(bottomRow, 0, 1);

        EnableDragging(_rootLayout);

        UpdateConnectionControls();
        SetConnectionStatus("연결 안 됨");
    }

    private void BuildTaskButtons()
    {
        ConfigureTaskButtonPanel(_topTaskButtonPanel);
        ConfigureTaskButtonPanel(_bottomTaskButtonPanel);

        var tasks = new[]
        {
            (Name: "나이스", Kind: PortalTaskKind.NiceHome),
            (Name: "복무", Kind: PortalTaskKind.Leave),
            (Name: "출장", Kind: PortalTaskKind.BusinessTrip),
            (Name: "에듀파인", Kind: PortalTaskKind.EdufineHome),
            (Name: "기안", Kind: PortalTaskKind.Draft),
            (Name: "품의", Kind: PortalTaskKind.PurchaseRequest),
        };
        for (var index = 0; index < tasks.Length; index++)
        {
            var task = tasks[index];
            var button = new Button
            {
                Text = task.Name,
            };
            StyleButton(button, task.Name, 72, Color.FromArgb(241, 244, 248), Color.FromArgb(45, 52, 64));
            button.Click += async (_, _) => await RunWorkflowAsync(task.Kind);
            _taskButtons.Add(button);
            (index < 3 ? _topTaskButtonPanel : _bottomTaskButtonPanel).Controls.Add(button);
        }
    }

    private static void ConfigureTaskButtonPanel(FlowLayoutPanel panel)
    {
        panel.FlowDirection = FlowDirection.LeftToRight;
        panel.WrapContents = false;
        panel.AutoSize = true;
        panel.Height = 28;
        panel.Margin = new Padding(0);
        panel.Padding = new Padding(0);
    }

    private static TableLayoutPanel CreateTopRow()
    {
        var row = new TableLayoutPanel
        {
            AutoSize = false,
            Dock = DockStyle.Fill,
            ColumnCount = 5,
            RowCount = 1,
            Margin = new Padding(0),
            Padding = new Padding(0),
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 102));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 7));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 32));
        row.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        return row;
    }

    private static TableLayoutPanel CreateBottomRow()
    {
        var row = new TableLayoutPanel
        {
            AutoSize = false,
            Dock = DockStyle.Fill,
            ColumnCount = 4,
            RowCount = 1,
            Margin = new Padding(0),
            Padding = new Padding(0),
        };
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 7));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        row.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 32));
        row.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        return row;
    }

    private static void StyleButton(Button button, string text, int width, Color backColor, Color foreColor)
    {
        button.Text = text;
        button.Width = width;
        button.Height = 28;
        button.Margin = new Padding(1, 0, 1, 0);
        button.Padding = new Padding(0);
        button.Font = new Font("맑은 고딕", 9F, FontStyle.Regular);
        button.ForeColor = foreColor;
        button.BackColor = backColor;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = Color.FromArgb(220, 225, 232);
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(228, 238, 251);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(215, 229, 247);
        button.UseVisualStyleBackColor = false;
    }

    private static Panel CreateSeparator()
    {
        return new Panel
        {
            Width = 1,
            Height = 28,
            BackColor = Color.FromArgb(224, 228, 235),
            Margin = new Padding(3, 0, 3, 0),
        };
    }

    private void EnableDragging(Control root)
    {
        if (root is not Button and not ComboBox and not CheckBox and not TrackBar)
        {
            root.MouseDown += (_, eventArgs) =>
            {
                if (eventArgs.Button != MouseButtons.Left)
                {
                    return;
                }

                NativeMethods.ReleaseCapture();
                NativeMethods.SendMessage(Handle, NativeMethods.WM_NCLBUTTONDOWN, NativeMethods.HTCAPTION, IntPtr.Zero);
            };
        }

        foreach (Control child in root.Controls)
        {
            EnableDragging(child);
        }
    }

    private void OpenSettings()
    {
        using var dialog = new SettingsForm(
            AppPreferences.IsWindowsStartupEnabled(),
            AppPreferences.IsPortalAutoRefreshEnabled(),
            AppPreferences.IsUsageTelemetryEnabled(),
            AppPreferences.IsAlwaysOnTopEnabled(),
            AppPreferences.GetEducationOfficeCode(),
            AppPreferences.GetWindowOpacityPercent());
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        try
        {
            var previousEducationOfficeCode = AppPreferences.GetEducationOfficeCode();
            var educationOfficeChanged = !string.Equals(
                previousEducationOfficeCode,
                dialog.EducationOfficeCode,
                StringComparison.OrdinalIgnoreCase);
            AppPreferences.SetEducationOfficeCode(dialog.EducationOfficeCode);
            var savedEducationOfficeCode = AppPreferences.GetEducationOfficeCode();
            if (!string.Equals(savedEducationOfficeCode, dialog.EducationOfficeCode, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("소속 교육청 설정이 올바르게 저장되지 않았습니다.");
            }

            AppPreferences.SetWindowsStartupEnabled(dialog.WindowsStartupEnabled);
            AppPreferences.SetPortalAutoRefreshEnabled(dialog.PortalAutoRefreshEnabled);
            AppPreferences.SetUsageTelemetryEnabled(dialog.UsageTelemetryEnabled);
            AppPreferences.SetAlwaysOnTopEnabled(dialog.AlwaysOnTopEnabled);
            AppPreferences.SetWindowOpacityPercent(dialog.WindowOpacityPercent);
            ApplyWindowOpacity();
            TopMost = dialog.AlwaysOnTopEnabled;
            UpdateAutoRefreshTimer();
            if (educationOfficeChanged && _sourceWindow != IntPtr.Zero)
            {
                DisconnectBrowser();
                SetStatus("교육청이 변경되었습니다. 새 로그인 창을 열어 주세요.");
            }
            else
            {
                SetStatus("설정을 저장했습니다.");
            }
            AppLogger.Info("Preferences", $"설정을 저장했습니다. 교육청={savedEducationOfficeCode}");
        }
        catch (Exception exception)
        {
            AppLogger.Error("Preferences", "설정 저장 실패", exception);
            MessageBox.Show(this, exception.Message, "설정 저장 실패", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void ApplyWindowOpacity()
    {
        Opacity = AppPreferences.GetWindowOpacityPercent() / 100d;
    }

    private void UpdateAutoRefreshTimer()
    {
        if (AppPreferences.IsPortalAutoRefreshEnabled() && _sourceWindow != IntPtr.Zero && _devToolsPort is not null)
        {
            _portalSessionTimer.Start();
        }
        else
        {
            _portalSessionTimer.Stop();
            _sessionCheckCancellationSource?.Cancel();
        }
    }

    private void PositionAtBottomRight()
    {
        var workingArea = Screen.PrimaryScreen?.WorkingArea ?? Screen.FromControl(this).WorkingArea;
        Location = new Point(
            Math.Max(workingArea.Left, workingArea.Right - Width - 14),
            Math.Max(workingArea.Top, workingArea.Bottom - Height - 14));
    }

    private void PositionAtSavedLocationOrBottomRight()
    {
        var savedLocation = AppPreferences.GetWindowLocation();
        if (savedLocation is Point location
            && Screen.AllScreens.Any(screen => screen.WorkingArea.Contains(location)))
        {
            Location = location;
            return;
        }

        PositionAtBottomRight();
    }

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (!IsHandleCreated || _applyingWindowShape || Width <= 0 || Height <= 0)
        {
            return;
        }

        try
        {
            _applyingWindowShape = true;
            using var path = new GraphicsPath();
            var bounds = new Rectangle(0, 0, Width, Height);
            const int radius = 18;
            var diameter = radius * 2;
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
            path.CloseFigure();
            Region = new Region(path);
        }
        finally
        {
            _applyingWindowShape = false;
        }
    }

    private void RefreshBrowserWindows()
    {
        var previousHandle = (_browserWindows.SelectedItem as BrowserWindowItem)?.Handle ?? _sourceWindow;
        var windows = BrowserWindowFinder.FindVisibleBrowserWindows();

        _browserWindows.BeginUpdate();
        try
        {
            _browserWindows.Items.Clear();
            foreach (var window in windows)
            {
                _browserWindows.Items.Add(window);
            }

            var previousIndex = windows.FindIndex(window => window.Handle == previousHandle);
            if (previousIndex >= 0)
            {
                _browserWindows.SelectedIndex = previousIndex;
            }
            else if (_browserWindows.Items.Count > 0)
            {
                _browserWindows.SelectedIndex = 0;
            }
        }
        finally
        {
            _browserWindows.EndUpdate();
        }

        if (_sourceWindow != IntPtr.Zero)
        {
            SetConnectionStatus($"{_connectedProcessName ?? "브라우저"} 연결됨");
        }
        else
        {
            SetConnectionStatus(windows.Count == 0 ? "브라우저 없음" : "연결 안 됨");
        }
    }

    private async Task ConnectSelectedBrowserAsync()
    {
        if (_browserWindows.SelectedItem is not BrowserWindowItem selected)
        {
            MessageBox.Show(this, "연결할 Chrome 또는 Edge 창을 선택하십시오.", "브라우저 창 선택", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        if (!NativeMethods.IsWindow(selected.Handle))
        {
            RefreshBrowserWindows();
            MessageBox.Show(this, "선택한 브라우저 창이 더 이상 존재하지 않습니다.", "연결 실패", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        _sourceWindow = selected.Handle;
        _sourceTransparent = false;
        _sourceExtendedStyle = NativeMethods.GetWindowLong(selected.Handle, NativeMethods.GWL_EXSTYLE);
        _connectedProcessName = selected.DisplayName;
        _devToolsPort = null;
        _workflowRunning = true;
        _workflowCancellationSource = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        UpdateConnectionControls();

        try
        {
            SetConnectionStatus($"{selected.DisplayName} 연결 확인 중");
            var educationOffice = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
            _devToolsPort = await DevToolsDiscovery.FindPortalPortAsync(
                educationOffice,
                _workflowCancellationSource.Token);
            if (_devToolsPort is null)
            {
                SetConnectionStatus($"{selected.DisplayName} 로그인 확인 필요");
                MessageBox.Show(
                    this,
                    "선택한 브라우저의 업무포털 제어 채널을 찾지 못했습니다.\r\n"
                    + "'로그인'으로 연 Edge에서 업무포털에 로그인한 뒤 다시 연결해 주세요.",
                    "자동화 연결 필요",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            else
            {
                var controller = new PortalWorkflowController(
                    _devToolsPort.Value,
                    educationOffice,
                    message =>
                    {
                        AppLogger.Info("Progress", message);
                        SetConnectionStatus(message);
                    });
                await controller.PrepareApplicationTargetsAsync(_workflowCancellationSource.Token);
                UpdateAutoRefreshTimer();
                AppLogger.Info(
                    "Connection",
                    AppPreferences.IsPortalAutoRefreshEnabled()
                        ? "나이스·K-에듀파인 세션 자동 연장 감시를 시작했습니다."
                        : "설정에 따라 세션 자동 연장 감시를 시작하지 않습니다.");
                NativeMethods.ShowWindowAsync(_sourceWindow, NativeMethods.SW_MINIMIZE);
                SetConnectionStatus($"{selected.DisplayName} 연결됨");
            }
        }
        catch (OperationCanceledException) when (_isClosing)
        {
            _sourceWindow = IntPtr.Zero;
            _connectedProcessName = null;
            _devToolsPort = null;
        }
        catch (Exception exception)
        {
            AppLogger.Error("Connection", "브라우저 연결 준비 실패", exception);
            if (_sourceWindow != IntPtr.Zero && NativeMethods.IsWindow(_sourceWindow))
            {
                NativeMethods.ShowWindowAsync(_sourceWindow, NativeMethods.SW_MAXIMIZE);
                NativeMethods.SetForegroundWindow(_sourceWindow);
            }

            _sourceWindow = IntPtr.Zero;
            _connectedProcessName = null;
            _devToolsPort = null;
            SetConnectionStatus("연결 실패");
            MessageBox.Show(this, exception.Message, "업무 시스템 준비 실패", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally
        {
            _workflowCancellationSource?.Dispose();
            _workflowCancellationSource = null;
            _workflowRunning = false;
            if (!_isClosing && !IsDisposed && !Disposing)
            {
                UpdateConnectionControls();
            }
        }
    }

    private async Task LaunchControlledEdgeAsync()
    {
        try
        {
            var edgePath = FindEdgeExecutable();
            if (edgePath is null)
            {
                throw new FileNotFoundException("Microsoft Edge 실행 파일을 찾지 못했습니다.");
            }

            var profilePath = EdgeIntegrationPolicy.ControlledProfilePath;
            Directory.CreateDirectory(profilePath);

            var startInfo = new ProcessStartInfo
            {
                FileName = edgePath,
                UseShellExecute = false,
            };
            startInfo.ArgumentList.Add($"--remote-debugging-port={DevToolsDiscovery.DefaultPort}");
            startInfo.ArgumentList.Add("--remote-debugging-address=127.0.0.1");
            startInfo.ArgumentList.Add($"--user-data-dir={profilePath}");
            startInfo.ArgumentList.Add("--start-maximized");
            startInfo.ArgumentList.Add("--new-window");
            var educationOffice = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
            EdgeIntegrationPolicy.PrepareControlledProfile(educationOffice);
            startInfo.ArgumentList.Add(educationOffice.PortalUri.AbsoluteUri);
            Process.Start(startInfo);

            SetStatus("업무포털 로그인 창을 열었습니다. 로그인 후 창 목록을 새로고침해 주세요.");
            await Task.Delay(1500);
            RefreshBrowserWindows();
        }
        catch (Exception exception)
        {
            MessageBox.Show(this, exception.Message, "Edge 실행 실패", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task RunWorkflowAsync(PortalTaskKind taskKind)
    {
        if (_sourceWindow == IntPtr.Zero || !NativeMethods.IsWindow(_sourceWindow))
        {
            MessageBox.Show(this, "먼저 로그인된 Edge 창에 연결해 주세요.", "브라우저 연결 필요", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        if (_devToolsPort is null)
        {
            MessageBox.Show(this, "'로그인'으로 연 Edge에서 업무포털에 로그인한 뒤 다시 연결해 주세요.", "자동화 연결 필요", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        if (_workflowRunning)
        {
            return;
        }

        _sessionCheckCancellationSource?.Cancel();
        _workflowRunning = true;
        _workflowCancellationSource = new CancellationTokenSource(TimeSpan.FromMinutes(5));
        UpdateConnectionControls();
        var gateAcquired = false;
        try
        {
            await _portalOperationGate.WaitAsync(_workflowCancellationSource.Token);
            gateAcquired = true;
            MakeSourceWindowTransparent();
            var educationOffice = EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode());
            var controller = new PortalWorkflowController(
                _devToolsPort.Value,
                educationOffice,
                message =>
                {
                    AppLogger.Info("Progress", message);
                    SetStatus(message);
                },
                MakeSourceWindowTransparent);
            var result = await controller.RunAsync(taskKind, _workflowCancellationSource.Token);
            SetStatus(result.Message);

            if (result.ForegroundWindow != IntPtr.Zero && NativeMethods.IsWindow(result.ForegroundWindow))
            {
                MinimizeSourceWindow();
                NativeMethods.ShowWindowAsync(result.ForegroundWindow, NativeMethods.SW_MAXIMIZE);
                NativeMethods.SetForegroundWindow(result.ForegroundWindow);
            }
            else if (result.KeepActivatedBrowser)
            {
                ShowSourceWindowMaximized();
            }
            else
            {
                RestoreSourceWindow();
                SetStatus(result.Message);
            }
        }
        catch (OperationCanceledException)
        {
            ShowSourceWindowMaximized();
            AppLogger.Info("Workflow", $"{taskKind}: 사용자가 취소했거나 전체 제한 시간을 넘었습니다.");
            SetStatus("업무 화면 이동이 취소되었거나 시간이 초과되었습니다.");
        }
        catch (Exception exception)
        {
            AppLogger.Error("Application", "업무 화면 이동 실패", exception);
            ShowSourceWindowMaximized();
            SetStatus($"이동 실패: {exception.Message}");
            MessageBox.Show(this, exception.Message, "업무 화면 이동 실패", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _workflowCancellationSource.Dispose();
            _workflowCancellationSource = null;
            _workflowRunning = false;
            if (gateAcquired)
            {
                _portalOperationGate.Release();
            }
            if (!_isClosing && !IsDisposed && !Disposing)
            {
                UpdateConnectionControls();
            }
        }
    }

    private async Task CheckPortalSessionsInBackgroundAsync()
    {
        if (_portalSessionCheckRunning || _workflowRunning || _devToolsPort is null || _sourceWindow == IntPtr.Zero)
        {
            return;
        }

        if (!await _portalOperationGate.WaitAsync(0))
        {
            return;
        }

        _portalSessionCheckRunning = true;
        UpdateConnectionControls();
        try
        {
            _sessionCheckCancellationSource = new CancellationTokenSource(TimeSpan.FromSeconds(45));
            var controller = new PortalWorkflowController(
                _devToolsPort.Value,
                EducationOfficeCatalog.GetByCode(AppPreferences.GetEducationOfficeCode()),
                _ => { });
            await controller.ExtendExpiringSessionsAsync(_sessionCheckCancellationSource.Token);
        }
        catch (OperationCanceledException)
        {
            AppLogger.Info("SessionRefresh", "세션 자동 연장 확인이 취소되었거나 제한 시간을 넘었습니다.");
        }
        catch (Exception exception)
        {
            AppLogger.Error("SessionRefresh", "세션 자동 연장 확인 실패", exception);
        }
        finally
        {
            _sessionCheckCancellationSource?.Dispose();
            _sessionCheckCancellationSource = null;
            _portalSessionCheckRunning = false;
            _portalOperationGate.Release();
            if (!_isClosing && !IsDisposed && !Disposing)
            {
                UpdateConnectionControls();
            }
        }
    }

    private static string? FindEdgeExecutable()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    private void RestoreSourceWindow()
    {
        if (_sourceWindow == IntPtr.Zero || !NativeMethods.IsWindow(_sourceWindow))
        {
            SetConnectionStatus("연결 안 됨");
            return;
        }

        ShowSourceWindowMaximized();
        SetConnectionStatus($"연결됨 · {_connectedProcessName ?? "브라우저"}");
    }

    private void MakeSourceWindowTransparent()
    {
        if (_sourceWindow == IntPtr.Zero || !NativeMethods.IsWindow(_sourceWindow))
        {
            return;
        }

        if (!_sourceTransparent)
        {
            _sourceExtendedStyle = NativeMethods.GetWindowLong(_sourceWindow, NativeMethods.GWL_EXSTYLE);
            NativeMethods.SetWindowLong(
                _sourceWindow,
                NativeMethods.GWL_EXSTYLE,
                _sourceExtendedStyle | NativeMethods.WS_EX_LAYERED);
            if (!NativeMethods.SetLayeredWindowAttributes(
                    _sourceWindow,
                    0,
                    0,
                    NativeMethods.LWA_ALPHA))
            {
                NativeMethods.SetWindowLong(_sourceWindow, NativeMethods.GWL_EXSTYLE, _sourceExtendedStyle);
                throw new InvalidOperationException("브라우저 작업 화면을 숨기지 못했습니다.");
            }

            _sourceTransparent = true;
        }

        NativeMethods.ShowWindowAsync(_sourceWindow, NativeMethods.SW_MAXIMIZE);
    }

    private void ShowSourceWindowMaximized()
    {
        if (_sourceWindow == IntPtr.Zero || !NativeMethods.IsWindow(_sourceWindow))
        {
            return;
        }

        NativeMethods.ShowWindowAsync(_sourceWindow, NativeMethods.SW_MAXIMIZE);
        RestoreSourceWindowOpacity();
        NativeMethods.SetForegroundWindow(_sourceWindow);
    }

    private void MinimizeSourceWindow()
    {
        if (_sourceWindow == IntPtr.Zero || !NativeMethods.IsWindow(_sourceWindow))
        {
            return;
        }

        NativeMethods.ShowWindowAsync(_sourceWindow, NativeMethods.SW_MINIMIZE);
        RestoreSourceWindowOpacity();
    }

    private void RestoreSourceWindowOpacity()
    {
        if (!_sourceTransparent || _sourceWindow == IntPtr.Zero || !NativeMethods.IsWindow(_sourceWindow))
        {
            return;
        }

        NativeMethods.SetLayeredWindowAttributes(_sourceWindow, 0, 255, NativeMethods.LWA_ALPHA);
        NativeMethods.SetWindowLong(_sourceWindow, NativeMethods.GWL_EXSTYLE, _sourceExtendedStyle);
        _sourceTransparent = false;
    }

    private void DisconnectBrowser()
    {
        _workflowCancellationSource?.Cancel();
        _sessionCheckCancellationSource?.Cancel();
        _portalSessionTimer.Stop();
        RestoreSourceWindowOpacity();
        _sourceTransparent = false;
        _sourceWindow = IntPtr.Zero;
        _connectedProcessName = null;
        _devToolsPort = null;
        if (!_isClosing && !IsDisposed && !Disposing)
        {
            UpdateConnectionControls();
            SetConnectionStatus("연결 안 됨");
        }
    }

    private void CheckSourceWindow()
    {
        if (_sourceWindow == IntPtr.Zero)
        {
            return;
        }

        if (!NativeMethods.IsWindow(_sourceWindow))
        {
            _sessionCheckCancellationSource?.Cancel();
            _portalSessionTimer.Stop();
            _sourceWindow = IntPtr.Zero;
            _sourceTransparent = false;
            _connectedProcessName = null;
            _devToolsPort = null;
            UpdateConnectionControls();
            SetConnectionStatus("연결 끊김");
        }
    }

    private void UpdateConnectionControls()
    {
        var connected = _sourceWindow != IntPtr.Zero;
        var operationRunning = _workflowRunning;
        _connectButton.Visible = true;
        _connectButton.Text = connected ? "연결 해제" : "연결";
        _connectButton.AccessibleName = connected ? "브라우저 연결 해제" : "브라우저 연결";
        _connectButton.BackColor = connected ? Color.FromArgb(255, 239, 241) : Color.FromArgb(45, 162, 126);
        _connectButton.ForeColor = connected ? Color.FromArgb(160, 70, 82) : Color.White;
        _connectButton.Enabled = !operationRunning;
        _launchBrowserButton.Enabled = !operationRunning;
        _refreshButton.Enabled = !operationRunning;
        _browserWindows.Enabled = !connected && !operationRunning;
        _settingsButton.Enabled = !operationRunning;
        _closeButton.Enabled = !operationRunning;
        foreach (var taskButton in _taskButtons)
        {
            taskButton.Enabled = connected && _devToolsPort is not null && !operationRunning;
        }
    }

    private void SetConnectionStatus(string status)
    {
        _statusLabel.Text = $"● {status}";
    }

    private void SetStatus(string message)
    {
        _statusLabel.Text = message;
    }
}

internal sealed class BrowserWindowItem
{
    public BrowserWindowItem(IntPtr handle, string processName, string title)
    {
        Handle = handle;
        ProcessName = processName;
        Title = title;
    }

    public IntPtr Handle { get; }
    public string ProcessName { get; }
    public string Title { get; }
    public string DisplayName => ProcessName.Equals("msedge", StringComparison.OrdinalIgnoreCase) ? "Edge" : "Chrome";

    public override string ToString() => $"{DisplayName} · {Title}";
}

internal static class BrowserWindowFinder
{
    private static readonly HashSet<string> SupportedProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome",
        "msedge",
    };

    public static List<BrowserWindowItem> FindVisibleBrowserWindows()
    {
        return FindVisibleWindows(SupportedProcesses);
    }

    public static List<BrowserWindowItem> FindVisibleWindowsByProcess(string processName)
    {
        return FindVisibleWindows(new HashSet<string>(StringComparer.OrdinalIgnoreCase) { processName });
    }

    private static List<BrowserWindowItem> FindVisibleWindows(IReadOnlySet<string> processNames)
    {
        var windows = new List<BrowserWindowItem>();
        NativeMethods.EnumWindows((handle, _) =>
        {
            if (!NativeMethods.IsWindowVisible(handle) || NativeMethods.GetWindow(handle, NativeMethods.GW_OWNER) != IntPtr.Zero)
            {
                return true;
            }

            var title = NativeMethods.GetWindowTitle(handle);
            if (string.IsNullOrWhiteSpace(title))
            {
                return true;
            }

            NativeMethods.GetWindowThreadProcessId(handle, out var processId);
            try
            {
                using var process = Process.GetProcessById((int)processId);
                if (!processNames.Contains(process.ProcessName))
                {
                    return true;
                }

                windows.Add(new BrowserWindowItem(handle, process.ProcessName, title));
            }
            catch (ArgumentException)
            {
                // The process may disappear while EnumWindows is walking the window list.
            }

            return true;
        }, IntPtr.Zero);

        return windows
            .OrderBy(window => GetBrowserWindowPriority(window))
            .ThenBy(window => window.ProcessName.Equals("msedge", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
            .ThenBy(window => window.Title, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    private static int GetBrowserWindowPriority(BrowserWindowItem window)
    {
        return window.Title.Contains("업무포털", StringComparison.OrdinalIgnoreCase)
            || window.Title.Contains("나이스", StringComparison.OrdinalIgnoreCase)
            || window.Title.Contains("에듀파인", StringComparison.OrdinalIgnoreCase)
            ? 0
            : 1;
    }
}

internal static class NativeMethods
{
    public const int SW_HIDE = 0;
    public const int SW_MINIMIZE = 6;
    public const int SW_MAXIMIZE = 3;
    public const int SW_RESTORE = 9;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_LAYERED = 0x00080000;
    public const uint LWA_ALPHA = 0x00000002;
    public const uint GW_OWNER = 4;
    public const uint WM_NCLBUTTONDOWN = 0x00A1;
    public static readonly IntPtr HTCAPTION = new(2);

    public delegate bool EnumWindowsProc(IntPtr handle, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindow(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetWindow(IntPtr handle, uint command);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr handle, StringBuilder text, int maxCount);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindowAsync(IntPtr handle, int command);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr handle, int index);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr handle, int index, int value);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetLayeredWindowAttributes(IntPtr handle, uint colorKey, byte alpha, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);

    public static string GetWindowTitle(IntPtr handle)
    {
        var length = GetWindowTextLength(handle);
        if (length == 0)
        {
            return string.Empty;
        }

        var text = new StringBuilder(length + 1);
        GetWindowText(handle, text, text.Capacity);
        return text.ToString();
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int GetWindowTextLength(IntPtr handle);

}
