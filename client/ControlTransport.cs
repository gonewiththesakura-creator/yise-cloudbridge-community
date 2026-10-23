using System.Net;
using System.Net.Http;

namespace CloudBridge.Client;

internal static class ControlTransport
{
    // The control plane must work before the local proxy has started, including
    // when Windows still points at a stopped proxy from a previous session.
    internal static HttpClient CreateClient(bool useProxy = false, bool allowAutoRedirect = true) => new(new SocketsHttpHandler
    {
        UseProxy = useProxy,
        // API callers reject redirects instead of forwarding device data to another origin.
        AllowAutoRedirect = allowAutoRedirect,
        ConnectTimeout = TimeSpan.FromSeconds(12),
        PooledConnectionLifetime = TimeSpan.FromMinutes(5),
        AutomaticDecompression = DecompressionMethods.None,
    }) { Timeout = Timeout.InfiniteTimeSpan };

    internal static bool IsTransient(HttpStatusCode status) =>
        status is HttpStatusCode.RequestTimeout or HttpStatusCode.TooManyRequests || (int)status >= 500;

    internal static string StatusMessage(HttpStatusCode status, bool download = false) => status switch
    {
        HttpStatusCode.Forbidden => download
            ? "下载服务器拒绝访问（403）。请稍后重试；若仍失败，请联系管理员检查安装包访问权限。"
            : "服务器拒绝访问（403），请联系管理员。",
        HttpStatusCode.NotFound => download ? "更新安装包暂未就绪（404），请稍后重试。" : "服务地址不存在（404），请联系管理员。",
        HttpStatusCode.TooManyRequests => "请求过于频繁，请稍后重试。",
        _ => $"服务器暂时无法完成请求（{(int)status}），请稍后重试。",
    };
}
