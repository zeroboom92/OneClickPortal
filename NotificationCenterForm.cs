namespace BrowserThumbnailPrototype;

internal sealed class NotificationCenterForm : Form
{
    private static readonly Color Blue = Color.FromArgb(42, 106, 190);
    private static readonly Color Muted = Color.FromArgb(114, 123, 135);
    private readonly NotificationCenter _center;
    private readonly Func<NotificationKind, bool> _canOpen;
    private readonly bool _isSimulation;
    private readonly ListBox _list = new();
    private readonly Label _emptyLabel = new();
    private readonly LinkLabel _markAllLink = new();
    private readonly Button _closeButton = new();
    private readonly Font _titleFont = new("맑은 고딕", 11F, FontStyle.Bold);
    private readonly Font _unreadFont = new("맑은 고딕", 9F, FontStyle.Bold);
    private readonly Font _timeFont = new("맑은 고딕", 8F);
    private readonly Font _closeFont = new("Segoe UI", 13F);

    public event Action<NotificationKind>? OpenRequested;

    public NotificationCenterForm(NotificationCenter center, Func<NotificationKind, bool>? canOpen = null, bool isSimulation = false)
    {
        _center = center ?? throw new ArgumentNullException(nameof(center));
        _canOpen = canOpen ?? (_ => false);
        _isSimulation = isSimulation;
        Text = isSimulation ? "모의 알림 테스트" : "알림";
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        MaximizeBox = false;
        MinimizeBox = false;
        KeyPreview = true;
        BackColor = Color.White;
        ForeColor = Color.FromArgb(41, 52, 69);
        Font = new Font("맑은 고딕", 9F);
        AutoScaleMode = AutoScaleMode.Dpi;
        ClientSize = new Size(336, 286);
        Padding = new Padding(1);
        MinimumSize = Size;
        MaximumSize = Size;
        BuildUi();
        AutoScaleDimensions = new SizeF(96F, 96F);
        _center.Changed += CenterChanged;
        RefreshEntries();
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        RefreshEntries();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        if (_list.Items.Count > 0) _list.Focus();
        else _closeButton.Focus();
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Escape)
        {
            Close();
            return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        ControlPaint.DrawBorder(e.Graphics, ClientRectangle,
            Color.FromArgb(218, 224, 233), ButtonBorderStyle.Solid);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _center.Changed -= CenterChanged;
            _titleFont.Dispose();
            _unreadFont.Dispose();
            _timeFont.Dispose();
            _closeFont.Dispose();
        }
        base.Dispose(disposing);
    }

    private void BuildUi()
    {
        var layout = new TableLayoutPanel
        {
            Dock = DockStyle.Fill,
            ColumnCount = 1,
            RowCount = 3,
            Margin = Padding.Empty,
            Padding = Padding.Empty,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 44));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 24));
        Controls.Add(layout);

        var header = new Panel { Dock = DockStyle.Fill, Size = new Size(334, 44), Margin = Padding.Empty };
        header.Controls.Add(new Label
        {
            Text = _isSimulation ? "모의 알림" : "알림",
            Font = _titleFont,
            AutoSize = true,
            Location = new Point(14, 11),
            TabStop = false,
        });
        _markAllLink.Text = "모두 확인";
        _markAllLink.AutoSize = true;
        _markAllLink.Location = new Point(236, 15);
        _markAllLink.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _markAllLink.LinkColor = Muted;
        _markAllLink.ActiveLinkColor = Blue;
        _markAllLink.LinkBehavior = LinkBehavior.HoverUnderline;
        _markAllLink.AccessibleName = "알림 모두 확인";
        _markAllLink.LinkClicked += (_, _) => _center.MarkAllRead();
        header.Controls.Add(_markAllLink);
        _closeButton.Text = "×";
        _closeButton.Font = _closeFont;
        _closeButton.Location = new Point(303, 8);
        _closeButton.Size = new Size(26, 26);
        _closeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
        _closeButton.FlatStyle = FlatStyle.Flat;
        _closeButton.FlatAppearance.BorderSize = 0;
        _closeButton.FlatAppearance.MouseOverBackColor = Color.FromArgb(242, 245, 249);
        _closeButton.BackColor = Color.White;
        _closeButton.ForeColor = Muted;
        _closeButton.Padding = Padding.Empty;
        _closeButton.AccessibleName = "알림창 닫기";
        _closeButton.Click += (_, _) => Close();
        header.Controls.Add(_closeButton);
        header.Controls.Add(new Panel
        {
            Dock = DockStyle.Bottom,
            Height = 1,
            BackColor = Color.FromArgb(237, 240, 245),
        });
        layout.Controls.Add(header, 0, 0);

        var body = new Panel { Dock = DockStyle.Fill, Margin = Padding.Empty };
        _list.Dock = DockStyle.Fill;
        _list.BorderStyle = BorderStyle.None;
        _list.IntegralHeight = false;
        _list.DrawMode = DrawMode.OwnerDrawFixed;
        _list.ItemHeight = 66;
        _list.BackColor = Color.White;
        _list.ForeColor = ForeColor;
        _list.AccessibleName = "알림 목록";
        _list.AccessibleDescription = "알림을 누르면 확인 처리하고, 연결된 업무 화면이 있으면 엽니다.";
        _list.DrawItem += DrawNotification;
        _list.MouseClick += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            var index = _list.IndexFromPoint(e.Location);
            if (index >= 0 && _list.GetItemRectangle(index).Contains(e.Location)) OpenEntry(index);
        };
        _list.KeyDown += (_, e) =>
        {
            if (e.KeyCode is not (Keys.Enter or Keys.Space)) return;
            e.Handled = true;
            e.SuppressKeyPress = true;
            OpenEntry(_list.SelectedIndex);
        };
        body.Controls.Add(_list);
        _emptyLabel.Dock = DockStyle.Fill;
        _emptyLabel.Text = "새 알림이 없습니다.";
        _emptyLabel.TextAlign = ContentAlignment.MiddleCenter;
        _emptyLabel.ForeColor = Muted;
        _emptyLabel.AccessibleName = _emptyLabel.Text;
        body.Controls.Add(_emptyLabel);
        layout.Controls.Add(body, 0, 1);
        layout.Controls.Add(new Label
        {
            Text = _isSimulation ? "모의 알림 · 클릭하면 실제 나이스 조회" : "현재 테스트 중입니다",
            Dock = DockStyle.Fill,
            Margin = Padding.Empty,
            Font = _timeFont,
            ForeColor = Muted,
            TextAlign = ContentAlignment.MiddleCenter,
        }, 0, 2);
    }

    private void DrawNotification(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= _list.Items.Count) return;
        var entry = ((NotificationListEntry)_list.Items[e.Index]).Notification;
        var selected = (e.State & DrawItemState.Selected) != 0;
        using var background = new SolidBrush(selected ? Color.FromArgb(241, 246, 254) : Color.White);
        e.Graphics.FillRectangle(background, e.Bounds);
        var scale = DeviceDpi / 96F;
        int Pixels(int value) => (int)Math.Round(value * scale);
        var left = e.Bounds.Left + Pixels(27);
        if (!entry.IsRead)
        {
            using var dot = new SolidBrush(Blue);
            e.Graphics.FillEllipse(dot, e.Bounds.Left + Pixels(13), e.Bounds.Top + Pixels(19), Pixels(6), Pixels(6));
        }
        var textWidth = Math.Max(0, e.Bounds.Right - left - Pixels(14));
        var summaryBounds = new Rectangle(left, e.Bounds.Top + Pixels(10), textWidth, Pixels(23));
        TextRenderer.DrawText(e.Graphics, GetSummary(entry), entry.IsRead ? Font : _unreadFont,
            summaryBounds, ForeColor,
            TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
        var timeBounds = new Rectangle(left, e.Bounds.Top + Pixels(35), textWidth, Pixels(19));
        TextRenderer.DrawText(e.Graphics, FormatTime(entry.CreatedAt), _timeFont, timeBounds, Muted,
            TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        using var separator = new Pen(Color.FromArgb(242, 244, 247));
        e.Graphics.DrawLine(separator, e.Bounds.Left + Pixels(13), e.Bounds.Bottom - 1,
            e.Bounds.Right - Pixels(13), e.Bounds.Bottom - 1);
        if ((e.State & DrawItemState.Focus) != 0 && _list.Focused) e.DrawFocusRectangle();
    }

    private void OpenEntry(int index)
    {
        if (index < 0 || index >= _list.Items.Count) return;
        var entry = ((NotificationListEntry)_list.Items[index]).Notification;
        _center.MarkRead(entry.Id);
        if (!IsDisposed && !Disposing && _canOpen(entry.Kind)) OpenRequested?.Invoke(entry.Kind);
    }

    private void CenterChanged(object? sender, EventArgs e)
    {
        if (IsDisposed || Disposing || !IsHandleCreated) return;
        if (InvokeRequired)
        {
            try
            {
                BeginInvoke((Action)(() =>
                {
                    if (!IsDisposed && !Disposing) RefreshEntries();
                }));
            }
            catch (InvalidOperationException) { }
            return;
        }
        RefreshEntries();
    }

    private void RefreshEntries()
    {
        if (IsDisposed || Disposing) return;
        var selectedId = (_list.SelectedItem as NotificationListEntry)?.Notification.Id;
        var topIndex = _list.TopIndex;
        var entries = _center.Entries;
        _list.BeginUpdate();
        try
        {
            _list.Items.Clear();
            foreach (var entry in entries) _list.Items.Add(new NotificationListEntry(entry));
            _list.ItemHeight = (int)Math.Round(66 * DeviceDpi / 96F);
            for (var index = 0; index < _list.Items.Count; index++)
                if (((NotificationListEntry)_list.Items[index]).Notification.Id == selectedId)
                {
                    _list.SelectedIndex = index;
                    break;
                }
            if (_list.Items.Count > 0) _list.TopIndex = Math.Clamp(topIndex, 0, _list.Items.Count - 1);
        }
        finally { _list.EndUpdate(); }
        _markAllLink.Enabled = _center.UnreadCount > 0;
        _emptyLabel.Visible = entries.Count == 0;
        _list.Visible = entries.Count > 0;
        if (_emptyLabel.Visible) _emptyLabel.BringToFront();
        _list.Invalidate();
    }

    private static string GetSummary(PortalNotification entry) => entry.Kind switch
    {
        NotificationKind.Approval => $"결재대기 {entry.ItemCount:N0}건 증가",
        NotificationKind.FieldTrip => $"교외체험학습 신청 {entry.ItemCount:N0}건",
        NotificationKind.Absence => $"결석신고서 제출 {entry.ItemCount:N0}건",
        NotificationKind.AbsencePending => $"결석신고서 접수대기 {entry.ItemCount:N0}건",
        NotificationKind.FieldTripReport => $"교외체험학습 보고서 미상신 {entry.ItemCount:N0}건",
        _ => entry.Title.Replace('\r', ' ').Replace('\n', ' '),
    };

    private static string FormatTime(DateTimeOffset createdAt)
    {
        var local = createdAt.ToLocalTime();
        var today = DateTime.Today;
        if (local.Date == today) return $"오늘 {local:HH:mm}";
        if (local.Date == today.AddDays(-1)) return $"어제 {local:HH:mm}";
        return local.Year == today.Year ? local.ToString("MM.dd HH:mm") : local.ToString("yyyy.MM.dd HH:mm");
    }

    private sealed record NotificationListEntry(PortalNotification Notification)
    {
        public override string ToString() => $"{GetSummary(Notification)}, {FormatTime(Notification.CreatedAt)}, {(Notification.IsRead ? "확인" : "미확인")}";
    }
}
