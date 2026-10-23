using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace CloudBridge.Client;

public sealed class ControlApiClient
{
    private readonly HttpClient _http;
    private readonly JsonSerializerOptions _json = new(JsonSerializerDefaults.Web);

    public ControlApiClient(ClientConfiguration configuration)
        : this(configuration ?? throw new ArgumentNullException(nameof(configuration)),
            ControlTransport.CreateClient(allowAutoRedirect: false)) { }

    internal ControlApiClient(ClientConfiguration configuration, HttpClient http)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(http);
        _http = http;
        _http.BaseAddress = configuration.ApiBaseUri;
    }

    public async Task<ClientUpdatePolicy> GetUpdatePolicyAsync(string version, CancellationToken token = default)
    {
        var path = $"api/client/update?platform=windows-x64&version={Uri.EscapeDataString(version)}";
        for (var attempt = 0; ; attempt++)
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(20));
            try
            {
                using var response = await _http.GetAsync(path, deadline.Token);
                if (ControlTransport.IsTransient(response.StatusCode) && attempt == 0)
                {
                    await Task.Delay(750, token);
                    continue;
                }
                if (!response.IsSuccessStatusCode)
                    throw new InvalidOperationException(ControlTransport.StatusMessage(response.StatusCode));
                return await response.Content.ReadFromJsonAsync<ClientUpdatePolicy>(_json, deadline.Token)
                    ?? throw new InvalidOperationException("更新服务响应为空，请重试。");
            }
            catch (Exception exception) when (!token.IsCancellationRequested &&
                exception is HttpRequestException or OperationCanceledException)
            {
                if (attempt == 0) { await Task.Delay(750, token); continue; }
                throw new InvalidOperationException("暂时无法连接更新服务。请检查网络后重试；这不代表设备绑定失效。", exception);
            }
            catch (JsonException exception)
            {
                throw new InvalidOperationException("更新服务返回了无效信息，请稍后重试。", exception);
            }
        }
    }

    public Task<RegisterResponse> RegisterAsync(RegisterRequest request, CancellationToken token = default) =>
        PostAsync<RegisterResponse>("api/device/register", request, token);

    public Task<ChallengeResponse> ChallengeAsync(string deviceId, CancellationToken token = default) =>
        PostAsync<ChallengeResponse>("api/device/challenge", new { deviceId }, token);

    public Task<RenewProfile> RenewAsync(RenewRequest request, CancellationToken token = default) =>
        PostAsync<RenewProfile>("api/device/renew", request, token);

    private async Task<T> PostAsync<T>(string path, object body, CancellationToken token)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromSeconds(30));
        try
        {
            // Registration and nonce consumption are not safe to retry automatically.
            using var response = await _http.PostAsJsonAsync(path, body, _json, deadline.Token);
            if (!response.IsSuccessStatusCode)
            {
                ApiError? payload = null;
                try { payload = await response.Content.ReadFromJsonAsync<ApiError>(_json, deadline.Token); }
                catch (JsonException) { }
                throw new InvalidOperationException(payload?.Error ?? ControlTransport.StatusMessage(response.StatusCode));
            }
            return await response.Content.ReadFromJsonAsync<T>(_json, deadline.Token)
                ?? throw new InvalidOperationException("服务器响应为空");
        }
        catch (Exception exception) when (!token.IsCancellationRequested &&
            exception is HttpRequestException or OperationCanceledException)
        {
            throw new InvalidOperationException("暂时无法连接服务器，请检查网络后重试。", exception);
        }
    }

    private sealed record ApiError(string Error);
}
