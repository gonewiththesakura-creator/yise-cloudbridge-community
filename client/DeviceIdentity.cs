using Microsoft.Win32;
using System.Management;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace CloudBridge.Client;

public sealed class DeviceIdentity : IDisposable
{
    private const string CurrentKeyName = "YiseCloudBridge.DeviceKey.v2";
    private const string LegacyKeyName = "CloudBridge.DeviceKey.v1";
    private const string TpmProviderId = "tpm";
    private const string SoftwareProviderId = "software";
    private readonly ECDsaCng _key;

    private DeviceIdentity(ECDsaCng key, string keyId, string providerId, string providerName)
    {
        _key = key;
        KeyId = keyId;
        ProviderId = providerId;
        KeyProvider = providerName;
        FingerprintHash = BuildFingerprint();
        PublicKeyHash = Convert.ToHexString(SHA256.HashData(_key.ExportSubjectPublicKeyInfo())).ToLowerInvariant();
    }

    public string KeyId { get; }
    public string ProviderId { get; }
    public string KeyProvider { get; }
    public string FingerprintHash { get; }
    public string PublicKeyHash { get; }
    public string DeviceName => Environment.MachineName;

    public static DeviceIdentity LoadOrCreate(string? preferredProviderId = null, string? keyId = null)
    {
        var selectedKeyId = string.IsNullOrWhiteSpace(keyId) ? CurrentKeyName : keyId;
        var providers = OrderedProviders(preferredProviderId).ToArray();

        // Open every existing key before creating a new one. This prevents a newly
        // available TPM from silently replacing an established software identity.
        foreach (var provider in providers)
        {
            try
            {
                if (CngKey.Exists(selectedKeyId, provider.Provider)) return Open(selectedKeyId, provider);
            }
            catch (CryptographicException)
            {
                // Try another existing provider before creating a replacement.
            }
        }

        foreach (var provider in providers)
        {
            try
            {
                var parameters = new CngKeyCreationParameters
                {
                    Provider = provider.Provider,
                    KeyUsage = CngKeyUsages.Signing,
                    ExportPolicy = CngExportPolicies.None,
                    KeyCreationOptions = CngKeyCreationOptions.None,
                };
                return new DeviceIdentity(
                    new ECDsaCng(CngKey.Create(CngAlgorithm.ECDsaP256, selectedKeyId, parameters)),
                    selectedKeyId, provider.Id, provider.DisplayName);
            }
            catch (CryptographicException)
            {
                // Try the next Windows key provider.
            }
        }
        throw new InvalidOperationException("无法创建 Windows 设备密钥");
    }

    public static string LegacyKeyId => LegacyKeyName;

    public static IReadOnlyList<DeviceIdentity> LoadExistingAlternates(string keyId, string currentProviderId)
    {
        var identities = new List<DeviceIdentity>();
        foreach (var provider in ProviderDefinitions().Where(value => value.Id != currentProviderId))
        {
            try
            {
                if (CngKey.Exists(keyId, provider.Provider)) identities.Add(Open(keyId, provider));
            }
            catch (CryptographicException) { }
        }
        return identities;
    }

    private static DeviceIdentity Open(string keyId, ProviderDefinition provider) => new(
        new ECDsaCng(CngKey.Open(keyId, provider.Provider)), keyId, provider.Id, provider.DisplayName);

    private static IEnumerable<ProviderDefinition> OrderedProviders(string? preferredProviderId)
    {
        var providers = ProviderDefinitions();
        if (string.IsNullOrWhiteSpace(preferredProviderId)) return providers;
        return providers.OrderByDescending(value => value.Id == preferredProviderId);
    }

    private static ProviderDefinition[] ProviderDefinitions() =>
    [
        new(TpmProviderId, "TPM 硬件密钥", CngProvider.MicrosoftPlatformCryptoProvider),
        new(SoftwareProviderId, "Windows 不可导出密钥", CngProvider.MicrosoftSoftwareKeyStorageProvider),
    ];

    private sealed record ProviderDefinition(string Id, string DisplayName, CngProvider Provider);

    public string ExportPublicKeyPem()
    {
        var base64 = Convert.ToBase64String(_key.ExportSubjectPublicKeyInfo(), Base64FormattingOptions.InsertLineBreaks);
        return $"-----BEGIN PUBLIC KEY-----\n{base64.Replace("\r\n", "\n")}\n-----END PUBLIC KEY-----\n";
    }

    public string Sign(string message)
    {
        var signature = _key.SignData(
            Encoding.UTF8.GetBytes(message),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return Convert.ToBase64String(signature);
    }

    public X509Certificate2 CreateClientCertificate(string certificatePem)
    {
        if (string.IsNullOrWhiteSpace(certificatePem))
            throw new InvalidOperationException("服务器未签发设备证书");
        using var publicCertificate = X509Certificate2.CreateFromPem(certificatePem);
        return publicCertificate.CopyWithPrivateKey(_key);
    }

    private static string BuildFingerprint()
    {
        var components = new SortedSet<string>(StringComparer.Ordinal);
        using (var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography"))
        {
            Add(components, "machine", key?.GetValue("MachineGuid")?.ToString());
        }
        Query(components, "cs", "SELECT UUID FROM Win32_ComputerSystemProduct", "UUID");
        Query(components, "board", "SELECT SerialNumber FROM Win32_BaseBoard", "SerialNumber");
        Query(components, "bios", "SELECT SerialNumber FROM Win32_BIOS", "SerialNumber");
        Query(components, "cpu", "SELECT ProcessorId FROM Win32_Processor", "ProcessorId");
        if (components.Count < 2) Add(components, "fallback", Environment.MachineName);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("|", components)))).ToLowerInvariant();
    }

    private static void Query(ISet<string> values, string label, string query, string property)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher(query);
            foreach (ManagementObject item in searcher.Get()) Add(values, label, item[property]?.ToString());
        }
        catch (ManagementException) { }
    }

    private static void Add(ISet<string> values, string label, string? value)
    {
        var normalized = value?.Trim().ToUpperInvariant();
        if (!string.IsNullOrWhiteSpace(normalized) && normalized is not "UNKNOWN" and not "DEFAULT STRING")
            values.Add($"{label}:{normalized}");
    }

    public void Dispose() => _key.Dispose();
}
