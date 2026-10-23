using System.IO;
using System.Net.Http;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;

namespace CloudBridge.Client;

internal static class UpdatePackageDownloader
{
    internal static async Task DownloadAsync(HttpClient http, Uri uri, string destination,
        ClientUpdatePolicy policy, IProgress<UpdateProgress>? progress, CancellationToken token,
        TimeSpan? idleTimeout = null, HttpClient? fallbackHttp = null)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromHours(2));
        var partial = destination + ".partial";
        RangeConditionHeaderValue? validator = null;
        try
        {
            for (var attempt = 0; ; attempt++)
            {
                try
                {
                    var received = File.Exists(partial) ? new FileInfo(partial).Length : 0;
                    // A complete file can remain after a cancellation while
                    // flushing; validate it without requesting an invalid range.
                    if (received == policy.FileSize)
                    {
                        await VerifyAndPublishAsync(partial, destination, policy, deadline.Token);
                        return;
                    }
                    using var idle = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token);
                    var idleLimit = idleTimeout ?? TimeSpan.FromSeconds(45);
                    idle.CancelAfter(idleLimit);
                    using var request = new HttpRequestMessage(HttpMethod.Get, uri);
                    if (received > 0)
                    {
                        request.Headers.Range = new RangeHeaderValue(received, null);
                        request.Headers.IfRange = validator;
                    }
                    var transport = attempt > 0 && fallbackHttp is not null ? fallbackHttp : http;
                    using var response = await transport.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, idle.Token);
                    if (attempt == 0 && fallbackHttp is not null && response.StatusCode == HttpStatusCode.Forbidden)
                        throw new HttpRequestException("当前代理拒绝下载，正在尝试直连。");
                    if (ControlTransport.IsTransient(response.StatusCode))
                        throw new HttpRequestException(ControlTransport.StatusMessage(response.StatusCode, true));
                    if (!response.IsSuccessStatusCode)
                        throw new InvalidOperationException(ControlTransport.StatusMessage(response.StatusCode, true));
                    if (response.RequestMessage?.RequestUri?.Scheme is { } scheme && scheme != Uri.UriSchemeHttps)
                        throw new InvalidOperationException("更新下载被重定向至不安全的地址，已停止下载。");
                    if (response.StatusCode == HttpStatusCode.PartialContent)
                    {
                        var range = response.Content.Headers.ContentRange;
                        if (range?.Unit != "bytes" || range.From != received ||
                            range.To != policy.FileSize - 1 || range.Length != policy.FileSize)
                            throw new InvalidOperationException("更新服务器返回的续传范围无效，已停止下载。");
                    }
                    else if (response.StatusCode == HttpStatusCode.OK)
                    {
                        // Servers without Range support return the full object.
                        received = 0;
                        validator = response.Headers.ETag is { IsWeak: false } etag
                            ? new RangeConditionHeaderValue(etag)
                            : response.Content.Headers.LastModified is { } modified
                                ? new RangeConditionHeaderValue(modified)
                                : null;
                    }
                    else throw new InvalidOperationException("更新服务器返回了无效的下载响应。");
                    if (response.Content.Headers.ContentLength is > 0 and var length && length != policy.FileSize - received)
                        throw new InvalidOperationException("更新文件长度与发布信息不一致，请联系管理员。");

                    progress?.Report(new UpdateProgress(received, policy.FileSize));
                    await using (var input = await response.Content.ReadAsStreamAsync(idle.Token))
                    await using (var output = new FileStream(partial, received > 0 ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 128 * 1024, true))
                    {
                        var buffer = new byte[128 * 1024];
                        while (true)
                        {
                            idle.CancelAfter(idleLimit);
                            var count = await input.ReadAsync(buffer, idle.Token);
                            if (count == 0) break;
                            received += count;
                            if (received > policy.FileSize)
                                throw new InvalidOperationException("更新文件长度超过发布信息，已停止下载。");
                            await output.WriteAsync(buffer.AsMemory(0, count), deadline.Token);
                            progress?.Report(new UpdateProgress(received, policy.FileSize));
                        }
                        if (received != policy.FileSize)
                            throw new HttpRequestException("更新文件下载中断，请重试。");
                        await output.FlushAsync(deadline.Token);
                    }
                    await VerifyAndPublishAsync(partial, destination, policy, deadline.Token);
                    return;
                }
                catch (Exception exception) when (!deadline.IsCancellationRequested &&
                    exception is HttpRequestException or OperationCanceledException or IOException)
                {
                    if (attempt >= 2)
                        throw new InvalidOperationException("更新下载多次中断或长时间无响应，请检查网络后点击重试。", exception);
                    await Task.Delay(TimeSpan.FromSeconds(attempt + 1), deadline.Token);
                }
            }
        }
        catch (OperationCanceledException exception) when (!token.IsCancellationRequested)
        {
            throw new InvalidOperationException("更新下载超时，请检查网络后点击重试。", exception);
        }
        finally
        {
            try { File.Delete(partial); } catch { }
        }
    }

    private static async Task VerifyAndPublishAsync(string partial, string destination, ClientUpdatePolicy policy, CancellationToken token)
    {
        await using (var package = File.OpenRead(partial))
        {
            var actualHash = Convert.ToHexString(await SHA256.HashDataAsync(package, token));
            if (!actualHash.Equals(policy.Sha256, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("更新文件安全校验失败，已停止安装。请重试或联系管理员。");
        }
        File.Move(partial, destination);
    }
}
