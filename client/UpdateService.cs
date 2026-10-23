using System.Diagnostics;
using System.IO;
using System.Reflection;

namespace CloudBridge.Client;

public sealed class UpdateService
{
    public static string CurrentVersion =>
        Assembly.GetEntryAssembly()?.GetName().Version is { } version
            ? $"{version.Major}.{version.Minor}.{version.Build}"
            : "0.0.0";

    public async Task DownloadAndLaunchAsync(
        ClientUpdatePolicy policy,
        IProgress<UpdateProgress>? progress = null,
        CancellationToken token = default)
    {
        if (!Uri.TryCreate(policy.DownloadUrl, UriKind.Absolute, out var downloadUri) || downloadUri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("更新下载地址无效");
        if (policy.Sha256 is not { Length: 64 } || policy.Sha256.Any(character => !Uri.IsHexDigit(character)))
            throw new InvalidOperationException("更新文件校验值无效");
        if (policy.FileSize <= 0)
            throw new InvalidOperationException("更新文件大小无效");

        var updaterPath = Path.Combine(AppContext.BaseDirectory, "CloudBridge.Updater.exe");
        if (!File.Exists(updaterPath))
            throw new InvalidOperationException("自动更新组件缺失，请重新下载完整客户端");

        var updateDirectory = Path.Combine(Path.GetTempPath(), "YiseCloudBridge", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(updateDirectory);
        var packagePath = Path.Combine(updateDirectory, "update.zip");
        var temporaryUpdater = Path.Combine(updateDirectory, "CloudBridge.Updater.exe");

        try
        {
            using var http = ControlTransport.CreateClient(useProxy: true);
            using var directHttp = ControlTransport.CreateClient();
            await UpdatePackageDownloader.DownloadAsync(http, downloadUri, packagePath, policy, progress, token, fallbackHttp: directHttp);

            File.Copy(updaterPath, temporaryUpdater, true);
            var requiresElevation = !CanWriteInstallationDirectory();
            var startInfo = new ProcessStartInfo(temporaryUpdater)
            {
                UseShellExecute = requiresElevation,
                Verb = requiresElevation ? "runas" : "",
            };
            startInfo.ArgumentList.Add("--apply");
            startInfo.ArgumentList.Add(packagePath);
            startInfo.ArgumentList.Add(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar));
            startInfo.ArgumentList.Add(Environment.ProcessId.ToString());
            startInfo.ArgumentList.Add("壹色云桥.exe");
            startInfo.ArgumentList.Add(policy.Sha256);
            startInfo.ArgumentList.Add(policy.FileSize.ToString(System.Globalization.CultureInfo.InvariantCulture));
            _ = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动自动更新组件");
        }
        catch
        {
            try { Directory.Delete(updateDirectory, true); } catch { }
            throw;
        }
    }

    private static bool CanWriteInstallationDirectory()
    {
        var probe = Path.Combine(AppContext.BaseDirectory, $".update-write-{Guid.NewGuid():N}.tmp");
        try
        {
            File.WriteAllText(probe, "update-check");
            File.Delete(probe);
            return true;
        }
        catch
        {
            try { File.Delete(probe); } catch { }
            return false;
        }
    }
}
