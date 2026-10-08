namespace BrowserThumbnailPrototype;

internal sealed class UpdateAnnouncementForm : Form
{
    private readonly UpdateFeaturePreview _featurePreview = new();
    public bool OpenSettingsRequested { get; private set; }

    public UpdateAnnouncementForm(bool showSettingsButton = true)
    {
        Text = "원클릭업무포털 업데이트 안내";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(580, 520);
        BackColor = Color.White;
        ForeColor = Color.FromArgb(34, 40, 50);
        Font = new Font("맑은 고딕", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        AccessibleDescription = UpdateAnnouncement.Title + ". " + UpdateAnnouncement.Summary;

        Controls.Add(new Label
        {
            Text = $"새로운 업데이트 · v{UpdateAnnouncement.CurrentVersion}",
            Location = new Point(24, 22),
            AutoSize = true,
            ForeColor = Color.FromArgb(49, 124, 213),
        });
        Controls.Add(new Label
        {
            Text = UpdateAnnouncement.Title,
            Location = new Point(24, 48),
            Size = new Size(532, 36),
            Font = new Font("맑은 고딕", 17F, FontStyle.Bold),
        });

        _featurePreview.Location = new Point(24, 96);
        _featurePreview.Size = new Size(532, 299);
        Controls.Add(_featurePreview);

        Controls.Add(new Label
        {
            Text = UpdateAnnouncement.Summary,
            Location = new Point(24, 408),
            Size = new Size(532, 42),
            ForeColor = Color.FromArgb(92, 102, 116),
        });

        if (showSettingsButton)
        {
            var settingsButton = CreateButton("설정 열기", new Point(288, 470), 170, primary: true);
            settingsButton.Click += (_, _) =>
            {
                OpenSettingsRequested = true;
                DialogResult = DialogResult.OK;
            };
            Controls.Add(settingsButton);
        }
        var confirmButton = CreateButton("확인", new Point(470, 470), 86, primary: !showSettingsButton);
        confirmButton.DialogResult = DialogResult.OK;
        Controls.Add(confirmButton);
        AcceptButton = confirmButton;
        AutoScaleDimensions = new SizeF(96F, 96F);
    }

    private static Button CreateButton(string text, Point location, int width, bool primary)
    {
        var button = new Button
        {
            Text = text,
            Location = location,
            Size = new Size(width, 32),
            FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Color.FromArgb(49, 124, 213) : Color.FromArgb(241, 244, 248),
            ForeColor = primary ? Color.White : Color.FromArgb(74, 84, 100),
            UseVisualStyleBackColor = false,
        };
        button.FlatAppearance.BorderColor = primary ? button.BackColor : Color.FromArgb(220, 225, 232);
        return button;
    }

}
