namespace BrowserThumbnailPrototype;

// Times come from Environment.TickCount64, so wall-clock changes cannot affect polling.
internal sealed class ApprovalPollingSchedule
{
    private const long ActiveIntervalMilliseconds = 5_000;
    private const long BackgroundIntervalMilliseconds = 60_000;
    private long? _lastAttemptMilliseconds;
    private long? _lastFullScanMilliseconds;

    public bool IsDue(long nowMilliseconds, bool edufineActive)
    {
        var interval = edufineActive ? ActiveIntervalMilliseconds : BackgroundIntervalMilliseconds;
        return _lastAttemptMilliseconds is not long previous || nowMilliseconds - previous >= interval;
    }

    public bool RequiresFullScan(long nowMilliseconds, bool forced)
    {
        return forced || _lastFullScanMilliseconds is not long previous
            || nowMilliseconds - previous >= BackgroundIntervalMilliseconds;
    }

    public void RecordAttempt(long nowMilliseconds, bool fullScan)
    {
        _lastAttemptMilliseconds = nowMilliseconds;
        if (fullScan) _lastFullScanMilliseconds = nowMilliseconds;
    }

    public void Reset()
    {
        _lastAttemptMilliseconds = null;
        _lastFullScanMilliseconds = null;
    }
}
