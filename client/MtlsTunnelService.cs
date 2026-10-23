using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;

namespace CloudBridge.Client;

public sealed class MtlsTunnelService : IDisposable
{
    private readonly object _certificateLock = new();
    private readonly List<X509Certificate2> _certificates = [];
    private CancellationTokenSource? _cancellation;
    private TcpListener? _listener;
    private RenewProfile? _profile;

    public event Action<string>? Log;
    public int LocalPort { get; private set; }

    public void Start(RenewProfile profile, DeviceIdentity identity)
    {
        Stop();
        _profile = profile;
        UpdateCertificate(profile, identity);
        _cancellation = new CancellationTokenSource();
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        LocalPort = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _ = AcceptLoopAsync(_cancellation.Token);
    }

    public void UpdateCertificate(RenewProfile profile, DeviceIdentity identity)
    {
        var certificate = identity.CreateClientCertificate(profile.DeviceCertificatePem);
        lock (_certificateLock)
        {
            _profile = profile;
            _certificates.Add(certificate);
            while (_certificates.Count > 2)
            {
                _certificates[0].Dispose();
                _certificates.RemoveAt(0);
            }
        }
    }

    private async Task AcceptLoopAsync(CancellationToken token)
    {
        while (!token.IsCancellationRequested && _listener is not null)
        {
            try
            {
                var local = await _listener.AcceptTcpClientAsync(token);
                _ = ForwardAsync(local, token);
            }
            catch (OperationCanceledException) { break; }
            catch (ObjectDisposedException) { break; }
            catch (Exception exception) { Log?.Invoke($"设备隧道：{exception.Message}"); }
        }
    }

    private async Task ForwardAsync(TcpClient local, CancellationToken token)
    {
        using (local)
        using (var remote = new TcpClient())
        {
            try
            {
                RenewProfile profile;
                X509Certificate2 certificate;
                lock (_certificateLock)
                {
                    profile = _profile ?? throw new InvalidOperationException("设备配置尚未加载");
                    certificate = _certificates[^1];
                }
                await remote.ConnectAsync(profile.Server.Host, profile.Server.Port, token);
                await using var secure = new SslStream(remote.GetStream(), leaveInnerStreamOpen: false);
                var authentication = new SslClientAuthenticationOptions
                {
                    TargetHost = profile.Server.ServerName,
                    ClientCertificates = new X509CertificateCollection { certificate },
                    EnabledSslProtocols = SslProtocols.Tls13,
                    CertificateRevocationCheckMode = X509RevocationMode.NoCheck,
                    ApplicationProtocols = [new SslApplicationProtocol("cloudbridge-v2")],
                };
                await secure.AuthenticateAsClientAsync(authentication, token);
                Log?.Invoke("设备证书校验通过");
                await using var localStream = local.GetStream();
                var uplink = localStream.CopyToAsync(secure, token);
                var downlink = secure.CopyToAsync(localStream, token);
                await Task.WhenAny(uplink, downlink);
            }
            catch (OperationCanceledException) { }
            catch (Exception exception) { Log?.Invoke($"设备认证连接失败：{exception.Message}"); }
        }
    }

    public void Stop()
    {
        _cancellation?.Cancel();
        _listener?.Stop();
        _listener = null;
        LocalPort = 0;
        _cancellation?.Dispose();
        _cancellation = null;
        lock (_certificateLock)
        {
            foreach (var certificate in _certificates) certificate.Dispose();
            _certificates.Clear();
        }
    }

    public void Dispose() => Stop();
}
