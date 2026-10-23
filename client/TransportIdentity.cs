using System.Security.Cryptography;

namespace CloudBridge.Client;

public sealed class TransportIdentity : IDisposable
{
    private const string KeyName = "CloudBridge.TransportKey.v1";
    private readonly ECDsaCng _key;

    private TransportIdentity(ECDsaCng key) => _key = key;

    public static TransportIdentity LoadOrCreate()
    {
        var provider = CngProvider.MicrosoftSoftwareKeyStorageProvider;
        CngKey key;
        if (CngKey.Exists(KeyName, provider))
        {
            key = CngKey.Open(KeyName, provider);
        }
        else
        {
            key = CngKey.Create(CngAlgorithm.ECDsaP256, KeyName, new CngKeyCreationParameters
            {
                Provider = provider,
                KeyUsage = CngKeyUsages.Signing,
                ExportPolicy = CngExportPolicies.AllowPlaintextExport,
            });
        }
        return new TransportIdentity(new ECDsaCng(key));
    }

    public string ExportPublicKeyPem() => Pem("PUBLIC KEY", _key.ExportSubjectPublicKeyInfo());

    public string ExportPrivateKeyPem() => Pem("PRIVATE KEY", _key.ExportPkcs8PrivateKey());

    private static string Pem(string label, byte[] data)
    {
        var base64 = Convert.ToBase64String(data, Base64FormattingOptions.InsertLineBreaks);
        return $"-----BEGIN {label}-----\n{base64.Replace("\r\n", "\n")}\n-----END {label}-----\n";
    }

    public void Dispose() => _key.Dispose();
}
