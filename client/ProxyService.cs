using Microsoft.Win32;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace CloudBridge.Client;

public sealed class ProxyService : IDisposable
{
    private const string InternetSettings = @"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    private readonly MtlsTunnelService _tunnel = new();
    private readonly TrafficMeterService _meter = new();
    private readonly string _runtimeDirectory;
    private readonly string _configPath;
    private readonly string _proxyStatePath;
    private readonly string _transportCertificatePath;
    private readonly string _transportKeyPath;
    private readonly object _diagnosticLock = new();
    private readonly Queue<string> _recentDiagnostics = new();
    private readonly bool _temporary;
    private Process? _process;
    private ProxySnapshot? _previousProxy;
    private int _localPort;
    private int _corePort;
    private int _clashApiPort;
    private bool _systemProxyEnabled;

    public ProxyService() : this(recoverStaleProxy: true, temporary: false) { }

    private ProxyService(bool recoverStaleProxy, bool temporary)
    {
        _temporary = temporary;
        var name = temporary ? $"probe-{Guid.NewGuid():N}" : "runtime";
        _runtimeDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CloudBridge", name);
        _configPath = Path.Combine(_runtimeDirectory, "config.json");
        _proxyStatePath = Path.Combine(_runtimeDirectory, "proxy-state.json");
        _transportCertificatePath = Path.Combine(_runtimeDirectory, "transport-cert.pem");
        _transportKeyPath = Path.Combine(_runtimeDirectory, "transport-key.pem");
        _tunnel.Log += RecordDiagnostic;
        if (recoverStaleProxy) RecoverStaleSystemProxy();
    }

    public bool IsRunning => _process is { HasExited: false };
    public int LocalPort => _localPort;
    public ProxyProtocol ActiveProtocol { get; private set; } = ProxyProtocol.Vless;
    public ProxyMode ActiveMode { get; private set; } = ProxyMode.BypassChina;
    public TrafficSnapshot Traffic => _meter.Snapshot;
    public event Action<string>? Log;

    public async Task StartAsync(
        RenewProfile profile,
        DeviceIdentity identity,
        TransportIdentity transportIdentity,
        ProxyProtocol protocol,
        ProxyMode mode = ProxyMode.BypassChina,
        bool enableSystemProxy = true,
        CancellationToken token = default)
    {
        Stop();
        var executable = Path.Combine(AppContext.BaseDirectory, "core", "sing-box.exe");
        if (!File.Exists(executable)) throw new FileNotFoundException("代理核心缺失，请重新安装壹色云桥客户端", executable);
        if (protocol == ProxyProtocol.Tuic && !TuicAvailable(profile))
            throw new InvalidOperationException("TUIC 线路尚未由服务器启用");

        try
        {
            Directory.CreateDirectory(_runtimeDirectory);
            ActiveProtocol = protocol;
            ActiveMode = mode;
            _corePort = FindAvailablePort();
            _localPort = FindAvailablePort(_corePort);
            _clashApiPort = FindAvailablePort(_corePort, _localPort);

            var tunnelPort = 0;
            if (protocol == ProxyProtocol.Vless)
            {
                _tunnel.Start(profile, identity);
                tunnelPort = _tunnel.LocalPort;
            }
            else
            {
                await File.WriteAllTextAsync(_transportCertificatePath, profile.TransportCertificatePem, token);
                await File.WriteAllTextAsync(_transportKeyPath, transportIdentity.ExportPrivateKeyPem(), token);
            }

            await File.WriteAllTextAsync(_configPath, BuildConfig(profile, protocol, mode, tunnelPort, _corePort, _clashApiPort), token);
            await ValidateConfigAsync(executable, token);
            StartCore(executable);
            await Task.Delay(550, token);
            if (_process is not { HasExited: false }) throw new InvalidOperationException("代理核心启动后立即退出");

            if (mode == ProxyMode.GlobalTun) _meter.StartClashApi(_clashApiPort);
            else _meter.Start(_localPort, _corePort);
            await VerifyConnectivityAsync(token);
            if (enableSystemProxy && mode == ProxyMode.BypassChina)
            {
                EnableSystemProxy();
                _systemProxyEnabled = true;
            }
            DeleteRuntimeSecrets();
        }
        catch
        {
            Stop();
            throw;
        }
    }

    public static async Task<RouteTestResult> TestRouteAsync(
        RenewProfile profile,
        DeviceIdentity identity,
        TransportIdentity transportIdentity,
        ProxyProtocol protocol,
        CancellationToken token = default)
    {
        if (protocol == ProxyProtocol.Tuic && !TuicAvailable(profile))
            return new RouteTestResult(protocol, false, 0, 0, "服务器尚未启用");

        using var probe = new ProxyService(recoverStaleProxy: false, temporary: true);
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
            timeout.CancelAfter(TimeSpan.FromSeconds(28));
            var routeToken = timeout.Token;
            await probe.StartAsync(profile, identity, transportIdentity, protocol,
                ProxyMode.BypassChina, enableSystemProxy: false, routeToken);
            using var handler = new SocketsHttpHandler
            {
                Proxy = new WebProxy($"http://127.0.0.1:{probe.LocalPort}"),
                UseProxy = true,
                ConnectTimeout = TimeSpan.FromSeconds(8),
            };
            using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(20) };

            var latencyWatch = Stopwatch.StartNew();
            using (var response = await http.GetAsync("https://www.gstatic.com/generate_204", HttpCompletionOption.ResponseHeadersRead, routeToken))
                response.EnsureSuccessStatusCode();
            latencyWatch.Stop();

            const int testBytes = 2 * 1024 * 1024;
            var speedWatch = Stopwatch.StartNew();
            long received = 0;
            using (var response = await http.GetAsync($"https://speed.cloudflare.com/__down?bytes={testBytes}", HttpCompletionOption.ResponseHeadersRead, routeToken))
            {
                response.EnsureSuccessStatusCode();
                await using var stream = await response.Content.ReadAsStreamAsync(routeToken);
                var buffer = new byte[64 * 1024];
                while (received < testBytes)
                {
                    var read = await stream.ReadAsync(buffer, routeToken);
                    if (read == 0) break;
                    received += read;
                }
            }
            speedWatch.Stop();
            var mbps = received * 8d / Math.Max(0.001, speedWatch.Elapsed.TotalSeconds) / 1_000_000d;
            return new RouteTestResult(protocol, true, latencyWatch.Elapsed.TotalMilliseconds, mbps);
        }
        catch (Exception error)
        {
            var message = error is OperationCanceledException ? "测速超时" : FriendlyError(error.Message);
            return new RouteTestResult(protocol, false, 0, 0, message);
        }
    }

    public void UpdateCertificate(RenewProfile profile, DeviceIdentity identity)
    {
        if (ActiveProtocol == ProxyProtocol.Vless) _tunnel.UpdateCertificate(profile, identity);
    }

    public void Stop()
    {
        if (_systemProxyEnabled) RestoreSystemProxy();
        _systemProxyEnabled = false;
        _meter.Stop();
        if (_process is { HasExited: false })
        {
            try
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(2000);
            }
            catch (InvalidOperationException) { }
        }
        _process?.Dispose();
        _process = null;
        _tunnel.Stop();
        _localPort = 0;
        _corePort = 0;
        _clashApiPort = 0;
        DeleteRuntimeSecrets();
        if (_temporary)
        {
            try { if (Directory.Exists(_runtimeDirectory)) Directory.Delete(_runtimeDirectory, recursive: true); }
            catch (IOException) { }
        }
    }

    private static bool TuicAvailable(RenewProfile profile) =>
        profile.Protocols.Tuic is { Uuid.Length: > 0, Password.Length: > 0 } &&
        !string.IsNullOrWhiteSpace(profile.TransportCertificatePem);

    private string BuildConfig(RenewProfile profile, ProxyProtocol protocol, ProxyMode mode, int tunnelPort, int localPort, int clashApiPort)
    {
        Dictionary<string, object?> outbound;
        if (protocol == ProxyProtocol.Vless)
        {
            outbound = new Dictionary<string, object?>
            {
                ["type"] = "vless", ["tag"] = "selected", ["server"] = "127.0.0.1",
                ["server_port"] = tunnelPort, ["uuid"] = profile.Protocols.Vless.Uuid,
                ["network"] = "tcp",
                ["multiplex"] = new { enabled = true, protocol = "smux", max_connections = 1, min_streams = 4 },
            };
        }
        else
        {
            var tuic = profile.Protocols.Tuic!;
            outbound = new Dictionary<string, object?>
            {
                ["type"] = "tuic", ["tag"] = "selected", ["server"] = profile.Server.Host,
                ["server_port"] = tuic.ServerPort, ["uuid"] = tuic.Uuid, ["password"] = tuic.Password,
                ["congestion_control"] = tuic.CongestionControl,
                ["udp_relay_mode"] = "native", ["zero_rtt_handshake"] = false,
                ["heartbeat"] = "10s",
                ["tls"] = new
                {
                    enabled = true,
                    server_name = string.IsNullOrWhiteSpace(tuic.ServerName) ? profile.Server.ServerName : tuic.ServerName,
                    alpn = new[] { "h3" },
                    min_version = "1.3",
                    client_certificate_path = _transportCertificatePath,
                    client_key_path = _transportKeyPath,
                },
            };
        }

        var inbounds = new List<object>
        {
            new { type = "mixed", tag = "local", listen = "127.0.0.1", listen_port = localPort },
        };
        if (mode == ProxyMode.GlobalTun)
        {
            inbounds.Add(new
            {
                type = "tun", tag = "tun-in", interface_name = "YiseCloudBridge",
                address = new[] { "172.19.0.1/30" }, mtu = 1400,
                auto_route = true, strict_route = true, stack = "mixed",
            });
        }

        var routeRules = new List<object> { new { action = "sniff" } };
        if (mode == ProxyMode.GlobalTun)
            routeRules.Add(new { protocol = "dns", action = "hijack-dns" });
        routeRules.Add(new { ip_is_private = true, action = "route", outbound = "direct" });
        if (mode == ProxyMode.BypassChina)
            routeRules.Add(new { rule_set = new[] { "geosite-cn", "geoip-cn" }, action = "route", outbound = "direct" });

        var coreDirectory = Path.Combine(AppContext.BaseDirectory, "core");
        var config = new Dictionary<string, object?>
        {
            ["log"] = new { level = "warn", timestamp = true },
            ["inbounds"] = inbounds,
            ["outbounds"] = new object[] { outbound, new { type = "direct", tag = "direct" } },
            ["route"] = new
            {
                auto_detect_interface = true,
                rules = routeRules,
                rule_set = new object[]
                {
                    new { type = "local", tag = "geosite-cn", format = "binary", path = Path.Combine(coreDirectory, "geosite-cn.srs") },
                    new { type = "local", tag = "geoip-cn", format = "binary", path = Path.Combine(coreDirectory, "geoip-cn.srs") },
                },
                final = "selected",
            },
        };
        if (mode == ProxyMode.GlobalTun)
        {
            config["experimental"] = new
            {
                clash_api = new { external_controller = $"127.0.0.1:{clashApiPort}" },
            };
            config["dns"] = new
            {
                servers = new object[]
                {
                    new
                    {
                        type = "https", tag = "secure-dns", server = "1.1.1.1", server_port = 443,
                        path = "/dns-query", detour = "selected",
                        tls = new { enabled = true, server_name = "cloudflare-dns.com" },
                    },
                },
                final = "secure-dns",
                strategy = "ipv4_only",
            };
        }
        return JsonSerializer.Serialize(config, new JsonSerializerOptions { WriteIndented = true });
    }

    private async Task ValidateConfigAsync(string executable, CancellationToken token)
    {
        using var check = Process.Start(new ProcessStartInfo(executable, $"check -c \"{_configPath}\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
        }) ?? throw new InvalidOperationException("无法启动代理核心");
        var error = await check.StandardError.ReadToEndAsync(token);
        await check.WaitForExitAsync(token);
        if (check.ExitCode != 0) throw new InvalidOperationException($"代理配置校验失败：{error.Trim()}");
    }

    private void StartCore(string executable)
    {
        _process = new Process
        {
            StartInfo = new ProcessStartInfo(executable, $"run -c \"{_configPath}\"")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true,
                RedirectStandardOutput = true,
                WorkingDirectory = AppContext.BaseDirectory,
            },
            EnableRaisingEvents = true,
        };
        _process.ErrorDataReceived += (_, args) => { if (!string.IsNullOrWhiteSpace(args.Data)) RecordDiagnostic(args.Data); };
        _process.Start();
        _process.BeginErrorReadLine();
        _process.BeginOutputReadLine();
    }

    private async Task VerifyConnectivityAsync(CancellationToken token)
    {
        Exception? lastError = null;
        for (var attempt = 0; attempt < 3; attempt++)
        {
            if (_process is not { HasExited: false }) throw new InvalidOperationException("代理核心在链路自检期间退出");
            try
            {
                using var handler = new SocketsHttpHandler
                {
                    Proxy = new WebProxy($"http://127.0.0.1:{(ActiveMode == ProxyMode.GlobalTun ? _corePort : _localPort)}"),
                    UseProxy = true,
                    ConnectTimeout = TimeSpan.FromSeconds(8),
                };
                using var http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(12) };
                var trace = await http.GetStringAsync("https://www.cloudflare.com/cdn-cgi/trace", token);
                if (!trace.Split('\n').Any(line => line.StartsWith("ip=", StringComparison.Ordinal)))
                    throw new InvalidOperationException("出口检测响应无效");
                RecordDiagnostic($"{ProtocolLabel(ActiveProtocol)} 线路出口验证通过");
                return;
            }
            catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or InvalidOperationException)
            {
                lastError = exception;
                await Task.Delay(500, token);
            }
        }
        var diagnostic = LatestDiagnostic();
        var detail = string.IsNullOrWhiteSpace(diagnostic) ? lastError?.Message : diagnostic;
        throw new InvalidOperationException($"代理链路自检失败：{FriendlyError(detail ?? "无法访问生产出口")}");
    }

    private static int FindAvailablePort(params int[] excluded)
    {
        for (var port = 2080; port <= 2119; port++)
        {
            if (excluded.Contains(port)) continue;
            TcpListener? probe = null;
            try
            {
                probe = new TcpListener(IPAddress.Loopback, port);
                probe.Start();
                return port;
            }
            catch (SocketException) { }
            finally { probe?.Stop(); }
        }
        throw new InvalidOperationException("本机 2080-2119 端口均被占用，请关闭其他代理工具后重试");
    }

    private void RecordDiagnostic(string message)
    {
        var normalized = message.Trim();
        if (normalized.Length == 0) return;
        lock (_diagnosticLock)
        {
            _recentDiagnostics.Enqueue(normalized);
            while (_recentDiagnostics.Count > 12) _recentDiagnostics.Dequeue();
        }
        Log?.Invoke(normalized);
    }

    private string LatestDiagnostic()
    {
        lock (_diagnosticLock) return _recentDiagnostics.LastOrDefault() ?? "";
    }

    private void EnableSystemProxy()
    {
        using var key = Registry.CurrentUser.OpenSubKey(InternetSettings, writable: true)
            ?? throw new InvalidOperationException("无法修改 Windows 系统代理");
        _previousProxy = new ProxySnapshot(
            Convert.ToInt32(key.GetValue("ProxyEnable", 0)),
            key.GetValue("ProxyServer")?.ToString(),
            key.GetValue("ProxyOverride")?.ToString());
        Directory.CreateDirectory(_runtimeDirectory);
        File.WriteAllText(_proxyStatePath, JsonSerializer.Serialize(_previousProxy));
        key.SetValue("ProxyEnable", 1, RegistryValueKind.DWord);
        key.SetValue("ProxyServer", $"127.0.0.1:{_localPort}", RegistryValueKind.String);
        key.SetValue("ProxyOverride", "<local>", RegistryValueKind.String);
        RefreshInternetSettings();
    }

    private void RestoreSystemProxy()
    {
        if (_previousProxy is null) return;
        using var key = Registry.CurrentUser.OpenSubKey(InternetSettings, writable: true);
        if (key is not null)
        {
            key.SetValue("ProxyEnable", _previousProxy.Enabled, RegistryValueKind.DWord);
            SetOrDelete(key, "ProxyServer", _previousProxy.Server);
            SetOrDelete(key, "ProxyOverride", _previousProxy.Override);
            RefreshInternetSettings();
        }
        _previousProxy = null;
        if (File.Exists(_proxyStatePath)) File.Delete(_proxyStatePath);
    }

    private void RecoverStaleSystemProxy()
    {
        try
        {
            if (!File.Exists(_proxyStatePath)) return;
            _previousProxy = JsonSerializer.Deserialize<ProxySnapshot>(File.ReadAllText(_proxyStatePath));
            RestoreSystemProxy();
        }
        catch (IOException) { }
        catch (JsonException) { File.Delete(_proxyStatePath); }
    }

    private void DeleteRuntimeSecrets()
    {
        foreach (var path in new[] { _configPath, _transportCertificatePath, _transportKeyPath })
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch (IOException) { }
        }
    }

    private static string ProtocolLabel(ProxyProtocol protocol) => protocol == ProxyProtocol.Tuic ? "TUIC" : "VLESS";

    private static string FriendlyError(string message)
    {
        var compact = message.Replace('\r', ' ').Replace('\n', ' ').Trim();
        return compact.Length > 120 ? compact[..120] : compact;
    }

    private static void SetOrDelete(RegistryKey key, string name, string? value)
    {
        if (value is null) key.DeleteValue(name, throwOnMissingValue: false);
        else key.SetValue(name, value, RegistryValueKind.String);
    }

    private static void RefreshInternetSettings()
    {
        InternetSetOption(IntPtr.Zero, 39, IntPtr.Zero, 0);
        InternetSetOption(IntPtr.Zero, 37, IntPtr.Zero, 0);
    }

    [DllImport("wininet.dll", SetLastError = true)]
    private static extern bool InternetSetOption(IntPtr internet, int option, IntPtr buffer, int length);

    public void Dispose()
    {
        Stop();
        _meter.Dispose();
        _tunnel.Dispose();
    }

    private sealed record ProxySnapshot(int Enabled, string? Server, string? Override);
}
