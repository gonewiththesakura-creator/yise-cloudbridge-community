using System.Net;
using System.Net.WebSockets;
using System.Net.Sockets;
using System.IO;
using System.Text;
using System.Text.Json;

namespace CloudBridge.Client;

public sealed class TrafficMeterService : IDisposable
{
    private CancellationTokenSource? _cancellation;
    private TcpListener? _listener;
    private long _uploaded;
    private long _downloaded;

    public void Start(int listenPort, int targetPort)
    {
        Stop();
        Interlocked.Exchange(ref _uploaded, 0);
        Interlocked.Exchange(ref _downloaded, 0);
        _cancellation = new CancellationTokenSource();
        _listener = new TcpListener(IPAddress.Loopback, listenPort);
        _listener.Start();
        _ = AcceptLoopAsync(targetPort, _cancellation.Token);
    }

    public void StartClashApi(int port)
    {
        Stop();
        Interlocked.Exchange(ref _uploaded, 0);
        Interlocked.Exchange(ref _downloaded, 0);
        _cancellation = new CancellationTokenSource();
        _ = ReadClashTrafficAsync(port, _cancellation.Token);
    }

    public TrafficSnapshot Snapshot => new(
        Interlocked.Read(ref _uploaded),
        Interlocked.Read(ref _downloaded));

    private async Task AcceptLoopAsync(int targetPort, CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested)
            {
                var client = await _listener!.AcceptTcpClientAsync(token);
                _ = HandleClientAsync(client, targetPort, token);
            }
        }
        catch (OperationCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    private async Task HandleClientAsync(TcpClient client, int targetPort, CancellationToken token)
    {
        using (client)
        using (var target = new TcpClient())
        {
            try
            {
                await target.ConnectAsync(IPAddress.Loopback, targetPort, token);
                using var clientStream = client.GetStream();
                using var targetStream = target.GetStream();
                var upload = CopyAndCountAsync(clientStream, targetStream, true, token);
                var download = CopyAndCountAsync(targetStream, clientStream, false, token);
                await Task.WhenAny(upload, download);
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
            catch (SocketException) { }
        }
    }

    private async Task CopyAndCountAsync(Stream source, Stream target, bool upload, CancellationToken token)
    {
        var buffer = new byte[32 * 1024];
        while (!token.IsCancellationRequested)
        {
            var count = await source.ReadAsync(buffer, token);
            if (count <= 0) return;
            await target.WriteAsync(buffer.AsMemory(0, count), token);
            if (upload) Interlocked.Add(ref _uploaded, count);
            else Interlocked.Add(ref _downloaded, count);
        }
    }

    private async Task ReadClashTrafficAsync(int port, CancellationToken token)
    {
        for (var attempt = 0; attempt < 20 && !token.IsCancellationRequested; attempt++)
        {
            try
            {
                using var socket = new ClientWebSocket();
                await socket.ConnectAsync(new Uri($"ws://127.0.0.1:{port}/traffic"), token);
                var buffer = new byte[8 * 1024];
                var message = new StringBuilder();
                while (socket.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    WebSocketReceiveResult result;
                    do
                    {
                        result = await socket.ReceiveAsync(buffer, token);
                        if (result.MessageType == WebSocketMessageType.Close) return;
                        message.Append(Encoding.UTF8.GetString(buffer, 0, result.Count));
                    } while (!result.EndOfMessage);

                    using var document = JsonDocument.Parse(message.ToString());
                    message.Clear();
                    var root = document.RootElement;
                    if (root.TryGetProperty("up", out var up)) Interlocked.Add(ref _uploaded, up.GetInt64());
                    if (root.TryGetProperty("down", out var down)) Interlocked.Add(ref _downloaded, down.GetInt64());
                }
                return;
            }
            catch (OperationCanceledException) { return; }
            catch (WebSocketException) { }
            catch (JsonException) { }

            try { await Task.Delay(250, token); }
            catch (OperationCanceledException) { return; }
        }
    }

    public void Stop()
    {
        _cancellation?.Cancel();
        _listener?.Stop();
        _listener = null;
        _cancellation?.Dispose();
        _cancellation = null;
    }

    public void Dispose() => Stop();
}
