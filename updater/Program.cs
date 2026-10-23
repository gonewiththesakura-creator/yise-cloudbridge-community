using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;

// Keep five-argument compatibility with older published clients.
if (args.Length is not (5 or 7) || args[0] != "--apply" || !int.TryParse(args[3], out var parentProcessId)) return;

var packagePath = Path.GetFullPath(args[1]);
var targetDirectory = Path.GetFullPath(args[2]);
var executableName = Path.GetFileName(args[4]);
var workDirectory = Path.Combine(Path.GetDirectoryName(packagePath)!, "extracted");
var backupDirectory = Path.Combine(Path.GetDirectoryName(packagePath)!, "backup");
var copiedTargets = new List<string>();
var backedUpTargets = new List<(string Target, string Backup)>();

try
{
    if (executableName != "壹色云桥.exe" || targetDirectory == Path.GetPathRoot(targetDirectory))
        throw new InvalidDataException("更新目标目录无效");
    if (args.Length == 7)
    {
        if (!long.TryParse(args[6], out var expectedSize) || expectedSize <= 0 ||
            new FileInfo(packagePath).Length != expectedSize || args[5].Length != 64)
            throw new InvalidDataException("更新包长度校验失败");
        await using var package = File.OpenRead(packagePath);
        var hash = Convert.ToHexString(await SHA256.HashDataAsync(package));
        if (!hash.Equals(args[5], StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("更新包安全校验失败");
    }

    try
    {
        using var parent = Process.GetProcessById(parentProcessId);
        await parent.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(30));
    }
    catch (ArgumentException) { }

    Directory.CreateDirectory(workDirectory);
    ZipFile.ExtractToDirectory(packagePath, workDirectory, true);
    var newExecutable = Path.Combine(workDirectory, executableName);
    if (!File.Exists(newExecutable)) throw new InvalidDataException("更新包缺少主程序");
    if (!File.Exists(Path.Combine(targetDirectory, executableName)))
        throw new InvalidDataException("目标目录不是壹色云桥程序目录");

    var targetRoot = targetDirectory.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
    var stagedFiles = new List<(string Source, string Target, string Relative)>();
    var targets = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var sourcePath in Directory.EnumerateFiles(workDirectory, "*", SearchOption.AllDirectories))
    {
        var relativePath = Path.GetRelativePath(workDirectory, sourcePath);
        var targetPath = Path.GetFullPath(Path.Combine(targetDirectory, relativePath));
        if (!targetPath.StartsWith(targetRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("更新包包含非法路径");
        if (!targets.Add(targetPath)) throw new InvalidDataException("更新包包含重复路径");
        // Existing junctions must not redirect writes outside the installation.
        for (var current = targetPath; current is not null; current = Path.GetDirectoryName(current))
        {
            if ((File.Exists(current) || Directory.Exists(current)) &&
                (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("安装目录包含重定向路径，请使用完整客户端重新安装");
        }
        stagedFiles.Add((sourcePath, targetPath, relativePath));
    }

    // Finish every backup before replacing the first installed file.
    foreach (var (_, targetPath, relativePath) in stagedFiles)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);
        if (File.Exists(targetPath))
        {
            var backupPath = Path.Combine(backupDirectory, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(backupPath)!);
            File.Copy(targetPath, backupPath, true);
            backedUpTargets.Add((targetPath, backupPath));
        }
    }
    foreach (var (sourcePath, targetPath, _) in stagedFiles)
    {
        if (!File.Exists(targetPath)) copiedTargets.Add(targetPath);
        File.Copy(sourcePath, targetPath, true);
    }

    var startInfo = new ProcessStartInfo(Path.Combine(targetDirectory, executableName))
    {
        WorkingDirectory = targetDirectory,
        UseShellExecute = true,
    };
    startInfo.ArgumentList.Add("--updated");
    _ = Process.Start(startInfo) ?? throw new InvalidOperationException("无法启动更新后的客户端");
    // The updater itself runs in the temporary directory; retain only that
    // running executable and remove packages/backups after successful launch.
    try { Directory.Delete(workDirectory, true); } catch { }
    try { Directory.Delete(backupDirectory, true); } catch { }
    try { File.Delete(packagePath); } catch { }
}
catch (Exception exception)
{
    foreach (var targetPath in copiedTargets.AsEnumerable().Reverse())
    {
        try { File.Delete(targetPath); } catch { }
    }
    foreach (var (target, backup) in backedUpTargets.AsEnumerable().Reverse())
    {
        try { File.Copy(backup, target, true); } catch { }
    }
    var errorPath = Path.Combine(Path.GetTempPath(), "YiseCloudBridge-update-error.txt");
    try { await File.WriteAllTextAsync(errorPath, $"{DateTimeOffset.Now:O}\n{exception}"); } catch { }
    try
    {
        Process.Start(new ProcessStartInfo("msg.exe")
        {
            UseShellExecute = false,
            ArgumentList = { "*", $"壹色云桥更新失败，已尝试恢复原版本。请重新下载完整客户端。详情：{errorPath}" },
        });
    }
    catch { }
    try
    {
        Process.Start(new ProcessStartInfo(Path.Combine(targetDirectory, executableName))
        {
            WorkingDirectory = targetDirectory,
            UseShellExecute = true,
        });
    }
    catch { }
}
