using System.IO;
using System.Text.Json;

namespace CloudBridge.Client;

/// <summary>A validated control-plane origin. Parsing performs no network or identity operations.</summary>
public sealed class ClientConfiguration
{
    public const string EnvironmentVariable = "CLOUDBRIDGE_API_BASE_URL";
    public Uri ApiBaseUri { get; }
    public string Source { get; }

    private ClientConfiguration(Uri apiBaseUri, string source)
    {
        ApiBaseUri = apiBaseUri;
        Source = source;
    }

    public static string SettingsPath => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CloudBridge", "settings.json");

    public static ConfigurationResult Load() => Load(
        Environment.GetEnvironmentVariable(EnvironmentVariable),
        () =>
        {
            try { return File.ReadAllText(SettingsPath); }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
        });

    // A non-null environment value always wins, including invalid/blank values.
    // Never silently fall back to a different server after a configuration error.
    internal static ConfigurationResult Load(string? environmentValue, Func<string?> readSettings)
    {
        if (environmentValue is not null) return Parse(environmentValue, EnvironmentVariable);
        try
        {
            var contents = readSettings();
            if (contents is null)
                return new(null, "未配置服务地址。请设置环境变量 CLOUDBRIDGE_API_BASE_URL，或在本机 settings.json 中填写 apiBaseUrl。尚未连接任何服务器。");
            using var document = JsonDocument.Parse(contents);
            if (document.RootElement.ValueKind != JsonValueKind.Object)
                return InvalidSettings();
            var entries = document.RootElement.EnumerateObject()
                .Where(property => property.Name == "apiBaseUrl").ToArray();
            if (entries.Length != 1 || entries[0].Value.ValueKind != JsonValueKind.String)
                return InvalidSettings();
            return Parse(entries[0].Value.GetString()!, "settings.json");
        }
        catch (JsonException) { return InvalidSettings(); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return new(null, "无法读取本机 settings.json。请检查文件权限与内容后重新启动。尚未连接任何服务器。");
        }
    }

    private static ConfigurationResult InvalidSettings() =>
        new(null, "本机 settings.json 无效：需要一个 JSON 对象，且 apiBaseUrl 必须是唯一的字符串字段。尚未连接任何服务器。");

    internal static ConfigurationResult Parse(string value, string source)
    {
        // Only an HTTPS origin is supported. Paths, credentials, queries and fragments
        // can change relative-request routing or leak secrets, so reject rather than repair.
        var slash = value.IndexOf('/', Math.Min("https://".Length, value.Length));
        if (string.IsNullOrWhiteSpace(value) || value.Any(character => char.IsWhiteSpace(character) || char.IsControl(character)) ||
            value.IndexOfAny(['\\', '?', '#', '@']) >= 0 ||
            !value.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
            !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps ||
            uri.HostNameType == UriHostNameType.Unknown || string.IsNullOrEmpty(uri.Host) ||
            !string.IsNullOrEmpty(uri.UserInfo) || uri.Port <= 0 ||
            (slash >= 0 && value[slash..] != "/"))
        {
            return new(null, $"{source} 的服务地址无效。请使用 https://主机名[:端口]/，不要包含账号密码、路径、查询参数或片段。尚未连接任何服务器。");
        }
        return new(new ClientConfiguration(new Uri(uri.GetLeftPart(UriPartial.Authority) + "/"), source), "服务地址已配置");
    }
}

public sealed record ConfigurationResult(ClientConfiguration? Configuration, string Message)
{
    public bool IsReady => Configuration is not null;
}
