using System.Buffers.Binary;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace SpokaAudio;

/// <summary>
/// Moteur audio natif de SpokaStream, piloté par l'application.
///   stdin  : une commande JSON par ligne {"id":1,"cmd":"sessions"}
///   stdout : trames [type:u8][longueur:u32 LE][contenu]
///            type 1 = JSON UTF-8 (réponses et événements)
///            type 2 = audio : [captureId:u16 LE][float32 stéréo entrelacé, 48 kHz]
/// Sans commande pendant la fermeture de stdin, le moteur s'arrête : il ne survit jamais à l'application.
/// </summary>
internal static class Program
{
    private const byte FrameJson = 1;
    private const byte FrameAudio = 2;

    private static readonly Stream Output = Console.OpenStandardOutput();
    private static readonly Lock OutputLock = new();
    private static readonly Dictionary<int, ProcessLoopback> Captures = [];
    private static IVideoCapture? _video;
    private static RemoteInput? _input;

    private static int Main()
    {
        // Sans ça, Windows ment sur les positions dès que l'écran est mis à l'échelle : les clics tomberaient à côté.
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        using var remote = new RemoteInput(blocked => SendEvent(new JsonObject { ["evt"] = "input.blocked", ["blocked"] = blocked }));
        _input = remote;
        using var keys = new KeyWatcher((key, down) => SendEvent(new JsonObject { ["evt"] = "key", ["key"] = key, ["down"] = down }));
        SendEvent(new JsonObject { ["evt"] = "ready", ["version"] = 1, ["processLoopback"] = Environment.OSVersion.Version.Build >= 19041 });

        using var input = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        while (input.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            JsonObject? request = null;
            try
            {
                request = JsonNode.Parse(line)?.AsObject();
                if (request is null) continue;
                var result = Handle(request, keys);
                if (request["id"] is not null) Reply(request, result, null);
            }
            catch (Exception e)
            {
                if (request?["id"] is not null) Reply(request, null, e.Message);
            }
        }

        foreach (var capture in Captures.Values) capture.Dispose();
        _video?.Dispose();
        return 0;
    }

    private static JsonNode? Handle(JsonObject request, KeyWatcher keys)
    {
        switch ((string?)request["cmd"])
        {
            case "sessions":
            {
                var list = new JsonArray();
                foreach (var app in Sessions.List())
                    list.Add(new JsonObject { ["pid"] = app.Pid, ["name"] = app.Name, ["path"] = app.Path, ["title"] = app.Title, ["peak"] = app.Peak });
                return list;
            }
            case "capture.start":
            {
                var id = (int)request["captureId"]!;
                var exclude = (string?)request["mode"] == "exclude";
                var pid = (int)request["pid"]!;
                StopCapture(id);
                var capture = new ProcessLoopback(pid, exclude, (samples, count) => SendAudio(id, samples, count),
                    message => SendEvent(new JsonObject { ["evt"] = "capture.error", ["captureId"] = id, ["message"] = message }));
                lock (Captures) Captures[id] = capture;
                capture.Start();
                return null;
            }
            case "capture.stop":
                StopCapture((int)request["captureId"]!);
                return null;
            case "window.app":
            {
                var pid = Windows.ProcessOf((long)request["hwnd"]!);
                if (pid is null) return null;
                var root = ProcessTree.RootOf(pid.Value);
                var (name, path, title) = Sessions.Describe(root);
                return new JsonObject { ["pid"] = root, ["name"] = name, ["path"] = path, ["title"] = title };
            }
            case "window.rect":
            {
                var rect = Windows.RectOf((long)request["hwnd"]!);
                return rect is null ? null : new JsonObject { ["x"] = rect.Value.X, ["y"] = rect.Value.Y, ["width"] = rect.Value.Width, ["height"] = rect.Value.Height };
            }
            case "input":
                _input!.Apply(request["events"]!.AsArray());
                return null;
            case "input.arm":
                _input!.Arm((long?)request["hwnd"] ?? 0, (int?)request["x"] ?? 0, (int?)request["y"] ?? 0, (int)request["appPid"]!);
                return null;
            case "input.disarm":
                _input!.Disarm();
                return null;
            case "keys.watch":
                keys.Watch(request["keys"]!.AsArray().Select(k => (int)k!));
                return null;
            case "video.start":
            {
                _video?.Dispose();
                _video = null;
                var hwnd = request["hwnd"] is { } window ? new IntPtr((long)window) : IntPtr.Zero;
                var monitor = hwnd == IntPtr.Zero ? Windows.MonitorAt((int)request["x"]!, (int)request["y"]!) : IntPtr.Zero;
                string? url = null;
                var fps = (int)request["fps"]!;
                var maxHeight = (int)request["maxHeight"]!;
                void Ended() => SendEvent(new JsonObject { ["evt"] = "video.ended", ["url"] = url });
                var compat = (bool?)request["compat"] == true;
                IVideoCapture? capture = compat ? DesktopDuplication.TryStart(hwnd, monitor, fps, maxHeight, Ended) : null;
                var duplicated = capture is not null;
                capture ??= ScreenCapture.TryStart(hwnd, monitor, fps, maxHeight, Ended);
                if (capture is null) return null;
                _video = capture;
                url = capture.Url;
                return new JsonObject { ["url"] = url, ["width"] = capture.Width, ["height"] = capture.Height, ["compatFailed"] = compat && !duplicated };
            }
            case "video.configure":
                _video?.Configure((int)request["fps"]!, (int)request["maxHeight"]!);
                return null;
            case "video.stop":
                if (_video?.Url == (string?)request["url"])
                {
                    _video?.Dispose();
                    _video = null;
                }
                return null;
            default:
                throw new InvalidOperationException($"commande inconnue : {request["cmd"]}");
        }
    }

    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    private static void StopCapture(int id)
    {
        ProcessLoopback? capture;
        lock (Captures)
        {
            if (!Captures.Remove(id, out capture)) return;
        }
        capture.Dispose();
    }

    private static void Reply(JsonObject? request, JsonNode? result, string? error)
    {
        var reply = new JsonObject { ["id"] = request?["id"]?.DeepClone() };
        if (error is null) reply["result"] = result;
        else reply["error"] = error;
        SendEvent(reply);
    }

    private static void SendEvent(JsonObject payload)
    {
        var bytes = Encoding.UTF8.GetBytes(payload.ToJsonString());
        Span<byte> header = stackalloc byte[5];
        header[0] = FrameJson;
        BinaryPrimitives.WriteUInt32LittleEndian(header[1..], (uint)bytes.Length);
        lock (OutputLock)
        {
            Output.Write(header);
            Output.Write(bytes);
            Output.Flush();
        }
    }

    private static void SendAudio(int captureId, float[] samples, int count)
    {
        var payloadLength = 2 + count * sizeof(float);
        Span<byte> header = stackalloc byte[7];
        header[0] = FrameAudio;
        BinaryPrimitives.WriteUInt32LittleEndian(header[1..], (uint)payloadLength);
        BinaryPrimitives.WriteUInt16LittleEndian(header[5..], (ushort)captureId);
        lock (OutputLock)
        {
            Output.Write(header);
            Output.Write(System.Runtime.InteropServices.MemoryMarshal.AsBytes(samples.AsSpan(0, count)));
            Output.Flush();
        }
    }
}
