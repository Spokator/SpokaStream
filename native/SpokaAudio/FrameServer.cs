using System.Buffers.Binary;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;

namespace SpokaAudio;

/// <summary>
/// Livre les images à la page par un WebSocket sur la boucle locale.
/// Ce sont des images de l'écran : le port ne répond qu'avec un jeton aléatoire, donné à la seule application.
/// La dernière image gagne : si la page prend du retard, on en saute plutôt que d'accumuler de la latence.
/// </summary>
public sealed class FrameServer : IDisposable
{
    /// <summary>[largeur:i32][hauteur:i32][horodatage en µs:i64] puis NV12.</summary>
    public const int HeaderBytes = 16;

    /// <summary>
    /// WGC n'envoie rien tant que l'écran ne change pas. Or un nouveau spectateur a besoin d'une image,
    /// et l'encodeur d'une entrée pour produire une image clé : on répète la dernière.
    /// </summary>
    private static readonly TimeSpan KeepAlive = TimeSpan.FromMilliseconds(200);

    private readonly TcpListener _listener;
    private readonly string _token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
    private readonly Lock _lock = new();
    private readonly AutoResetEvent _signal = new(false);
    private byte[] _ready = [];
    private int _readyLength;
    private bool _hasFrame;
    private volatile bool _stopped;
    private TcpClient? _client;

    public string Url { get; }

    /// <summary>Une seule horloge pour les images capturées et les images répétées.</summary>
    public static long NowMicroseconds() => (long)(Stopwatch.GetTimestamp() * (1_000_000.0 / Stopwatch.Frequency));

    public FrameServer()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Url = $"ws://127.0.0.1:{((IPEndPoint)_listener.LocalEndpoint).Port}/{_token}";
        new Thread(AcceptLoop) { IsBackground = true, Name = "images" }.Start();
    }

    /// <summary>Prend le tampon rempli, rend un tampon libre à remplir pour l'image suivante.</summary>
    public byte[] Publish(byte[] filled, int length)
    {
        lock (_lock)
        {
            var free = _ready;
            _ready = filled;
            _readyLength = length;
            _hasFrame = true;
            _signal.Set();
            return free;
        }
    }

    /// <summary>Chaque connexion a son fil : un client muet ou indiscret ne doit jamais retarder la vraie page.</summary>
    private void AcceptLoop()
    {
        while (!_stopped)
        {
            TcpClient client;
            try
            {
                client = _listener.AcceptTcpClient();
            }
            catch (SocketException)
            {
                return;
            }
            new Thread(() => Handle(client)) { IsBackground = true, Name = "images" }.Start();
        }
    }

    private void Handle(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.NoDelay = true;
                client.SendBufferSize = 8 * 1024 * 1024;
                var stream = client.GetStream();
                stream.ReadTimeout = 2000;
                Serve(client, stream);
            }
            catch (Exception e) when (e is IOException or SocketException or WebSocketException or ObjectDisposedException)
            {
                // La page a fermé ou s'est rechargée : elle peut revenir avec le jeton.
            }
        }
    }

    private void Serve(TcpClient client, NetworkStream stream)
    {
        var request = ReadRequest(stream);
        if (request is null || request.Value.Path != $"/{_token}")
        {
            stream.Write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"u8);
            return;
        }
        // Une page rechargée remplace la précédente : deux lecteurs se voleraient les images.
        Interlocked.Exchange(ref _client, client)?.Close();
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(request.Value.Key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")));
        stream.Write(Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"));
        using var socket = WebSocket.CreateFromStream(stream, true, null, TimeSpan.Zero);

        var mine = Array.Empty<byte>();
        var length = 0;
        while (!_stopped && socket.State == WebSocketState.Open)
        {
            _signal.WaitOne(KeepAlive);
            lock (_lock)
            {
                if (_hasFrame)
                {
                    (mine, _ready) = (_ready, mine);
                    length = _readyLength;
                    _hasFrame = false;
                }
                else if (length > 0)
                {
                    BinaryPrimitives.WriteInt64LittleEndian(mine.AsSpan(8), NowMicroseconds());
                }
            }
            if (length > 0) socket.SendAsync(mine.AsMemory(0, length), WebSocketMessageType.Binary, true, CancellationToken.None).AsTask().GetAwaiter().GetResult();
        }
    }

    private static (string Path, string Key)? ReadRequest(NetworkStream stream)
    {
        var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, leaveOpen: true);
        var first = reader.ReadLine()?.Split(' ');
        if (first is not { Length: >= 2 }) return null;
        string? key = null;
        while (reader.ReadLine() is { Length: > 0 } line)
        {
            if (line.StartsWith("Sec-WebSocket-Key:", StringComparison.OrdinalIgnoreCase)) key = line[18..].Trim();
        }
        return key is null ? null : (first[1], key);
    }

    public void Dispose()
    {
        _stopped = true;
        _signal.Set();
        _listener.Stop();
        _client?.Close();
    }
}
