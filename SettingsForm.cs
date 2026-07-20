namespace BrowserThumbnailPrototype;

internal sealed class SettingsForm : Form
{
    private readonly CheckBox _windowsStartupCheckBox = new();
    private readonly CheckBox _portalAutoRefreshCheckBox = new();
    private readonly TrackBar _opacityTrackBar = new();
    private readonly Label _opacityValueLabel = new();

    public SettingsForm(bool windowsStartupEnabled, bool portalAutoRefreshEnabled, int windowOpacityPercent)
    {
        Text = "설정";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(410, 318);
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
            Size = new Size(362, 82),
            BackColor = Color.FromArgb(245, 247, 250),
        };
        Controls.Add(optionsPanel);

        _windowsStartupCheckBox.Text = "Windows 시작 시 자동 실행";
        _windowsStartupCheckBox.Checked = windowsStartupEnabled;
        _windowsStartupCheckBox.AutoSize = true;
        _windowsStartupCheckBox.Location = new Point(16, 13);
        _windowsStartupCheckBox.ForeColor = Color.FromArgb(45, 52, 64);
        _windowsStartupCheckBox.BackColor = Color.Transparent;
        optionsPanel.Controls.Add(_windowsStartupCheckBox);

        _portalAutoRefreshCheckBox.Text = "업무포털 자동 새로고침";
        _portalAutoRefreshCheckBox.Checked = portalAutoRefreshEnabled;
        _portalAutoRefreshCheckBox.AutoSize = true;
        _portalAutoRefreshCheckBox.Location = new Point(16, 46);
        _portalAutoRefreshCheckBox.ForeColor = Color.FromArgb(45, 52, 64);
        _portalAutoRefreshCheckBox.BackColor = Color.Transparent;
        optionsPanel.Controls.Add(_portalAutoRefreshCheckBox);

        var opacityTitle = new Label
        {
            Text = "프로그램 투명도",
            AutoSize = true,
            Location = new Point(25, 182),
            ForeColor = Color.FromArgb(45, 52, 64),
        };
        Controls.Add(opacityTitle);

        _opacityTrackBar.Minimum = 70;
        _opacityTrackBar.Maximum = 100;
        _opacityTrackBar.TickFrequency = 10;
        _opacityTrackBar.Value = Math.Clamp(windowOpacityPercent, 70, 100);
        _opacityTrackBar.Location = new Point(22, 204);
        _opacityTrackBar.Size = new Size(300, 40);
        _opacityTrackBar.BackColor = Color.White;
        _opacityTrackBar.ValueChanged += (_, _) => UpdateOpacityLabel();
        Controls.Add(_opacityTrackBar);

        _opacityValueLabel.AutoSize = false;
        _opacityValueLabel.TextAlign = ContentAlignment.MiddleRight;
        _opacityValueLabel.Size = new Size(50, 24);
        _opacityValueLabel.Location = new Point(330, 209);
        _opacityValueLabel.ForeColor = Color.FromArgb(42, 106, 190);
        Controls.Add(_opacityValueLabel);
        UpdateOpacityLabel();

        var infoPanel = new Panel
        {
            Location = new Point(24, 247),
            Size = new Size(362, 42),
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

        var copyrightLabel = new Label
        {
            Text = "© 2026 온영범 · 청완초등학교",
            AutoSize = true,
            Location = new Point(0, 21),
            ForeColor = Color.FromArgb(130, 138, 150),
        };
        infoPanel.Controls.Add(copyrightLabel);

        var cancelButton = new Button();
        StyleButton(cancelButton, "취소", 78, Color.FromArgb(241, 244, 248), Color.FromArgb(74, 84, 100));
        cancelButton.Location = new Point(221, 286);
        cancelButton.DialogResult = DialogResult.Cancel;
        Controls.Add(cancelButton);

        var saveButton = new Button();
        StyleButton(saveButton, "저장", 78, Color.FromArgb(49, 124, 213), Color.White);
        saveButton.Location = new Point(308, 286);
        saveButton.DialogResult = DialogResult.OK;
        Controls.Add(saveButton);

        AcceptButton = saveButton;
        CancelButton = cancelButton;
    }

    public bool WindowsStartupEnabled => _windowsStartupCheckBox.Checked;

    public bool PortalAutoRefreshEnabled => _portalAutoRefreshCheckBox.Checked;

    public int WindowOpacityPercent => _opacityTrackBar.Value;

    private static string GetDisplayVersion()
    {
        return Application.ProductVersion.Split('+', 2)[0];
    }

    private void UpdateOpacityLabel()
    {
        _opacityValueLabel.Text = $"{_opacityTrackBar.Value}%";
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
