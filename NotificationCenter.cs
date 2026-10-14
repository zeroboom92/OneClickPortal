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
/// Observation baselines exist only in memory: the first valid snapshot after starting or
/// explicitly resetting establishes a baseline, including an empty snapshot.
/// Callers must reject failed, incomplete or unauthenticated snapshots before observing them.
/// </summary>
internal sealed class NotificationCenter
{
    internal const int MaximumEntries = 300;
    internal const int MaximumRememberedItems = 1000;
    private const int MaximumStoreBytes = 1024 * 1024;
    private readonly object syncRoot = new();
    private readonly string storagePath;
    private readonly List<PortalNotification> entries = [];
    private readonly Dictionary<ObservationKey, int> countBaselines = [];
    private readonly Dictionary<ObservationKey, ItemObservation> itemBaselines = [];
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
            entries.AddRange(store.Entries.OrderByDescending(entry => entry.CreatedAt)
                .Select(entry => Create(entry.Kind, entry.ItemCount, entry.CreatedAt,
                    id: entry.Id, isRead: entry.IsRead)));
        }
        catch (JsonException)
        {
            entries.Clear();
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
                entry.Id, entry.Kind, entry.CreatedAt, entry.IsRead, entry.ItemCount)).ToList());
            using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write,
                FileShare.None, 4096, FileOptions.WriteThrough))
            {
                JsonSerializer.Serialize(stream, store);
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
    private sealed record NotificationStore(int Version, List<StoredNotification> Entries);
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
