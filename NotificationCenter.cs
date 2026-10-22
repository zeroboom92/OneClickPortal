using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BrowserThumbnailPrototype;

internal enum NotificationKind
{
    Approval,
    FieldTrip,
    Absence,
    FieldTripReport,
    AbsencePending = 4,
}

// Id must be stable for the source system. Never pass student names, document bodies,
// credentials or other personal information in Summary; only generic UI summaries are allowed.
internal sealed record NotificationSourceItem(string Id, string Summary);

internal sealed record PortalNotification(
    string Id,
    NotificationKind Kind,
    string Title,
    string Message,
    DateTimeOffset CreatedAt,
    bool IsRead,
    [property: JsonIgnore] string? SourceKey = null)
{
    public int ItemCount { get; init; } = 1;
}

/// <summary>
/// Stores generic notification summaries, never source IDs, scopes, names or document text.
/// Count and new-submission baselines exist only in memory. Pending field-trip reports
/// notify on their first observation and retain only hashed deduplication keys on disk.
/// Pending absence reports retain daily scoped fingerprints for 35 Korea calendar days.
/// Callers must reject failed, incomplete or unauthenticated snapshots before observing them.
/// </summary>
internal sealed class NotificationCenter
{
    internal const int MaximumEntries = 300;
    internal const int MaximumRememberedItems = 1000;
    internal const int PendingAbsenceRetentionDays = 35;
    private const int MaximumStoreBytes = 16 * 1024 * 1024;
    private readonly object syncRoot = new();
    private readonly string storagePath;
    private readonly List<PortalNotification> entries = [];
    private readonly Dictionary<ObservationKey, int> countBaselines = [];
    private readonly Dictionary<ObservationKey, ItemObservation> itemBaselines = [];
    // Keep these independently of the 300 visible entries and all in-memory baselines.
    // Raw report IDs and the stable office/account/class scope never leave the caller.
    private readonly HashSet<string> notifiedFieldTripReports = new(StringComparer.Ordinal);
    // Dates are Korea calendar dates; values contain only scoped source fingerprints.
    // Reading or clearing visible history must not repeat the same day's pending alerts.
    private readonly Dictionary<DateOnly, HashSet<string>> notifiedPendingAbsenceDays = [];
    private bool initialReadFailed;
    private bool hasPersistenceError;

    public NotificationCenter()
        : this(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "OneClickPortal", "notifications.json"))
    {
    }

    public NotificationCenter(string storagePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(storagePath);
        this.storagePath = Path.GetFullPath(storagePath);
        Load();
    }

    public event EventHandler? Changed;

    public IReadOnlyList<PortalNotification> Entries
    {
        get { lock (syncRoot) return entries.ToList().AsReadOnly(); }
    }

    public int UnreadCount
    {
        get { lock (syncRoot) return entries.Count(entry => !entry.IsRead); }
    }

    public bool HasPersistenceError
    {
        get { lock (syncRoot) return hasPersistenceError; }
    }

    /// <summary>
    /// Counts detect net increases only. A replacement at the same count cannot be detected;
    /// use stable source items when the source exposes a verified complete list.
    /// </summary>
    public IReadOnlyList<PortalNotification> ObserveCount(
        NotificationKind kind, int count, string scope, DateTimeOffset? now = null)
    {
        if (!IsValid(kind, scope) || count < 0) return Array.Empty<PortalNotification>();
        PortalNotification? added = null;
        lock (syncRoot)
        {
            var key = new ObservationKey(kind, scope);
            var hasBaseline = countBaselines.TryGetValue(key, out var previous);
            countBaselines[key] = count;
            if (hasBaseline && count > previous)
            {
                added = Create(kind, count - previous, now ?? DateTimeOffset.Now);
                AddAndSave([added]);
            }
        }
        if (added is null) return Array.Empty<PortalNotification>();
        Changed?.Invoke(this, EventArgs.Empty);
        return Array.AsReadOnly(new[] { added });
    }

    public IReadOnlyList<PortalNotification> ObserveItems(
        NotificationKind kind, IReadOnlyList<NotificationSourceItem>? items,
        string scope, DateTimeOffset? now = null)
    {
        if (!IsValid(kind, scope) || items is null) return Array.Empty<PortalNotification>();
        // Validate the entire snapshot before changing any baseline. Partial invalid lists
        // must not establish a baseline or make existing entries disappear.
        var current = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (item is null || string.IsNullOrWhiteSpace(item.Id) || item.Id.Length > 2048)
                return Array.Empty<PortalNotification>();
            // Summary is deliberately ignored. A reader accidentally returning a student's
            // name or document title must not cause it to be persisted or shown in a toast.
            current.Add(Fingerprint(kind, scope, item.Id));
        }

        List<PortalNotification> added = [];
        lock (syncRoot)
        {
            var key = new ObservationKey(kind, scope);
            if (!itemBaselines.TryGetValue(key, out var observation))
            {
                observation = new ItemObservation();
                itemBaselines.Add(key, observation);
                observation.Remember(current);
                return Array.Empty<PortalNotification>();
            }

            var timestamp = now ?? DateTimeOffset.Now;
            foreach (var sourceKey in current)
                if (!observation.Seen.ContainsKey(sourceKey))
                    added.Add(Create(kind, 1, timestamp, sourceKey));
            observation.Remember(current);
            if (added.Count > 0) AddAndSave(added);
        }
        if (added.Count > 0) Changed?.Invoke(this, EventArgs.Empty);
        return added.AsReadOnly();
    }

    /// <summary>
    /// Observe a complete, successfully queried list of unsubmitted reports. Unlike new
    /// submissions, existing pending reports must notify on the first successful query.
    /// Scope must identify the office/account/class and must not contain a tab ID or port.
    /// The caller must reject failed, partial, loading and unauthenticated snapshots.
    /// </summary>
    public IReadOnlyList<PortalNotification> ObservePendingFieldTripReports(
        IReadOnlyList<NotificationSourceItem>? items, string scope, DateTimeOffset? now = null)
    {
        if (!IsValid(NotificationKind.FieldTripReport, scope) || items is null)
            return Array.Empty<PortalNotification>();
        var current = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            // Validate the entire snapshot before remembering any report. Ignore Summary
            // so source content can never reach the popup, notification history or disk.
            if (item is null || string.IsNullOrWhiteSpace(item.Id) || item.Id.Length > 2048)
                return Array.Empty<PortalNotification>();
            current.Add(Fingerprint(NotificationKind.FieldTripReport, scope, item.Id));
        }

        List<PortalNotification> added = [];
        bool persistenceChanged;
        lock (syncRoot)
        {
            // An unreadable existing store may contain the very same report keys. Keep
            // that file intact and defer these alerts until a restart can read it safely.
            if (initialReadFailed) return Array.Empty<PortalNotification>();
            var previousPersistenceError = hasPersistenceError;
            var previousEntries = entries.ToArray();
            List<string> newReportKeys = [];
            var timestamp = now ?? DateTimeOffset.Now;
            foreach (var sourceKey in current)
                if (notifiedFieldTripReports.Add(sourceKey))
                {
                    newReportKeys.Add(sourceKey);
                    added.Add(Create(NotificationKind.FieldTripReport, 1, timestamp, sourceKey));
                }
            if (added.Count > 0)
            {
                AddAndSave(added);
                if (hasPersistenceError)
                {
                    // Publish pending-report alerts only after their deduplication keys are
                    // durable. Otherwise a restart after a failed write would alert twice.
                    entries.Clear();
                    entries.AddRange(previousEntries);
                    foreach (var sourceKey in newReportKeys) notifiedFieldTripReports.Remove(sourceKey);
                    added.Clear();
                }
            }
            else if (hasPersistenceError) Save(); // Retry a transient write failure without repeating a popup.
            persistenceChanged = previousPersistenceError != hasPersistenceError;
        }
        if (added.Count > 0 || persistenceChanged) Changed?.Invoke(this, EventArgs.Empty);
        return added.AsReadOnly();
    }

    /// <summary>
    /// Observe a complete successful list of absence reports awaiting receipt. Existing
    /// reports notify on the first Korea-day observation; new IDs notify during that day.
    /// Scope must identify the office/account/school, excluding browser and class filters.
    /// Failed, partial, loading and unauthenticated snapshots must never reach this method.
    /// </summary>
    public IReadOnlyList<PortalNotification> ObservePendingAbsenceReports(
        IReadOnlyList<NotificationSourceItem>? items, string scope, DateTimeOffset? now = null)
    {
        if (!IsValid(NotificationKind.AbsencePending, scope) || items is null)
            return Array.Empty<PortalNotification>();
        var current = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (item is null || string.IsNullOrWhiteSpace(item.Id) || item.Id.Length > 2048)
                return Array.Empty<PortalNotification>();
            // The source summary is intentionally ignored, including for notifications.
            current.Add(Fingerprint(NotificationKind.AbsencePending, scope, item.Id));
        }
        var timestamp = now ?? DateTimeOffset.Now;
        DateOnly day;
        try { day = DateOnly.FromDateTime(timestamp.ToOffset(TimeSpan.FromHours(9)).DateTime); }
        catch (ArgumentOutOfRangeException) { return Array.Empty<PortalNotification>(); }
        var oldestDay = DateOnly.FromDayNumber(Math.Max(0, day.DayNumber - PendingAbsenceRetentionDays + 1));
        List<PortalNotification> added = [];
        bool persistenceChanged;
        lock (syncRoot)
        {
            if (initialReadFailed) return Array.Empty<PortalNotification>();
            var previousPersistenceError = hasPersistenceError;
            var previousEntries = entries.ToArray();
            // Retained sets are immutable during this transaction, so restoring these
            // references also restores pruned dates after an unsuccessful atomic write.
            var previousDays = notifiedPendingAbsenceDays.ToArray();
            var pruned = false;
            foreach (var date in notifiedPendingAbsenceDays.Keys
                .Where(date => date < oldestDay || date > day).ToArray())
                pruned |= notifiedPendingAbsenceDays.Remove(date);
            notifiedPendingAbsenceDays.TryGetValue(day, out var previousToday);
            var today = previousToday is null
                ? new HashSet<string>(StringComparer.Ordinal)
                : new HashSet<string>(previousToday, StringComparer.Ordinal);
            var newCount = 0;
            foreach (var key in current)
                if (today.Add(key)) newCount++;
            if (newCount > 0)
            {
                notifiedPendingAbsenceDays[day] = today;
                added.Add(Create(NotificationKind.AbsencePending, newCount, timestamp));
                AddAndSave(added);
            }
            else if (pruned || hasPersistenceError) Save();
            if (hasPersistenceError)
            {
                // Display only alerts whose deduplication keys are durable. A retry
                // must still observe every report that was never successfully published.
                entries.Clear();
                entries.AddRange(previousEntries);
                notifiedPendingAbsenceDays.Clear();
                foreach (var pair in previousDays) notifiedPendingAbsenceDays.Add(pair.Key, pair.Value);
                added.Clear();
            }
            persistenceChanged = previousPersistenceError != hasPersistenceError;
        }
        if (added.Count > 0 || persistenceChanged) Changed?.Invoke(this, EventArgs.Empty);
        return added.AsReadOnly();
    }

    public void MarkRead(string id)
    {
        bool changed;
        lock (syncRoot)
        {
            var index = entries.FindIndex(entry => entry.Id == id && !entry.IsRead);
            changed = index >= 0;
            if (changed)
            {
                entries[index] = entries[index] with { IsRead = true };
                Save();
            }
        }
        if (changed) Changed?.Invoke(this, EventArgs.Empty);
    }

    public void MarkAllRead()
    {
        bool changed;
        lock (syncRoot)
        {
            changed = entries.Any(entry => !entry.IsRead);
            if (changed)
            {
                for (var index = 0; index < entries.Count; index++)
                    if (!entries[index].IsRead) entries[index] = entries[index] with { IsRead = true };
                Save();
            }
        }
        if (changed) Changed?.Invoke(this, EventArgs.Empty);
    }

    public void ClearRead()
    {
        bool changed;
        lock (syncRoot)
        {
            changed = entries.RemoveAll(entry => entry.IsRead) > 0;
            if (changed) Save();
        }
        if (changed) Changed?.Invoke(this, EventArgs.Empty);
    }

    // Do not call this for read failures or a temporary disconnection. Reset only when the
    // user intentionally changes accounts or monitoring targets; history remains available.
    public void ResetObservations()
    {
        lock (syncRoot)
        {
            countBaselines.Clear();
            itemBaselines.Clear();
        }
    }

    private static bool IsValid(NotificationKind kind, string? scope) =>
        Enum.IsDefined(kind) && !string.IsNullOrWhiteSpace(scope) && scope.Length <= 2048;

    private static string Fingerprint(NotificationKind kind, string scope, string id) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{(int)kind}:{scope.Length}:{scope}:{id}")));

    private static PortalNotification Create(
        NotificationKind kind, int count, DateTimeOffset now, string? sourceKey = null,
        string? id = null, bool isRead = false)
    {
        var (title, message) = kind switch
        {
            NotificationKind.Approval => ("결재대기 증가", $"화면의 결재대기 건수가 {count}건 늘었습니다. 결재대기 목록에서 확인해 주세요."),
            NotificationKind.FieldTrip => ("교외체험학습 신청", $"새 교외체험학습 신청서가 {count}건 제출되었습니다."),
            NotificationKind.Absence => ("결석신고서 제출", $"새 결석신고서가 {count}건 제출되었습니다."),
            NotificationKind.FieldTripReport => ("교외체험학습 보고서 미상신", $"미상신 교외체험학습 보고서가 {count}건 있습니다. 보고서관리에서 확인해 주세요."),
            NotificationKind.AbsencePending => ("결석신고서 접수대기", $"접수대기 중인 결석신고서가 {count}건 있습니다. 결석신고서관리에서 확인해 주세요."),
            _ => throw new ArgumentOutOfRangeException(nameof(kind)),
        };
        return new PortalNotification(id ?? Guid.NewGuid().ToString("N"), kind, title, message, now, isRead, sourceKey)
            { ItemCount = count };
    }

    private void AddAndSave(IReadOnlyList<PortalNotification> added)
    {
        // Insert newer arrivals ahead of earlier arrivals even if their observed times tie.
        entries.InsertRange(0, added.Reverse());
        var sorted = entries.OrderByDescending(entry => entry.CreatedAt).Take(MaximumEntries).ToList();
        entries.Clear();
        entries.AddRange(sorted);
        Save();
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(storagePath)) return;
            if (new FileInfo(storagePath).Length > MaximumStoreBytes) throw new JsonException();
            var store = JsonSerializer.Deserialize<NotificationStore>(File.ReadAllText(storagePath));
            if (store is null || store.Version != 1 || store.Entries is null
                || store.Entries.Count > MaximumEntries) throw new JsonException();
            var ids = new HashSet<string>(StringComparer.Ordinal);
            foreach (var entry in store.Entries)
            {
                if (entry is null || !Guid.TryParseExact(entry.Id, "N", out _) || !ids.Add(entry.Id)
                    || !Enum.IsDefined(entry.Kind) || entry.ItemCount < 1
                    || entry.CreatedAt == default) throw new JsonException();
            }
            var reportKeys = new HashSet<string>(StringComparer.Ordinal);
            foreach (var fingerprint in store.NotifiedFieldTripReportFingerprints ?? [])
            {
                if (fingerprint is null || fingerprint.Length != 64
                    || fingerprint.Any(character => !(character is >= '0' and <= '9' or >= 'A' and <= 'F'))
                    || !reportKeys.Add(fingerprint)) throw new JsonException();
            }
            var absenceDays = new Dictionary<DateOnly, HashSet<string>>();
            if (store.NotifiedPendingAbsenceDays?.Count > PendingAbsenceRetentionDays) throw new JsonException();
            foreach (var bucket in store.NotifiedPendingAbsenceDays ?? [])
            {
                if (bucket is null || bucket.Fingerprints is null || bucket.Fingerprints.Count == 0
                    || absenceDays.ContainsKey(bucket.Date)) throw new JsonException();
                var fingerprints = new HashSet<string>(StringComparer.Ordinal);
                foreach (var fingerprint in bucket.Fingerprints)
                    if (fingerprint is null || fingerprint.Length != 64
                        || fingerprint.Any(character => !(character is >= '0' and <= '9' or >= 'A' and <= 'F'))
                        || !fingerprints.Add(fingerprint)) throw new JsonException();
                absenceDays.Add(bucket.Date, fingerprints);
            }
            entries.AddRange(store.Entries.OrderByDescending(entry => entry.CreatedAt)
                .Select(entry => Create(entry.Kind, entry.ItemCount, entry.CreatedAt,
                    id: entry.Id, isRead: entry.IsRead)));
            notifiedFieldTripReports.UnionWith(reportKeys);
            foreach (var pair in absenceDays) notifiedPendingAbsenceDays.Add(pair.Key, pair.Value);
        }
        catch (JsonException)
        {
            entries.Clear();
            notifiedFieldTripReports.Clear();
            notifiedPendingAbsenceDays.Clear();
            AppLogger.Info("Notifications", "알림 기록 형식을 확인할 수 없어 빈 기록으로 복구합니다.");
            Save();
        }
        catch (Exception exception) when (IsStorageException(exception))
        {
            initialReadFailed = true;
            hasPersistenceError = true;
            // Exception messages may contain file paths or deserialized source text.
            AppLogger.Info("Notifications", $"알림 기록을 읽지 못했습니다. 오류 종류={exception.GetType().Name}");
        }
    }

    private void Save()
    {
        // A temporarily unreadable existing store may contain older unread alerts.
        // Preserve that file until a fresh start can load it instead of replacing it with
        // this session's incomplete history after the lock or access problem disappears.
        if (initialReadFailed) return;
        string? temporaryPath = null;
        try
        {
            var directory = Path.GetDirectoryName(storagePath)!;
            Directory.CreateDirectory(directory);
            temporaryPath = Path.Combine(directory, $".notifications-{Guid.NewGuid():N}.tmp");
            var store = new NotificationStore(1, entries.Select(entry => new StoredNotification(
                entry.Id, entry.Kind, entry.CreatedAt, entry.IsRead, entry.ItemCount)).ToList(),
                notifiedFieldTripReports.Count == 0 ? null : notifiedFieldTripReports.Order(StringComparer.Ordinal).ToList(),
                notifiedPendingAbsenceDays.Count == 0 ? null : notifiedPendingAbsenceDays.OrderBy(pair => pair.Key)
                    .Select(pair => new StoredPendingAbsenceDay(pair.Key, pair.Value.Order(StringComparer.Ordinal).ToList())).ToList());
            using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, store);
                // Never replace a valid store with a file the next startup would reject.
                if (stream.Length > MaximumStoreBytes) throw new IOException("알림 기록 저장 한도를 초과했습니다.");
                stream.Flush(flushToDisk: true);
            }
            if (File.Exists(storagePath)) File.Replace(temporaryPath, storagePath, null);
            else File.Move(temporaryPath, storagePath);
            hasPersistenceError = false;
        }
        catch (Exception exception) when (IsStorageException(exception))
        {
            hasPersistenceError = true;
            // Keep in-memory notifications usable when a disk is temporarily unavailable.
            AppLogger.Info("Notifications", $"알림 기록을 저장하지 못했습니다. 오류 종류={exception.GetType().Name}");
        }
        finally
        {
            if (temporaryPath is not null)
            {
                try { File.Delete(temporaryPath); }
                catch (Exception exception) when (IsStorageException(exception)) { }
            }
        }
    }

    private static bool IsStorageException(Exception exception) => exception is
        IOException or UnauthorizedAccessException or System.Security.SecurityException or NotSupportedException;

    private readonly record struct ObservationKey(NotificationKind Kind, string Scope);
    private sealed record NotificationStore(int Version, List<StoredNotification> Entries,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        List<string>? NotifiedFieldTripReportFingerprints = null,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
        List<StoredPendingAbsenceDay>? NotifiedPendingAbsenceDays = null);
    private sealed record StoredPendingAbsenceDay(DateOnly Date, List<string> Fingerprints);
    private sealed record StoredNotification(
        string Id, NotificationKind Kind, DateTimeOffset CreatedAt, bool IsRead, int ItemCount);

    private sealed class ItemObservation
    {
        public Dictionary<string, long> Seen { get; } = new(StringComparer.Ordinal);
        private long sequence;

        public void Remember(HashSet<string> current)
        {
            foreach (var id in current) Seen[id] = ++sequence;
            // Keep all currently present IDs to avoid repeated alerts for a large stable list.
            // Older absent IDs are evicted after 1,000 remembered IDs. Such an evicted ID can
            // notify again if it returns later in this session; readers should prefer a stable,
            // recent complete list. No seen IDs or observation scopes are written to disk.
            var overflow = Seen.Count - Math.Max(MaximumRememberedItems, current.Count);
            if (overflow <= 0) return;
            foreach (var id in Seen.Where(pair => !current.Contains(pair.Key))
                .OrderBy(pair => pair.Value).Take(overflow).Select(pair => pair.Key).ToArray())
                Seen.Remove(id);
        }
    }
}
