namespace CloudBridge.Client;

public sealed record RegisterRequest(
    string ActivationCode,
    string DeviceName,
    string FingerprintHash,
    string PublicKey,
    string KeyProvider,
    string ClientVersion);

public sealed record RegisterResponse(string DeviceId, string Nonce, string Purpose, int ExpiresInSeconds);
public sealed record ChallengeResponse(string Nonce, string Purpose, int ExpiresInSeconds);
public sealed record RenewRequest(
    string DeviceId,
    string Nonce,
    string FingerprintHash,
    string Signature,
    string ClientVersion,
    string? TransportPublicKey = null);

public sealed class ClientUpdatePolicy
{
    public bool Available { get; set; }
    public bool UpdateAvailable { get; set; }
    public bool Required { get; set; }
    public string LatestVersion { get; set; } = "";
    public string MinimumVersion { get; set; } = "";
    public string DownloadUrl { get; set; } = "";
    public string Sha256 { get; set; } = "";
    public long FileSize { get; set; }
    public string ReleaseNotes { get; set; } = "";
    public DateTimeOffset? PublishedAt { get; set; }
}

public sealed record UpdateProgress(long BytesReceived, long TotalBytes)
{
    public int Percent => TotalBytes <= 0 ? 0 : (int)Math.Clamp(BytesReceived * 100L / TotalBytes, 0, 100);
}

public sealed class RenewProfile
{
    public string ProductName { get; set; } = "壹色云桥";
    public string DeviceId { get; set; } = "";
    public string MemberName { get; set; } = "";
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CredentialExpiresAt { get; set; }
    public string DeviceCertificatePem { get; set; } = "";
    public DateTimeOffset DeviceCertificateExpiresAt { get; set; }
    public string TransportCertificatePem { get; set; } = "";
    public DateTimeOffset TransportCertificateExpiresAt { get; set; }
    public long TrafficQuotaBytes { get; set; }
    public long TrafficUsedBytes { get; set; }
    public int MaxConnections { get; set; }
    public ServerProfile Server { get; set; } = new();
    public ProtocolProfiles Protocols { get; set; } = new();
}

public sealed class ServerProfile
{
    public string Host { get; set; } = "";
    public int Port { get; set; }
    public string ServerName { get; set; } = "";
}

public sealed class ProtocolProfiles
{
    public VlessProfile Vless { get; set; } = new();
    public TuicProfile? Tuic { get; set; }
}

public sealed class VlessProfile
{
    public string Uuid { get; set; } = "";
    public string Flow { get; set; } = "xtls-rprx-vision";
}

public sealed class TuicProfile
{
    public string Uuid { get; set; } = "";
    public string Password { get; set; } = "";
    public int ServerPort { get; set; } = 443;
    public string ServerName { get; set; } = "";
    public string CongestionControl { get; set; } = "bbr";
}

public enum ProxyProtocol
{
    Vless,
    Tuic,
}

public enum ProxyMode
{
    BypassChina,
    GlobalTun,
}

public sealed record TrafficSnapshot(long UploadedBytes, long DownloadedBytes);

public sealed record RouteTestResult(
    ProxyProtocol Protocol,
    bool Available,
    double LatencyMs,
    double DownloadMbps,
    string Error = "");

public sealed record ClientState(
    string DeviceId,
    string? KeyProviderId = null,
    string? PublicKeyHash = null,
    string? KeyId = null);
