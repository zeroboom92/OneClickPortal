using System;
using System.Windows.Forms;
using Velopack;

namespace BrowserThumbnailPrototype;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        VelopackApp.Build().Run();
        ApplicationConfiguration.Initialize();
        using var mainForm = new MainForm();
        mainForm.Shown += async (_, _) => await AppUpdater.CheckForUpdatesAsync();
        mainForm.Show();
        Application.Run(mainForm);
    }
}
