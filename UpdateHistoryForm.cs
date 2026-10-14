namespace BrowserThumbnailPrototype;

internal sealed class UpdateHistoryForm : Form
{
    private readonly ListBox _versions = new();
    private readonly RichTextBox _details = new();

    public UpdateHistoryForm()
    {
        Text = "원클릭업무포털 업데이트 기록";
        StartPosition = FormStartPosition.CenterParent;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new Size(780, 540);
        MinimumSize = new Size(660, 460);
        BackColor = Color.White;
        ForeColor = Color.FromArgb(34, 40, 50);
        Font = new Font("맑은 고딕", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        AccessibleDescription = "버전을 선택하면 해당 버전의 변경 내용을 읽을 수 있습니다.";

        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Padding = new Padding(24),
            ColumnCount = 1,
            RowCount = 4,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        Controls.Add(layout);

        layout.Controls.Add(new Label
        {
            Text = "이전 업데이트 내용",
            AutoSize = true,
            Font = new Font("맑은 고딕", 17F, FontStyle.Bold),
            Margin = new Padding(0, 0, 0, 8),
        }, 0, 0);
        layout.Controls.Add(new Label
        {
            Text = "버전을 선택해 배포 당시의 변경 내용을 확인하세요. 최신 버전부터 표시합니다.",
            AutoSize = true,
            ForeColor = Color.FromArgb(92, 102, 116),
            Margin = new Padding(0, 0, 0, 18),
        }, 0, 1);

        var content = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
            ColumnCount = 2,
            RowCount = 1,
        };
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 160));
        content.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        content.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(content, 0, 2);

        _versions.Dock = DockStyle.Fill;
        _versions.Margin = new Padding(0, 0, 16, 0);
        _versions.BorderStyle = BorderStyle.FixedSingle;
        _versions.IntegralHeight = false;
        _versions.Font = new Font("맑은 고딕", 10F);
        _versions.DisplayMember = nameof(UpdateRelease.DisplayName);
        _versions.AccessibleName = "업데이트 버전 선택";
        _versions.AccessibleDescription = "위아래 방향키로 버전을 선택할 수 있습니다. 최신 버전부터 표시합니다.";
        _versions.SelectedIndexChanged += (_, _) => ShowSelectedRelease();
        content.Controls.Add(_versions, 0, 0);

        _details.Dock = DockStyle.Fill;
        _details.Margin = Padding.Empty;
        _details.ReadOnly = true;
        _details.BackColor = Color.White;
        _details.ForeColor = ForeColor;
        _details.BorderStyle = BorderStyle.FixedSingle;
        _details.DetectUrls = false;
        _details.WordWrap = true;
        _details.ScrollBars = RichTextBoxScrollBars.Vertical;
        _details.AccessibleName = "선택한 버전의 업데이트 내용";
        content.Controls.Add(_details, 1, 0);

        var footer = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            Margin = new Padding(0, 16, 0, 0),
            ColumnCount = 2,
            RowCount = 1,
        };
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        footer.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 86));
        footer.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.Controls.Add(footer, 0, 3);
        footer.Controls.Add(new Label
        {
            Text = $"총 {UpdateHistory.Releases.Count}개 버전 · 최신순",
            AutoSize = true,
            Anchor = AnchorStyles.Left,
            ForeColor = Color.FromArgb(92, 102, 116),
            Margin = Padding.Empty,
        }, 0, 0);
        var closeButton = new Button
        {
            Text = "닫기",
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(49, 124, 213),
            ForeColor = Color.White,
            UseVisualStyleBackColor = false,
            DialogResult = DialogResult.Cancel,
        };
        closeButton.FlatAppearance.BorderColor = closeButton.BackColor;
        footer.Controls.Add(closeButton, 1, 0);
        AcceptButton = closeButton;
        CancelButton = closeButton;

        foreach (var release in UpdateHistory.Releases)
            _versions.Items.Add(release);
        // Open on the preceding release; the latest remains available in the list.
        _versions.SelectedIndex = Math.Min(1, _versions.Items.Count - 1);
        ActiveControl = _versions;
        AutoScaleDimensions = new SizeF(96F, 96F);
    }

    private void ShowSelectedRelease()
    {
        if (_versions.SelectedItem is not UpdateRelease release) return;

        _details.Clear();
        var version = $"v{release.Version} · {release.ReleasedOn:yyyy.MM.dd}";
        if (string.Equals(release.Version, UpdateAnnouncement.CurrentVersion, StringComparison.Ordinal))
            version += " · 현재 설치 버전";
        using var regular = new Font("맑은 고딕", 10F);
        using var heading = new Font("맑은 고딕", 15F, FontStyle.Bold);
        using var bold = new Font("맑은 고딕", 10F, FontStyle.Bold);
        Append(version + "\n\n", regular, Color.FromArgb(49, 124, 213));
        Append(release.Title + "\n\n", heading, ForeColor);
        Append(release.Summary + "\n\n", regular, Color.FromArgb(92, 102, 116));
        Append("주요 변경 사항\n\n", bold, ForeColor);
        foreach (var change in release.Changes)
            Append("• " + change + "\n\n", regular, ForeColor);
        _details.Select(0, 0);
        _details.ScrollToCaret();
        _details.AccessibleDescription = version + ". " + release.Title + ". " + release.Summary;
    }

    private void Append(string text, Font font, Color color)
    {
        _details.SelectionFont = font;
        _details.SelectionColor = color;
        _details.AppendText(text);
    }
}
