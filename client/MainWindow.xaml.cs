using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Drawing = System.Drawing;
using Forms = System.Windows.Forms;

namespace CloudBridge.Client;

public partial class MainWindow : Window
{
    private DeviceIdentity _identity;
    private readonly TransportIdentity _transportIdentity = TransportIdentity.LoadOrCreate();
    private readonly ControlApiClient _api;
    private readonly ProxyService _proxy = new();
    private readonly UpdateService _updates = new();
    private readonly DispatcherTimer _renewalTimer = new() { Interval = TimeSpan.FromMinutes(5) };
    private readonly DispatcherTimer _trafficTimer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly Storyboard _connectedPulse;
    private readonly Storyboard _busySpin;
    private readonly string _statePath;
    private readonly string _usagePath;
    private ClientState? _state;
    private RenewProfile? _profile;
    private ClientUpdatePolicy? _updatePolicy;
    private ProxyProtocol _selectedProtocol = ProxyProtocol.Vless;
    private ProxyMode _selectedMode = ProxyMode.BypassChina;
    private TrafficSnapshot _lastTraffic = new(0, 0);
    private DateTimeOffset _lastTrafficAt = DateTimeOffset.UtcNow;
    private TodayUsage _todayUsage = TodayUsage.Empty;
    private bool _updateBlocked;
    private bool _updateCheckInProgress;
    private bool _busy;
    private bool _allowExit;
    private bool _disposed;
    private int _usageSaveCounter;
    private readonly Forms.NotifyIcon _trayIcon;

    public MainWindow(ClientConfiguration configuration)
    {
        _api = new ControlApiClient(configuration);
        InitializeComponent();
        // Fit smaller/high-DPI work areas without exposing resize grips or clipping controls.
        var workArea = SystemParameters.WorkArea;
        var windowScale = Math.Min(1, Math.Min((workArea.Width - 20) / Width, (workArea.Height - 20) / Height));
        if (windowScale > 0 && windowScale < 1)
        {
            Width *= windowScale;
            Height *= windowScale;
        }
        _connectedPulse = (Storyboard)FindResource("ConnectedPulse");
        _busySpin = (Storyboard)FindResource("BusySpin");
        var dataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CloudBridge");
        Directory.CreateDirectory(dataDirectory);
        _statePath = Path.Combine(dataDirectory, "device.json");
        _usagePath = Path.Combine(dataDirectory, "usage.json");
        _state = LoadState();
        _identity = DeviceIdentity.LoadOrCreate(
            _state?.KeyProviderId,
            _state is null ? null : _state.KeyId ?? DeviceIdentity.LegacyKeyId);
        _todayUsage = LoadTodayUsage();
        if (Environment.GetCommandLineArgs().Contains("--global-tun", StringComparer.OrdinalIgnoreCase))
            _selectedMode = ProxyMode.GlobalTun;
        VersionText.Text = $"v{UpdateService.CurrentVersion}";
        UpdateIdentityLabels();
        _proxy.Log += message => Dispatcher.Invoke(() => FooterText.Text = Trim(message, 105));
        _renewalTimer.Tick += async (_, _) => await RefreshWhileConnectedAsync();
        _trafficTimer.Tick += (_, _) => UpdateTraffic();
        _renewalTimer.Start();
        _trafficTimer.Start();
        ShowCurrentView();
        UpdateRouteSelection();
        UpdateModeSelection();
        UpdateTrafficLabels(0, 0, new TrafficSnapshot(0, 0));
        FooterText.Text = $"服务地址已配置 · {configuration.ApiBaseUri.Authority}";
        FooterText.ToolTip = $"配置来源：{configuration.Source}\n服务地址：{configuration.ApiBaseUri}";
        _trayIcon = CreateTrayIcon();
        Loaded += async (_, _) => await HandleLoadedAsync();
#if DEBUG
        Loaded += async (_, _) => await CaptureDebugUiAsync();
#endif
        Closing += MainWindow_Closing;
    }

    private void TitleBar_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is DependencyObject source && FindAncestor<Button>(source) is not null) return;
        if (e.LeftButton == MouseButtonState.Pressed)
            DragMove();
    }

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void CloseButton_Click(object sender, RoutedEventArgs e) => HideToTray();

    private static T? FindAncestor<T>(DependencyObject? current) where T : DependencyObject
    {
        while (current is not null)
        {
            if (current is T match) return match;
            current = VisualTreeHelper.GetParent(current);
        }
        return null;
    }

    private void ShowCurrentView()
    {
        ActivationPanel.Visibility = _state is null ? Visibility.Visible : Visibility.Collapsed;
        DashboardPanel.Visibility = _state is null ? Visibility.Collapsed : Visibility.Visible;
    }

    private async void ActivateButton_Click(object sender, RoutedEventArgs e)
    {
        if (_updateBlocked || _busy) return;
        if (!await CheckForUpdateAsync(showNetworkError: true)) return;
        var code = ActivationCodeBox.Text.Trim();
        if (code.Length < 12) { ShowError("请输入完整激活码"); return; }
        SetBusy(true, "正在绑定设备…");
        try
        {
            var enrolled = await _api.RegisterAsync(new RegisterRequest(
                code, _identity.DeviceName, _identity.FingerprintHash,
                _identity.ExportPublicKeyPem(), _identity.KeyProvider, UpdateService.CurrentVersion));
            _state = new ClientState(enrolled.DeviceId, _identity.ProviderId, _identity.PublicKeyHash, _identity.KeyId);
            SaveState(_state);
            _profile = await CompleteRenewAsync(enrolled.Nonce);
            ShowCurrentView();
            RenderProfile();
            SetConnectionState(false, "绑定成功");
        }
        catch (Exception exception) { ShowError(exception.Message); }
        finally { SetBusy(false); }
    }

    private async void ConnectButton_Click(object sender, RoutedEventArgs e)
    {
        if (_updateBlocked || _busy) return;
        if (_proxy.IsRunning)
        {
            _proxy.Stop();
            SetConnectionState(false, "已断开");
            return;
        }
        await ConnectSelectedAsync();
    }

    private async Task ConnectSelectedAsync()
    {
        if (!await CheckForUpdateAsync(showNetworkError: true)) return;
        if (_selectedMode == ProxyMode.GlobalTun && !EnsureTunPrivileges()) return;
        SetBusy(true, $"正在连接 {ProtocolName(_selectedProtocol)}…");
        try
        {
            if (_profile is null || _profile.DeviceCertificateExpiresAt < DateTimeOffset.UtcNow.AddMinutes(30))
                await RefreshProfileAsync(showError: true);
            if (_profile is null) return;
            await _proxy.StartAsync(_profile, _identity, _transportIdentity, _selectedProtocol, _selectedMode);
            SetConnectionState(true, $"已连接 · {ProtocolName(_selectedProtocol)}");
        }
        catch (Exception exception) { ShowError(exception.Message); }
        finally { SetBusy(false); }
    }

    private async void VlessRouteButton_Click(object sender, RoutedEventArgs e) =>
        await SelectRouteAsync(ProxyProtocol.Vless);

    private async void TuicRouteButton_Click(object sender, RoutedEventArgs e) =>
        await SelectRouteAsync(ProxyProtocol.Tuic);

    private async void BypassModeButton_Click(object sender, RoutedEventArgs e) =>
        await SelectModeAsync(ProxyMode.BypassChina);

    private async void GlobalModeButton_Click(object sender, RoutedEventArgs e) =>
        await SelectModeAsync(ProxyMode.GlobalTun);

    private async Task SelectModeAsync(ProxyMode mode)
    {
        if (_busy || mode == _selectedMode) return;
        var reconnect = _proxy.IsRunning;
        if (reconnect)
        {
            _proxy.Stop();
            SetConnectionState(false, "正在切换模式");
        }
        _selectedMode = mode;
        UpdateModeSelection();
        if (reconnect) await ConnectSelectedAsync();
    }

    private async Task SelectRouteAsync(ProxyProtocol protocol)
    {
        if (_busy || protocol == _selectedProtocol) return;
        if (protocol == ProxyProtocol.Tuic && !TuicAvailable()) return;
        var reconnect = _proxy.IsRunning;
        if (reconnect)
        {
            _proxy.Stop();
            SetConnectionState(false, "正在切换线路");
        }
        _selectedProtocol = protocol;
        UpdateRouteSelection();
        if (reconnect) await ConnectSelectedAsync();
    }

    private async void TestRoutesButton_Click(object sender, RoutedEventArgs e)
    {
        if (_busy) return;
        if (_proxy.IsRunning)
        {
            MessageBox.Show(this, "请先断开当前连接，再进行双线路测速。", "壹色云桥", MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }
        if (_profile is null) return;
        SetBusy(true, "正在测试线路…");
        TestRoutesText.Text = "测速中";
        VlessSpeedText.Text = "正在建立链路…";
        TuicSpeedText.Text = TuicAvailable() ? "等待测试…" : "服务端未启用";
        try
        {
            using var roundTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(58));
            var results = new List<RouteTestResult>();
            var vless = await ProxyService.TestRouteAsync(
                _profile, _identity, _transportIdentity, ProxyProtocol.Vless, roundTimeout.Token);
            results.Add(vless);
            RenderRouteTest(vless, VlessSpeedText);
            if (TuicAvailable())
            {
                TuicSpeedText.Text = "正在建立链路…";
                var tuic = await ProxyService.TestRouteAsync(
                    _profile, _identity, _transportIdentity, ProxyProtocol.Tuic, roundTimeout.Token);
                results.Add(tuic);
                RenderRouteTest(tuic, TuicSpeedText);
            }
            var recommended = results.Where(value => value.Available)
                .OrderByDescending(value => value.DownloadMbps / (1 + value.LatencyMs / 120d))
                .FirstOrDefault();
            if (recommended is not null)
            {
                _selectedProtocol = recommended.Protocol;
                UpdateRouteSelection();
                RouteHintText.Text = $"已推荐 {ProtocolName(recommended.Protocol)} · {recommended.LatencyMs:0} ms · {recommended.DownloadMbps:0.0} Mbps";
            }
            else RouteHintText.Text = "线路测速失败，具体原因已显示在线路卡片中";
        }
        catch (Exception exception)
        {
            RouteHintText.Text = $"测速已停止 · {Trim(exception.Message, 48)}";
        }
        finally
        {
            TestRoutesText.Text = "重新测速";
            SetBusy(false);
        }
    }

    private static void RenderRouteTest(RouteTestResult result, TextBlock target)
    {
        target.Text = result.Available
            ? $"{result.LatencyMs:0} ms · {result.DownloadMbps:0.0} Mbps"
            : $"不可用 · {Trim(result.Error, 30)}";
    }

    private void ResetBindingButton_Click(object sender, RoutedEventArgs e)
    {
        var result = MessageBox.Show(this,
            "请先让管理员在后台解绑当前设备。继续后将清除本机旧绑定并返回激活码页面。",
            "重新绑定设备", MessageBoxButton.OKCancel, MessageBoxImage.Information);
        if (result != MessageBoxResult.OK) return;
        _proxy.Stop();
        _profile = null;
        _state = null;
        if (File.Exists(_statePath)) File.Delete(_statePath);
        _identity.Dispose();
        _identity = DeviceIdentity.LoadOrCreate();
        UpdateIdentityLabels();
        ActivationCodeBox.Clear();
        ShowCurrentView();
        SetConnectionState(false, "等待激活");
        FooterText.Text = "请输入管理员新生成的一次性激活码";
    }

    private async Task RefreshProfileAsync(bool showError)
    {
        if (_state is null) return;
        try
        {
            var previous = _profile;
            var wasRunning = _proxy.IsRunning;
            var activeProtocol = _proxy.ActiveProtocol;
            var challenge = await _api.ChallengeAsync(_state.DeviceId);
            _profile = await CompleteRenewAsync(challenge.Nonce);
            if (wasRunning)
            {
                var credentialChanged = previous is not null && CredentialsChanged(previous, _profile, activeProtocol);
                if (credentialChanged || activeProtocol == ProxyProtocol.Tuic)
                {
                    _proxy.Stop();
                    await _proxy.StartAsync(_profile, _identity, _transportIdentity, activeProtocol, _selectedMode);
                    SetConnectionState(true, $"已续签 · {ProtocolName(activeProtocol)}");
                }
                else _proxy.UpdateCertificate(_profile, _identity);
            }
            RenderProfile();
        }
        catch (Exception exception)
        {
            if (showError) ShowError(exception.Message);
            else FooterText.Text = exception.Message;
        }
    }

    private async Task RefreshWhileConnectedAsync()
    {
        if (!_proxy.IsRunning || _profile is null) return;
        if (!await CheckForUpdateAsync(showNetworkError: false)) return;
        if (_profile.DeviceCertificateExpiresAt < DateTimeOffset.UtcNow.AddMinutes(30))
            await RefreshProfileAsync(showError: false);
    }

    private async Task<RenewProfile> CompleteRenewAsync(string nonce)
    {
        if (_state is null) throw new InvalidOperationException("设备尚未绑定");
        var candidates = new List<DeviceIdentity> { _identity };
        candidates.AddRange(DeviceIdentity.LoadExistingAlternates(_identity.KeyId, _identity.ProviderId));
        try
        {
            if (!string.IsNullOrWhiteSpace(_state.PublicKeyHash) &&
                candidates.All(value => value.PublicKeyHash != _state.PublicKeyHash))
            {
                throw new InvalidOperationException("本机设备密钥已变化，请管理员在后台解绑设备后重新激活");
            }

            InvalidOperationException? signatureError = null;
            foreach (var candidate in candidates.OrderByDescending(value => value.PublicKeyHash == _state.PublicKeyHash))
            {
                try
                {
                    var profile = await RenewWithIdentityAsync(nonce, candidate);
                    if (!ReferenceEquals(candidate, _identity))
                    {
                        _identity = candidate;
                        UpdateIdentityLabels();
                    }
                    _state = new ClientState(
                        _state.DeviceId, _identity.ProviderId, _identity.PublicKeyHash, _identity.KeyId);
                    SaveState(_state);
                    return profile;
                }
                catch (InvalidOperationException error) when (IsSignatureError(error))
                {
                    signatureError = error;
                }
            }
            throw new InvalidOperationException(
                "后台保存的设备密钥与本机不一致，请管理员解绑此设备并生成新的激活码", signatureError);
        }
        finally
        {
            foreach (var unused in candidates.Where(value => !ReferenceEquals(value, _identity))) unused.Dispose();
        }
    }

    private async Task<RenewProfile> RenewWithIdentityAsync(string nonce, DeviceIdentity identity)
    {
        if (_state is null) throw new InvalidOperationException("设备尚未绑定");
        var transportPublicKey = _transportIdentity.ExportPublicKeyPem();
        var transportHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(transportPublicKey))).ToLowerInvariant();
        var message = $"cloudbridge:v2:renew:{_state.DeviceId}:{nonce}:{identity.FingerprintHash}:{transportHash}";
        try
        {
            return await _api.RenewAsync(new RenewRequest(
                _state.DeviceId, nonce, identity.FingerprintHash, identity.Sign(message),
                UpdateService.CurrentVersion, transportPublicKey));
        }
        catch (InvalidOperationException error) when (IsSignatureError(error))
        {
            // 2.3 servers do not understand the optional transport key yet. The
            // challenge is not consumed after a failed signature, so a v1 retry is safe.
            var legacyMessage = $"cloudbridge:v1:renew:{_state.DeviceId}:{nonce}:{identity.FingerprintHash}";
            var profile = await _api.RenewAsync(new RenewRequest(
                _state.DeviceId, nonce, identity.FingerprintHash, identity.Sign(legacyMessage),
                UpdateService.CurrentVersion));
            FooterText.Text = "服务器兼容模式 · VLESS 可用，TUIC 将在服务端升级后启用";
            return profile;
        }
    }

    private static bool IsSignatureError(InvalidOperationException error) =>
        error.Message.Contains("设备签名校验失败", StringComparison.Ordinal);

    private void UpdateIdentityLabels()
    {
        ActivationKeyProviderText.Text = _identity.KeyProvider;
        DeviceSecurityText.Text = $"{_identity.KeyProvider} · 指纹 {_identity.FingerprintHash[..12]}";
    }

    private async Task HandleLoadedAsync()
    {
        if (!await CheckForUpdateAsync(showNetworkError: false)) return;
        if (_state is not null) await RefreshProfileAsync(showError: false);
        if (_profile is not null && _selectedMode == ProxyMode.GlobalTun &&
            Environment.GetCommandLineArgs().Contains("--global-tun", StringComparer.OrdinalIgnoreCase))
            await ConnectSelectedAsync();
        if (Environment.GetCommandLineArgs().Contains("--updated"))
            FooterText.Text = $"已安全更新到 v{UpdateService.CurrentVersion}";
    }

#if DEBUG
    private async Task CaptureDebugUiAsync()
    {
        var argument = Environment.GetCommandLineArgs()
            .FirstOrDefault(value => value.StartsWith("--capture-ui=", StringComparison.OrdinalIgnoreCase));
        if (argument is null) return;
        await Task.Delay(1200);
        UpdateLayout();
        var path = argument["--capture-ui=".Length..].Trim('"');
        var bitmap = new RenderTargetBitmap(
            Math.Max(1, (int)Math.Ceiling(ActualWidth)),
            Math.Max(1, (int)Math.Ceiling(ActualHeight)),
            96, 96, PixelFormats.Pbgra32);
        bitmap.Render(this);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        await using var stream = File.Create(path);
        encoder.Save(stream);
        _allowExit = true;
        Close();
    }
#endif

    private async Task<bool> CheckForUpdateAsync(bool showNetworkError)
    {
        if (_updateCheckInProgress || _updateBlocked) return false;
        _updateCheckInProgress = true;
        try
        {
            var policy = await _api.GetUpdatePolicyAsync(UpdateService.CurrentVersion);
            if (!policy.Available || !policy.UpdateAvailable) return true;
            _updatePolicy = policy;
            _updateBlocked = policy.Required;
            if (_proxy.IsRunning && policy.Required)
            {
                _proxy.Stop();
                SetConnectionState(false, "需要更新");
            }
            UpdateTitleText.Text = policy.Required ? "必须更新后继续" : "发现新版本";
            UpdateVersionText.Text = $"v{UpdateService.CurrentVersion}  →  v{policy.LatestVersion}";
            UpdateNotesText.Text = string.IsNullOrWhiteSpace(policy.ReleaseNotes)
                ? "本次更新包含连接稳定性与安全改进。"
                : policy.ReleaseNotes;
            UpdateLaterButton.Visibility = policy.Required ? Visibility.Collapsed : Visibility.Visible;
            UpdateOverlay.Visibility = Visibility.Visible;
            ApplyControlAvailability();
            return !policy.Required;
        }
        catch (Exception exception)
        {
            if (showNetworkError) ShowError($"无法检查更新：{exception.Message}");
            return !showNetworkError;
        }
        finally { _updateCheckInProgress = false; }
    }

    private async void UpdateNowButton_Click(object sender, RoutedEventArgs e)
    {
        if (_updatePolicy is null) return;
        UpdateNowButton.IsEnabled = false;
        UpdateActionText.Text = "正在更新…";
        UpdateLaterButton.IsEnabled = false;
        UpdateProgress.Visibility = Visibility.Visible;
        UpdateProgressText.Text = "正在建立安全下载…";
        try
        {
            var progress = new Progress<UpdateProgress>(value =>
            {
                UpdateProgress.Value = value.Percent;
                UpdateProgressText.Text = $"正在下载 {value.Percent}% · {FormatBytes(value.BytesReceived)} / {FormatBytes(value.TotalBytes)}";
            });
            await _updates.DownloadAndLaunchAsync(_updatePolicy, progress);
            UpdateProgress.Value = 100;
            UpdateProgressText.Text = "安全校验通过，正在安装并重启…";
            _proxy.Stop();
            await Task.Delay(350);
            _allowExit = true;
            Application.Current.Shutdown();
        }
        catch (Exception exception)
        {
            UpdateNowButton.IsEnabled = true;
            UpdateActionText.Text = "重试更新";
            UpdateLaterButton.IsEnabled = true;
            UpdateProgressText.Text = exception.Message;
            MessageBox.Show(this, exception.Message, "壹色云桥更新", MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void UpdateLaterButton_Click(object sender, RoutedEventArgs e)
    {
        if (_updatePolicy?.Required == true) return;
        UpdateOverlay.Visibility = Visibility.Collapsed;
    }

    private void RenderProfile()
    {
        if (_profile is null) return;
        WelcomeText.Text = $"你好，{_profile.MemberName}";
        MemberText.Text = _profile.MemberName;
        SidebarMemberText.Text = _profile.MemberName;
        ExpiryText.Text = $"有效期至 {_profile.ExpiresAt.LocalDateTime:yyyy-MM-dd HH:mm}";
        SidebarExpiryText.Text = $"剩余 {Math.Max(0, (int)Math.Ceiling((_profile.ExpiresAt - DateTimeOffset.Now).TotalDays))} 天";
        QuotaText.Text = _profile.TrafficQuotaBytes == 0
            ? $"已用 {FormatBytes(_profile.TrafficUsedBytes)} · 不限总量"
            : $"{FormatBytes(_profile.TrafficUsedBytes)} / {FormatBytes(_profile.TrafficQuotaBytes)}";
        TotalTrafficText.Text = FormatBytes(_profile.TrafficUsedBytes);
        var remaining = Math.Max(0, (int)Math.Ceiling((_profile.ExpiresAt - DateTimeOffset.Now).TotalDays));
        DaysRemainingText.Text = $"{remaining} 天";
        if (_profile.TrafficQuotaBytes == 0)
        {
            UsagePercentText.Text = "不限";
            UsageProgress.Value = 0;
        }
        else
        {
            var percent = Math.Clamp(_profile.TrafficUsedBytes * 100d / _profile.TrafficQuotaBytes, 0, 100);
            UsagePercentText.Text = $"{percent:0.#}%";
            UsageProgress.Value = percent;
        }
        if (!TuicAvailable() && _selectedProtocol == ProxyProtocol.Tuic) _selectedProtocol = ProxyProtocol.Vless;
        if (!TuicAvailable()) TuicSpeedText.Text = "服务端未启用";
        ApplyControlAvailability();
        UpdateRouteSelection();
    }

    private bool TuicAvailable() =>
        _profile?.Protocols.Tuic is { Uuid.Length: > 0, Password.Length: > 0 } &&
        !string.IsNullOrWhiteSpace(_profile.TransportCertificatePem);

    private static bool CredentialsChanged(RenewProfile previous, RenewProfile current, ProxyProtocol protocol)
    {
        if (protocol == ProxyProtocol.Vless)
            return previous.Protocols.Vless.Uuid != current.Protocols.Vless.Uuid;
        return previous.Protocols.Tuic?.Uuid != current.Protocols.Tuic?.Uuid ||
               previous.Protocols.Tuic?.Password != current.Protocols.Tuic?.Password;
    }

    private void UpdateRouteSelection()
    {
        var vless = _selectedProtocol == ProxyProtocol.Vless;
        VlessRouteButton.BorderBrush = Brush(vless ? "#779FE9" : "#CCFFFFFF");
        VlessRouteButton.Background = Brush(vless ? "#B0F0F6FF" : "#70FFFFFF");
        VlessRouteButton.BorderThickness = new Thickness(vless ? 2 : 1);
        TuicRouteButton.BorderBrush = Brush(vless ? "#CCFFFFFF" : "#67BACD");
        TuicRouteButton.Background = Brush(vless ? "#70FFFFFF" : "#B0E9FAFC");
        TuicRouteButton.BorderThickness = new Thickness(vless ? 1 : 2);
        VlessSelectedMark.Visibility = vless ? Visibility.Visible : Visibility.Collapsed;
        TuicSelectedMark.Visibility = vless ? Visibility.Collapsed : Visibility.Visible;
        CurrentRouteText.Text = vless ? "VLESS · TCP 稳定线路" : "TUIC · QUIC 低延迟线路";
    }

    private void UpdateModeSelection()
    {
        var bypass = _selectedMode == ProxyMode.BypassChina;
        BypassModeButton.Background = Brush(bypass ? "#EFFFFFFF" : "#00FFFFFF");
        BypassModeButton.Foreground = Brush(bypass ? "#007AFF" : "#6E6E73");
        GlobalModeButton.Background = Brush(bypass ? "#00FFFFFF" : "#EFFFFFFF");
        GlobalModeButton.Foreground = Brush(bypass ? "#6E6E73" : "#007AFF");
    }

    private void SetConnectionState(bool connected, string status)
    {
        HeaderStatusText.Text = status;
        HeaderStatusText.Foreground = Brush(connected ? "#247C38" : "#6E6E73");
        StatusBadge.Background = Brush(connected ? "#EAF7ED" : "#EEEEF0");
        HeaderStatusDot.Fill = Brush(connected ? "#28A745" : "#8E8E93");
        ConnectButton.Background = connected
            ? new LinearGradientBrush(Color.FromRgb(75, 197, 188), Color.FromRgb(36, 148, 184), 45)
            : (System.Windows.Media.Brush)FindResource("ConnectBrush");
        ConnectButton.ToolTip = connected ? "断开专线" : "连接专线";
        ConnectGlyph.Text = "\uE7E8";
        ConnectionTitleText.Text = connected ? "断开" : "连接";
        ConnectionDetailText.Text = connected
            ? (_proxy.ActiveMode == ProxyMode.GlobalTun ? "全局 TUN 已启用，所有应用流量已接管" : "大陆网站直连，其他流量正在保护中")
            : "当前未启用网络代理";
        FooterText.Text = connected
            ? $"{ProtocolName(_proxy.ActiveProtocol)} · {ModeName(_proxy.ActiveMode)} · 出口验证通过"
            : "默认绕过大陆；全局 TUN 需要管理员权限";
        _busySpin.Stop(this);
        if (connected)
        {
            _lastTraffic = _proxy.Traffic;
            _lastTrafficAt = DateTimeOffset.UtcNow;
            if (SystemParameters.ClientAreaAnimation) _connectedPulse.Begin(this, true);
        }
        else
        {
            _connectedPulse.Stop(this);
            ConnectPulseRing.Opacity = 0;
            ConnectPulseRing.RenderTransform = new ScaleTransform(1, 1);
            UpdateTrafficLabels(0, 0, new TrafficSnapshot(0, 0));
        }
        ApplyControlAvailability();
    }

    private void SetBusy(bool busy, string? status = null)
    {
        _busy = busy;
        ApplyControlAvailability();
        if (status is not null) HeaderStatusText.Text = status;
        if (busy && DashboardPanel.Visibility == Visibility.Visible)
        {
            _connectedPulse.Stop(this);
            ConnectGlyph.Text = "\uE72C";
            _busySpin.Begin(this, true);
        }
        else
        {
            _busySpin.Stop(this);
            ConnectGlyph.Text = "\uE7E8";
        }
    }

    private void ApplyControlAvailability()
    {
        var enabled = !_busy && !_updateBlocked;
        ActivateButton.IsEnabled = enabled;
        ConnectButton.IsEnabled = enabled;
        ResetBindingButton.IsEnabled = enabled;
        TestRoutesButton.IsEnabled = enabled && !_proxy.IsRunning;
        VlessRouteButton.IsEnabled = enabled;
        TuicRouteButton.IsEnabled = enabled && TuicAvailable();
        BypassModeButton.IsEnabled = enabled;
        GlobalModeButton.IsEnabled = enabled;
    }

    private Forms.NotifyIcon CreateTrayIcon()
    {
        var menu = new Forms.ContextMenuStrip();
        var open = new Forms.ToolStripMenuItem("打开壹色云桥");
        var disconnect = new Forms.ToolStripMenuItem("断开连接");
        var exit = new Forms.ToolStripMenuItem("退出");
        open.Click += (_, _) => Dispatcher.BeginInvoke(ShowFromTray);
        disconnect.Click += (_, _) => Dispatcher.BeginInvoke(DisconnectFromTray);
        exit.Click += (_, _) => Dispatcher.BeginInvoke(ExitFromTray);
        menu.Items.Add(open);
        menu.Items.Add(disconnect);
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add(exit);

        using var iconResource = Application.GetResourceStream(
            new Uri("pack://application:,,,/Assets/YiseCloudBridge.ico")).Stream;
        using var sourceIcon = new Drawing.Icon(iconResource, new Drawing.Size(32, 32));
        var icon = (Drawing.Icon)sourceIcon.Clone();
        var tray = new Forms.NotifyIcon
        {
            Text = "壹色云桥",
            Icon = icon,
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.DoubleClick += (_, _) => Dispatcher.BeginInvoke(ShowFromTray);
        return tray;
    }

    private void MainWindow_Closing(object? sender, CancelEventArgs e)
    {
        if (!_allowExit)
        {
            e.Cancel = true;
            HideToTray();
            return;
        }
        DisposeApplication();
    }

    private void HideToTray()
    {
        ShowInTaskbar = false;
        Hide();
    }

    private void ShowFromTray()
    {
        ShowInTaskbar = true;
        Show();
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Activate();
    }

    private void DisconnectFromTray()
    {
        if (!_proxy.IsRunning) return;
        _proxy.Stop();
        SetConnectionState(false, "已断开");
    }

    private void ExitFromTray()
    {
        _allowExit = true;
        Close();
    }

    private void DisposeApplication()
    {
        if (_disposed) return;
        _disposed = true;
        SaveTodayUsage();
        _renewalTimer.Stop();
        _trafficTimer.Stop();
        _proxy.Dispose();
        _transportIdentity.Dispose();
        _identity.Dispose();
        _trayIcon.Visible = false;
        _trayIcon.Icon?.Dispose();
        _trayIcon.Dispose();
    }

    private bool EnsureTunPrivileges()
    {
        if (IsAdministrator()) return true;
        try
        {
            var executable = Environment.ProcessPath
                ?? throw new InvalidOperationException("无法定位客户端程序");
            Process.Start(new ProcessStartInfo(
                executable, $"--global-tun --wait-for-pid={Environment.ProcessId}")
            {
                UseShellExecute = true,
                Verb = "runas",
                WorkingDirectory = AppContext.BaseDirectory,
            });
            _allowExit = true;
            Close();
        }
        catch (Win32Exception)
        {
            ShowError("全局 TUN 需要管理员权限；授权已取消，当前未连接");
        }
        return false;
    }

    private static bool IsAdministrator()
    {
        using var identity = WindowsIdentity.GetCurrent();
        return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
    }

    private void UpdateTraffic()
    {
        var now = DateTimeOffset.UtcNow;
        if (!_proxy.IsRunning)
        {
            _lastTraffic = new TrafficSnapshot(0, 0);
            _lastTrafficAt = now;
            OverviewTrafficChart.AddSample(0, 0);
            DetailTrafficChart.AddSample(0, 0);
            return;
        }

        var snapshot = _proxy.Traffic;
        var seconds = Math.Max(0.2, (now - _lastTrafficAt).TotalSeconds);
        var uploadDelta = Math.Max(0, snapshot.UploadedBytes - _lastTraffic.UploadedBytes);
        var downloadDelta = Math.Max(0, snapshot.DownloadedBytes - _lastTraffic.DownloadedBytes);
        var uploadMbps = uploadDelta * 8d / seconds / 1_000_000d;
        var downloadMbps = downloadDelta * 8d / seconds / 1_000_000d;
        _lastTraffic = snapshot;
        _lastTrafficAt = now;

        EnsureToday();
        _todayUsage = _todayUsage with
        {
            UploadedBytes = _todayUsage.UploadedBytes + uploadDelta,
            DownloadedBytes = _todayUsage.DownloadedBytes + downloadDelta,
        };
        if (++_usageSaveCounter % 10 == 0) SaveTodayUsage();

        OverviewTrafficChart.AddSample(downloadMbps, uploadMbps);
        DetailTrafficChart.AddSample(downloadMbps, uploadMbps);
        UpdateTrafficLabels(downloadMbps, uploadMbps, snapshot);
    }

    private void UpdateTrafficLabels(double downloadMbps, double uploadMbps, TrafficSnapshot snapshot)
    {
        LiveDownText.Text = $"下载 {FormatRate(downloadMbps)}";
        LiveUpText.Text = $"上传 {FormatRate(uploadMbps)}";
        TrafficLiveDownText.Text = $"↓ {FormatRate(downloadMbps)}";
        TrafficLiveUpText.Text = $"↑ {FormatRate(uploadMbps)}";
        SessionDownloadText.Text = FormatBytes(snapshot.DownloadedBytes);
        SessionUploadText.Text = FormatBytes(snapshot.UploadedBytes);
        SessionTrafficText.Text = FormatBytes(snapshot.UploadedBytes + snapshot.DownloadedBytes);
        TodayTrafficText.Text = FormatBytes(_todayUsage.UploadedBytes + _todayUsage.DownloadedBytes);
    }

    private void NavConnectionButton_Click(object sender, RoutedEventArgs e) => ShowPage(ConnectionView, NavConnectionButton);
    private void NavTrafficButton_Click(object sender, RoutedEventArgs e) => ShowPage(TrafficView, NavTrafficButton);
    private void NavAccountButton_Click(object sender, RoutedEventArgs e) => ShowPage(AccountView, NavAccountButton);

    private void ShowPage(UIElement page, Button selected)
    {
        ConnectionView.Visibility = Visibility.Collapsed;
        TrafficView.Visibility = Visibility.Collapsed;
        AccountView.Visibility = Visibility.Collapsed;
        foreach (var button in new[] { NavConnectionButton, NavTrafficButton, NavAccountButton })
        {
            button.Background = Brushes.Transparent;
            button.Foreground = Brush("#6E6E73");
        }
        page.Visibility = Visibility.Visible;
        if (SystemParameters.ClientAreaAnimation)
        {
            page.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(250)));
            var translate = new TranslateTransform();
            page.RenderTransform = translate;
            translate.BeginAnimation(TranslateTransform.YProperty, new DoubleAnimation(8, 0, TimeSpan.FromMilliseconds(280))
            {
                EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            });
        }
        selected.Background = Brush("#D5FFFFFF");
        selected.Foreground = Brush("#007AFF");
    }

    private void ShowError(string message)
    {
        SetConnectionState(false, "需要处理");
        FooterText.Text = message;
        MessageBox.Show(this, message, "壹色云桥", MessageBoxButton.OK, MessageBoxImage.Warning);
    }

    private ClientState? LoadState()
    {
        try { return File.Exists(_statePath) ? JsonSerializer.Deserialize<ClientState>(File.ReadAllText(_statePath)) : null; }
        catch (JsonException) { return null; }
    }

    private void SaveState(ClientState state) => File.WriteAllText(_statePath, JsonSerializer.Serialize(state));

    private TodayUsage LoadTodayUsage()
    {
        try
        {
            var usage = File.Exists(_usagePath) ? JsonSerializer.Deserialize<TodayUsage>(File.ReadAllText(_usagePath)) : null;
            return usage?.Date == DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd") ? usage : TodayUsage.Empty;
        }
        catch (JsonException) { return TodayUsage.Empty; }
    }

    private void EnsureToday()
    {
        if (_todayUsage.Date != DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd")) _todayUsage = TodayUsage.Empty;
    }

    private void SaveTodayUsage()
    {
        EnsureToday();
        File.WriteAllText(_usagePath, JsonSerializer.Serialize(_todayUsage));
    }

    private static SolidColorBrush Brush(string value) => new((Color)ColorConverter.ConvertFromString(value));
    private static string ProtocolName(ProxyProtocol protocol) => protocol == ProxyProtocol.Tuic ? "TUIC" : "VLESS";
    private static string ModeName(ProxyMode mode) => mode == ProxyMode.GlobalTun ? "全局 TUN" : "绕过大陆";
    private static string Trim(string value, int length) => value.Length > length ? value[..length] : value;

    private static string FormatRate(double mbps) => mbps >= 1 ? $"{mbps:0.0} Mbps" : $"{mbps * 1000:0} Kbps";

    private static string FormatBytes(long value)
    {
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var size = (double)value;
        var unit = 0;
        while (size >= 1024 && unit < units.Length - 1) { size /= 1024; unit++; }
        return $"{size:0.#} {units[unit]}";
    }

    private sealed record TodayUsage(string Date, long UploadedBytes, long DownloadedBytes)
    {
        public static TodayUsage Empty => new(DateOnly.FromDateTime(DateTime.Now).ToString("yyyy-MM-dd"), 0, 0);
    }
}
