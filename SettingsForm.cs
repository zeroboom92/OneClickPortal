namespace BrowserThumbnailPrototype;

internal sealed class SettingsForm : Form
{
    private readonly CheckBox _windowsStartupCheckBox = new();
    private readonly CheckBox _portalAutoRefreshCheckBox = new();
    private readonly CheckBox _usageTelemetryCheckBox = new();
    private readonly CheckBox _alwaysOnTopCheckBox = new();
    private readonly ComboBox _educationOfficeComboBox = new();
    private readonly TrackBar _opacityTrackBar = new();
    private readonly Label _opacityValueLabel = new();
    private readonly Label _activeUsersLabel = new();

    public SettingsForm(
        bool windowsStartupEnabled,
        bool portalAutoRefreshEnabled,
        bool usageTelemetryEnabled,
        bool alwaysOnTopEnabled,
        string educationOfficeCode,
        int windowOpacityPercent)
    {
        Text = "설정";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(410, 438);
        BackColor = Color.White;
        ForeColor = Color.FromArgb(34, 40, 50);
        Font = new Font("맑은 고딕", 9F);

        var title = new Label
        {
            Text = "설정",
            Font = new Font("맑은 고딕", 15F, FontStyle.Bold),
            ForeColor = Color.FromArgb(42, 106, 190),
            AutoSize = true,
            Location = new Point(24, 20),
        };
        Controls.Add(title);

        var subtitle = new Label
        {
            Text = "원클릭업무포털의 실행 환경을 관리합니다.",
            ForeColor = Color.FromArgb(92, 102, 116),
            AutoSize = true,
            Location = new Point(26, 51),
        };
        Controls.Add(subtitle);

        var optionsPanel = new Panel
        {
            Location = new Point(24, 82),
            Size = new Size(362, 169),
            BackColor = Color.FromArgb(245, 247, 250),
        };
        Controls.Add(optionsPanel);

        var educationOfficeLabel = new Label
        {
            Text = "소속 교육청",
            AutoSize = true,
            Location = new Point(16, 15),
            ForeColor = Color.FromArgb(45, 52, 64),
            BackColor = Color.Transparent,
        };
        optionsPanel.Controls.Add(educationOfficeLabel);

        _educationOfficeComboBox.DropDownStyle = ComboBoxStyle.DropDownList;
        _educationOfficeComboBox.Location = new Point(106, 11);
        _educationOfficeComboBox.Size = new Size(230, 25);
        _educationOfficeComboBox.DisplayMember = nameof(EducationOffice.Name);
        _educationOfficeComboBox.DataSource = EducationOfficeCatalog.All.ToList();
        _educationOfficeComboBox.SelectedItem = EducationOfficeCatalog.GetByCode(educationOfficeCode);
        optionsPanel.Controls.Add(_educationOfficeComboBox);

        _windowsStartupCheckBox.Text = "Windows 시작 시 자동 실행";
        _windowsStartupCheckBox.Checked = windowsStartupEnabled;
        _windowsStartupCheckBox.AutoSize = true;
        _windowsStartupCheckBox.Location = new Point(16, 47);
        _windowsStartupCheckBox.ForeColor = Color.FromArgb(45, 52, 64);
        _windowsStartupCheckBox.BackColor = Color.Transparent;
        optionsPanel.Controls.Add(_windowsStartupCheckBox);

        _portalAutoRefreshCheckBox.Text = "나이스·K-에듀파인 세션 자동 연장";
        _portalAutoRefreshCheckBox.Checked = portalAutoRefreshEnabled;
        _portalAutoRefreshCheckBox.AutoSize = true;
        _portalAutoRefreshCheckBox.Location = new Point(16, 77);
        _portalAutoRefreshCheckBox.ForeColor = Color.FromArgb(45, 52, 64);
        _portalAutoRefreshCheckBox.BackColor = Color.Transparent;
        optionsPanel.Controls.Add(_portalAutoRefreshCheckBox);

        _usageTelemetryCheckBox.Text = "익명 사용 통계 전송(설치 수·버전만)";
        _usageTelemetryCheckBox.Checked = usageTelemetryEnabled;
        _usageTelemetryCheckBox.AutoSize = true;
        _usageTelemetryCheckBox.Location = new Point(16, 107);
        _usageTelemetryCheckBox.ForeColor = Color.FromArgb(45, 52, 64);
        _usageTelemetryCheckBox.BackColor = Color.Transparent;
        optionsPanel.Controls.Add(_usageTelemetryCheckBox);

        _alwaysOnTopCheckBox.Text = "프로그램을 항상 위에 표시";
        _alwaysOnTopCheckBox.Checked = alwaysOnTopEnabled;
        _alwaysOnTopCheckBox.AutoSize = true;
        _alwaysOnTopCheckBox.Location = new Point(16, 137);
        _alwaysOnTopCheckBox.ForeColor = Color.FromArgb(45, 52, 64);
        _alwaysOnTopCheckBox.BackColor = Color.Transparent;
        optionsPanel.Controls.Add(_alwaysOnTopCheckBox);

        var opacityTitle = new Label
        {
            Text = "프로그램 투명도",
            AutoSize = true,
            Location = new Point(25, 269),
            ForeColor = Color.FromArgb(45, 52, 64),
        };
        Controls.Add(opacityTitle);

        _opacityTrackBar.Minimum = 70;
        _opacityTrackBar.Maximum = 100;
        _opacityTrackBar.TickFrequency = 10;
        _opacityTrackBar.Value = Math.Clamp(windowOpacityPercent, 70, 100);
        _opacityTrackBar.Location = new Point(22, 291);
        _opacityTrackBar.Size = new Size(300, 40);
        _opacityTrackBar.BackColor = Color.White;
        _opacityTrackBar.ValueChanged += (_, _) => UpdateOpacityLabel();
        Controls.Add(_opacityTrackBar);

        _opacityValueLabel.AutoSize = false;
        _opacityValueLabel.TextAlign = ContentAlignment.MiddleRight;
        _opacityValueLabel.Size = new Size(50, 24);
        _opacityValueLabel.Location = new Point(330, 296);
        _opacityValueLabel.ForeColor = Color.FromArgb(42, 106, 190);
        Controls.Add(_opacityValueLabel);
        UpdateOpacityLabel();

        var infoPanel = new Panel
        {
            Location = new Point(24, 334),
            Size = new Size(362, 63),
            BackColor = Color.Transparent,
        };
        Controls.Add(infoPanel);

        var versionLabel = new Label
        {
            Text = $"원클릭업무포털 · v{GetDisplayVersion()}",
            AutoSize = true,
            Location = new Point(0, 0),
            ForeColor = Color.FromArgb(92, 102, 116),
        };
        infoPanel.Controls.Add(versionLabel);

        _activeUsersLabel.Text = "현재 사용자 수를 확인하는 중입니다…";
        _activeUsersLabel.AutoSize = true;
        _activeUsersLabel.Location = new Point(0, 21);
        _activeUsersLabel.ForeColor = Color.FromArgb(42, 106, 190);
        infoPanel.Controls.Add(_activeUsersLabel);

        var copyrightLabel = new Label
        {
            Text = "© 2026 온영범 · 청완초등학교",
            AutoSize = true,
            Location = new Point(0, 42),
            ForeColor = Color.FromArgb(130, 138, 150),
        };
        infoPanel.Controls.Add(copyrightLabel);

        var cancelButton = new Button();
        StyleButton(cancelButton, "취소", 78, Color.FromArgb(241, 244, 248), Color.FromArgb(74, 84, 100));
        cancelButton.Location = new Point(221, 402);
        cancelButton.DialogResult = DialogResult.Cancel;
        Controls.Add(cancelButton);

        var saveButton = new Button();
        StyleButton(saveButton, "저장", 78, Color.FromArgb(49, 124, 213), Color.White);
        saveButton.Location = new Point(308, 402);
        saveButton.DialogResult = DialogResult.OK;
        Controls.Add(saveButton);

        AcceptButton = saveButton;
        CancelButton = cancelButton;
        Shown += async (_, _) => await UpdateActiveUsersAsync();
    }

    public bool WindowsStartupEnabled => _windowsStartupCheckBox.Checked;

    public bool PortalAutoRefreshEnabled => _portalAutoRefreshCheckBox.Checked;

    public bool UsageTelemetryEnabled => _usageTelemetryCheckBox.Checked;

    public bool AlwaysOnTopEnabled => _alwaysOnTopCheckBox.Checked;

    public string EducationOfficeCode =>
        (_educationOfficeComboBox.SelectedItem as EducationOffice ?? EducationOfficeCatalog.Default).Code;

    public int WindowOpacityPercent => _opacityTrackBar.Value;

    private static string GetDisplayVersion()
    {
        return Application.ProductVersion.Split('+', 2)[0];
    }

    private void UpdateOpacityLabel()
    {
        _opacityValueLabel.Text = $"{_opacityTrackBar.Value}%";
    }

    private async Task UpdateActiveUsersAsync()
    {
        var summary = await UsageTelemetry.GetUsageSummaryAsync();
        if (summary is null)
        {
            _activeUsersLabel.Text = "현재 사용자 수를 확인할 수 없습니다.";
        }
        else
        {
            _activeUsersLabel.Text = $"현재 {summary.ActiveUsers:N0}명의 사용자가 원클릭 업무포털을 사용 중입니다";
        }
    }

    private static void StyleButton(Button button, string text, int width, Color backColor, Color foreColor)
    {
        button.Text = text;
        button.Width = width;
        button.Height = 30;
        button.Font = new Font("맑은 고딕", 9F);
        button.ForeColor = foreColor;
        button.BackColor = backColor;
        button.FlatStyle = FlatStyle.Flat;
        button.FlatAppearance.BorderSize = 1;
        button.FlatAppearance.BorderColor = Color.FromArgb(220, 225, 232);
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(228, 238, 251);
        button.FlatAppearance.MouseDownBackColor = Color.FromArgb(215, 229, 247);
        button.UseVisualStyleBackColor = false;
    }
}
