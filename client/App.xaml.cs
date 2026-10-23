namespace CloudBridge.Client;

public partial class App : System.Windows.Application
{
    private Mutex? _singleInstance;
    private bool _ownsSingleInstance;

    protected override void OnStartup(System.Windows.StartupEventArgs e)
    {
        WaitForPreviousInstance(e.Args);
        _singleInstance = new Mutex(initiallyOwned: true, @"Local\YiseCloudBridge.Client.v2", out var created);
        _ownsSingleInstance = created;
        if (!created)
        {
            System.Windows.MessageBox.Show(
                "壹色云桥已经在运行，请从任务栏右下角托盘打开。",
                "壹色云桥",
                System.Windows.MessageBoxButton.OK,
                System.Windows.MessageBoxImage.Information);
            Shutdown();
            return;
        }
        var result = ClientConfiguration.Load();
        if (!result.IsReady)
        {
            System.Windows.MessageBox.Show(
                $"{result.Message}\n\n本机配置文件：{ClientConfiguration.SettingsPath}\n\n请向管理员确认 HTTPS 服务地址，配置后重新启动客户端。",
                "壹色云桥 · 服务地址配置",
                System.Windows.MessageBoxButton.OK,
                System.Windows.MessageBoxImage.Warning);
            Shutdown();
            return;
        }
        // Validate before constructing the window, device identities, transport, or update flow.
        base.OnStartup(e);
        MainWindow = new MainWindow(result.Configuration!);
        MainWindow.Show();
    }

    protected override void OnExit(System.Windows.ExitEventArgs e)
    {
        if (_ownsSingleInstance)
        {
            _singleInstance?.ReleaseMutex();
            _ownsSingleInstance = false;
        }
        _singleInstance?.Dispose();
        _singleInstance = null;
        base.OnExit(e);
    }

    private static void WaitForPreviousInstance(IEnumerable<string> arguments)
    {
        var value = arguments.FirstOrDefault(argument =>
            argument.StartsWith("--wait-for-pid=", StringComparison.OrdinalIgnoreCase));
        if (value is null || !int.TryParse(value["--wait-for-pid=".Length..], out var processId)) return;
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(processId);
            process.WaitForExit(15_000);
        }
        catch (ArgumentException) { }
    }
}
