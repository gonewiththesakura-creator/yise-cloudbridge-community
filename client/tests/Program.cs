using System.Net;
using System.Text;
using CloudBridge.Client;

// Dependency-free behavior harness. HTTP uses only RecordingHandler below.
// No socket, live service, Windows identity, proxy or executable is used.
var passed = 0;
void Run(string name, Action check)
{
    check();
    passed++;
    Console.WriteLine($"PASS {name}");
}
void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
ClientConfiguration Required(string input)
{
    var result = ClientConfiguration.Load(input, () => throw new Exception("Unexpected settings read"));
    return result.Configuration ?? throw new Exception(result.Message);
}

Run("unset configuration is not ready", () =>
{
    var result = ClientConfiguration.Load(null, () => null);
    Assert(!result.IsReady && result.Configuration is null, "Unset configuration must fail closed");
    Assert(result.Message.Contains("CLOUDBRIDGE_API_BASE_URL"), "Missing configuration needs actionable instructions");
});
Run("environment takes precedence without reading settings", () =>
{
    var settings = Required("https://control.example.invalid:8443");
    Assert(settings.ApiBaseUri.AbsoluteUri == "https://control.example.invalid:8443/", "Origin must be normalized with trailing slash");
    Assert(settings.Source == ClientConfiguration.EnvironmentVariable, "Configuration source is explicit");
});
Run("valid local settings", () =>
{
    var result = ClientConfiguration.Load(null, () => "{\"apiBaseUrl\":\"https://local.example.invalid/\"}");
    Assert(result.IsReady && result.Configuration?.ApiBaseUri.Host == "local.example.invalid", "Local settings not loaded");
});
foreach (var input in new[]
{
    "", " ", "http://example.invalid/", "ftp://example.invalid/", "//example.invalid/", "https://",
    "https://user:password@example.invalid/", "https://example.invalid/api", "https://example.invalid/../",
    "https://example.invalid/?token=secret", "https://example.invalid/#fragment", "https://example.invalid/?",
    "https://example.invalid/#", "https://example.invalid\\other", "https://example.invalid:0/",
    "https://example.invalid:65536/", " https://example.invalid/", "https://example.invalid/\n",
})
{
    Run($"reject invalid explicit origin: {input.Replace("\n", "\\n")}", () =>
    {
        var result = ClientConfiguration.Load(input, () => throw new Exception("Must not fall back after invalid environment"));
        Assert(!result.IsReady && result.Configuration is null, "Invalid origin must not produce an API configuration");
        Assert(!result.Message.Contains("password"), "Do not echo rejected credentials");
    });
}
foreach (var input in new[] { "{", "null", "[]", "{}", "{\"apiBaseUrl\":null}", "{\"apiBaseUrl\":12}", "{\"apiBaseUrl\":\"https://a.invalid/\",\"apiBaseUrl\":\"https://b.invalid/\"}" })
{
    Run("reject malformed or ambiguous local JSON", () =>
        Assert(!ClientConfiguration.Load(null, () => input).IsReady, "Invalid JSON settings must fail closed"));
}
Run("unreadable settings fail closed", () =>
    Assert(!ClientConfiguration.Load(null, () => throw new UnauthorizedAccessException()).IsReady, "Unreadable settings must not fall back"));
Run("settings I/O errors fail closed", () =>
    Assert(!ClientConfiguration.Load(null, () => throw new IOException()).IsReady, "I/O errors must not fall back"));
Run("HTTPS IPv6 origin and custom port are supported", () =>
    Assert(Required("https://[::1]:8443/").ApiBaseUri.Port == 8443, "Valid IPv6 origin rejected"));

using (var handler = new RecordingHandler())
using (var http = new HttpClient(handler))
{
    var api = new ControlApiClient(Required("https://control.example.invalid:8443/"), http);
    await api.GetUpdatePolicyAsync("2.6.0 & test");
    Run("update request uses configured origin and escaped version", () =>
    {
        Assert(handler.Requests.Count == 1, "Unexpected request count");
        Assert(handler.Requests[0].AbsoluteUri == "https://control.example.invalid:8443/api/client/update?platform=windows-x64&version=2.6.0%20%26%20test", "Wrong update target");
    });
    await api.RegisterAsync(new RegisterRequest("test-only", "test-only", "test-only", "test-only", "test-only", "2.6.0"));
    Run("registration uses the same configured origin", () =>
        Assert(handler.Requests[1].AbsoluteUri == "https://control.example.invalid:8443/api/device/register", "Wrong registration target"));
}
using (var handler = new RecordingHandler(HttpStatusCode.Redirect))
using (var http = new HttpClient(handler))
{
    var api = new ControlApiClient(Required("https://control.example.invalid/"), http);
    var rejected = false;
    try { await api.GetUpdatePolicyAsync("2.6.0"); }
    catch (InvalidOperationException) { rejected = true; }
    Run("API redirect responses are not accepted as success", () =>
        Assert(rejected && handler.Requests.Count == 1, "Redirect must fail without retry"));
}
Run("API construction requires validated configuration", () =>
{
    using var handler = new RecordingHandler();
    using var http = new HttpClient(handler);
    var rejected = false;
    try { _ = new ControlApiClient(null!, http); }
    catch (ArgumentNullException) { rejected = true; }
    Assert(rejected && handler.Requests.Count == 0, "No API request is allowed without configuration");
});
Console.WriteLine($"{passed} configuration/API behavior checks passed; no real network or device access.");

sealed class RecordingHandler(HttpStatusCode status = HttpStatusCode.OK) : HttpMessageHandler
{
    public List<Uri> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Requests.Add(request.RequestUri!);
        var payload = request.Method == HttpMethod.Post
            ? "{\"deviceId\":\"test-only\",\"nonce\":\"test-only\",\"purpose\":\"test-only\",\"expiresInSeconds\":30}"
            : "{\"available\":false}";
        return Task.FromResult(new HttpResponseMessage(status)
        {
            Content = new StringContent(payload, Encoding.UTF8, "application/json"),
            RequestMessage = request,
        });
    }
}
