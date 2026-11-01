using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using System.Text;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace SpokaAudio;

/// <summary>
/// La capture de jeu, côté moteur : charge SpokaHook.dll dans un jeu OpenGL et reprend les images qu'elle dépose en mémoire partagée.
/// Discord et OBS font ainsi : WGC ne convient pas au plein écran exclusif, et y fait disparaître la souris du joueur.
/// Le jeu ne dessine pas le curseur dans son image : c'est ici qu'il est posé pour les spectateurs.
/// Charger du code dans un jeu peut déplaire à un anti-triche : cette capture n'existe que sur demande explicite, et AntiCheat a le dernier mot.
/// </summary>
public sealed unsafe class GameCapture : IVideoCapture
{
    // Doit rester identique à SpokaHook.cpp.
    private const uint Magic = 0x53504B47;
    private const int MaxWidth = 3840;
    private const int MaxHeight = 2160;
    private const int HeaderBytes = 64;
    private const long SlotBytes = (long)MaxWidth * MaxHeight * 4;
    private const int StopOffset = 4;
    private const int IntervalOffset = 8;
    private const int LatestOffset = 12;
    private const int ReadingOffset = 16;
    private const int WidthOffset = 20;
    private const int HeightOffset = 28;
    private const int HeartbeatOffset = 36;

    private const int FirstFrameMs = 2500;
    private const int WaitMs = 200;
    private const uint ProcessInject = 0x043A;
    private const uint ProcessQueryLimited = 0x1000;
    private const uint CommitReserve = 0x3000;
    private const uint PageReadWrite = 4;
    private const uint Release = 0x8000;

    private readonly MemoryMappedFile _mapping;
    private readonly MemoryMappedViewAccessor _view;
    private readonly byte* _shared;
    private readonly EventWaitHandle _frameReady;
    private readonly ID3D11Device _device;
    private readonly ID3D11DeviceContext _context;
    private readonly FrameServer _server = new();
    private readonly CursorPainter _cursor = new();
    private readonly Lock _lock = new();
    private readonly Action _onClosed;
    private readonly IntPtr _window;
    private readonly Thread _thread;

    private FrameConverter? _converter;
    private ID3D11Texture2D? _frame;
    private byte[] _pixels = [];
    private byte[] _buffer = [];
    private int _width;
    private int _height;
    private int _maxHeight;
    private double _pace;
    private double _deadline;
    private volatile bool _stopping;

    public string Url => _server.Url;
    public int Width { get; private set; }
    public int Height { get; private set; }

    /// <summary>
    /// Rend null si on ne doit pas entrer dans ce processus, ou si aucune image n'arrive : l'appelant revient à WGC.
    /// status dit pourquoi : active, failed (entré, mais rien ne sort), protected (anti-triche), unsupported (pas un jeu OpenGL 64 bits).
    /// </summary>
    public static GameCapture? TryStart(IntPtr window, int fps, int maxHeight, Action onClosed, out string status)
    {
        status = "unsupported";
        if (window == IntPtr.Zero) return null;
        GetWindowThreadProcessId(window, out var pid);
        var hook = Path.Combine(AppContext.BaseDirectory, "SpokaHook.dll");
        if (pid == 0 || !File.Exists(hook) || IsBrowserWindow(window)) return null;

        // Dans cet ordre : ni le chemin ni le 32 bits ne demandent d'ouvrir le jeu, et un jeu protégé n'est jamais lu.
        var path = Inspect(pid, out var is32Bits);
        if (path is null || AntiCheat.Protects(path))
        {
            status = "protected";
            return null;
        }
        if (is32Bits || !UsesOpenGl(pid)) return null;

        var capture = new GameCapture(window, pid, fps, maxHeight, onClosed);
        if (Inject(pid, hook) && capture.WaitForFirstFrame())
        {
            status = "active";
            return capture;
        }
        capture.Dispose();
        status = "failed";
        return null;
    }

    /// <summary>Chromium et Firefox chargent OpenGL pour leurs pages, sans être des jeux : la DLL resterait en eux pour rien.</summary>
    private static bool IsBrowserWindow(IntPtr window)
    {
        var name = new StringBuilder(64);
        GetClassNameW(window, name, name.Capacity);
        var kind = name.ToString();
        return kind.StartsWith("Chrome_WidgetWin", StringComparison.Ordinal) || kind == "MozillaWindowClass";
    }

    /// <summary>Rend le chemin du processus, ou null si Windows refuse même ça : c'est alors un processus protégé.</summary>
    private static string? Inspect(uint pid, out bool is32Bits)
    {
        is32Bits = false;
        var process = OpenProcess(ProcessQueryLimited, false, pid);
        if (process == IntPtr.Zero) return null;
        try
        {
            // Lancer LoadLibraryW 64 bits dans un processus 32 bits le ferait planter : il faut le savoir avant.
            if (!IsWow64Process2(process, out var machine, out _)) return null;
            is32Bits = machine != 0;
            var path = new StringBuilder(1024);
            var length = (uint)path.Capacity;
            return QueryFullProcessImageNameW(process, 0, path, ref length) ? path.ToString() : null;
        }
        finally
        {
            CloseHandle(process);
        }
    }

    /// <summary>On n'entre que dans un processus qui a chargé OpenGL.</summary>
    private static bool UsesOpenGl(uint pid)
    {
        try
        {
            using var process = Process.GetProcessById((int)pid);
            foreach (ProcessModule module in process.Modules)
            {
                if (string.Equals(module.ModuleName, "opengl32.dll", StringComparison.OrdinalIgnoreCase)) return true;
            }
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or ArgumentException)
        {
            return false;
        }
        return false;
    }

    private static bool Inject(uint pid, string hook)
    {
        var process = OpenProcess(ProcessInject, false, pid);
        if (process == IntPtr.Zero) return false;
        var bytes = Encoding.Unicode.GetBytes(hook + "\0");
        var remote = IntPtr.Zero;
        try
        {
            remote = VirtualAllocEx(process, IntPtr.Zero, (nuint)bytes.Length, CommitReserve, PageReadWrite);
            if (remote == IntPtr.Zero || !WriteProcessMemory(process, remote, bytes, (nuint)bytes.Length, out _)) return false;
            var load = GetProcAddress(GetModuleHandleW("kernel32.dll"), "LoadLibraryW");
            var thread = CreateRemoteThread(process, IntPtr.Zero, 0, load, remote, 0, IntPtr.Zero);
            if (thread == IntPtr.Zero) return false;
            WaitForSingleObject(thread, 3000);
            CloseHandle(thread);
            return true;
        }
        finally
        {
            if (remote != IntPtr.Zero) VirtualFreeEx(process, remote, 0, Release);
            CloseHandle(process);
        }
    }

    private GameCapture(IntPtr window, uint pid, int fps, int maxHeight, Action onClosed)
    {
        _window = window;
        _onClosed = onClosed;
        _maxHeight = maxHeight;
        _pace = Stopwatch.Frequency / (double)fps;
        _mapping = MemoryMappedFile.CreateOrOpen($@"Local\SpokaGameFrames-{pid}", HeaderBytes + 2 * SlotBytes);
        _view = _mapping.CreateViewAccessor();
        byte* pointer = null;
        _view.SafeMemoryMappedViewHandle.AcquirePointer(ref pointer);
        _shared = pointer;
        _frameReady = new EventWaitHandle(false, EventResetMode.AutoReset, $@"Local\SpokaGameFrame-{pid}");

        Volatile.Write(ref *(int*)(_shared + StopOffset), 0);
        Volatile.Write(ref *(int*)(_shared + IntervalOffset), (int)(1_000_000 / fps));
        Volatile.Write(ref *(int*)(_shared + LatestOffset), -1);
        Volatile.Write(ref *(int*)(_shared + ReadingOffset), -1);
        Volatile.Write(ref *(uint*)_shared, Magic);

        D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
            [FeatureLevel.Level_11_1, FeatureLevel.Level_11_0], out ID3D11Device? device, out ID3D11DeviceContext? context).CheckError();
        _device = device!;
        _context = context!;
        using (var multithread = _context.QueryInterface<ID3D11Multithread>()) multithread.SetMultithreadProtected(true);
        _thread = new Thread(Loop) { IsBackground = true, Name = "jeu" };
    }

    private bool WaitForFirstFrame()
    {
        var limit = Stopwatch.StartNew();
        while (limit.ElapsedMilliseconds < FirstFrameMs)
        {
            _frameReady.WaitOne(50);
            var slot = Volatile.Read(ref *(int*)(_shared + LatestOffset));
            if (slot is not (0 or 1)) continue;
            (Width, Height) = FrameConverter.OutputSize(*(int*)(_shared + WidthOffset + slot * 4), *(int*)(_shared + HeightOffset + slot * 4), _maxHeight);
            _thread.Start();
            return true;
        }
        return false;
    }

    private void Loop()
    {
        while (!_stopping)
        {
            if (!IsWindow(_window))
            {
                _onClosed();
                return;
            }
            if (!_frameReady.WaitOne(WaitMs)) continue;
            double now = Stopwatch.GetTimestamp();
            lock (_lock)
            {
                if (_stopping || now < _deadline - _pace * 0.25) continue;
                _deadline = Math.Max(_deadline + _pace, now);
                Publish();
            }
        }
    }

    private void Publish()
    {
        var slot = Volatile.Read(ref *(int*)(_shared + LatestOffset));
        if (slot is not (0 or 1)) return;
        Volatile.Write(ref *(int*)(_shared + ReadingOffset), slot);
        var width = *(int*)(_shared + WidthOffset + slot * 4);
        var height = *(int*)(_shared + HeightOffset + slot * 4);
        if (width is < 2 or > MaxWidth || height is < 2 or > MaxHeight)
        {
            Volatile.Write(ref *(int*)(_shared + ReadingOffset), -1);
            return;
        }
        if (width != _width || height != _height || _converter is null) Rebuild(width, height);

        // OpenGL range ses lignes du bas vers le haut.
        var stride = width * 4;
        var source = _shared + HeaderBytes + slot * SlotBytes;
        fixed (byte* target = _pixels)
        {
            for (var y = 0; y < height; y++) Buffer.MemoryCopy(source + (height - 1 - y) * (long)stride, target + y * (long)stride, stride, stride);
            Volatile.Write(ref *(int*)(_shared + ReadingOffset), -1);
            _cursor.Paint(_window, target, width, height);
            _context.UpdateSubresource(_frame!, 0, null, (IntPtr)target, (uint)stride, 0);
        }

        var length = FrameServer.HeaderBytes + _converter!.FrameBytes;
        if (_buffer.Length < length) _buffer = new byte[length];
        BinaryPrimitives.WriteInt32LittleEndian(_buffer.AsSpan(0), _converter.Width);
        BinaryPrimitives.WriteInt32LittleEndian(_buffer.AsSpan(4), _converter.Height);
        BinaryPrimitives.WriteInt64LittleEndian(_buffer.AsSpan(8), FrameServer.NowMicroseconds());
        _converter.Convert(_frame!, _buffer, FrameServer.HeaderBytes);
        _buffer = _server.Publish(_buffer, length);
    }

    private void Rebuild(int width, int height)
    {
        _converter?.Dispose();
        _frame?.Dispose();
        _width = width;
        _height = height;
        _pixels = new byte[width * height * 4];
        _frame = _device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)width,
            Height = (uint)height,
            MipLevels = 1,
            ArraySize = 1,
            Format = Format.B8G8R8A8_UNorm,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default,
            BindFlags = BindFlags.ShaderResource | BindFlags.RenderTarget,
        });
        _converter = new FrameConverter(_device, _context, width, height, _maxHeight);
        (Width, Height) = (_converter.Width, _converter.Height);
    }

    public void Configure(int fps, int maxHeight)
    {
        lock (_lock)
        {
            _pace = Stopwatch.Frequency / (double)fps;
            Volatile.Write(ref *(int*)(_shared + IntervalOffset), (int)(1_000_000 / fps));
            if (maxHeight == _maxHeight) return;
            _maxHeight = maxHeight;
            _converter?.Dispose();
            _converter = null;
        }
    }

    public void Dispose()
    {
        _stopping = true;
        // La DLL reste dans le jeu jusqu'à sa fermeture : la décharger pendant qu'il tourne serait le vrai danger. Elle cesse juste de lire.
        Volatile.Write(ref *(int*)(_shared + StopOffset), 1);
        _frameReady.Set();
        if (_thread.IsAlive) _thread.Join(TimeSpan.FromSeconds(2));
        lock (_lock)
        {
            _converter?.Dispose();
            _frame?.Dispose();
        }
        _cursor.Dispose();
        _server.Dispose();
        _context.Dispose();
        _device.Dispose();
        _view.SafeMemoryMappedViewHandle.ReleasePointer();
        _view.Dispose();
        _mapping.Dispose();
        _frameReady.Dispose();
    }

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr window, StringBuilder name, int capacity);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, nuint size, uint type, uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool VirtualFreeEx(IntPtr process, IntPtr address, nuint size, uint type);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, nuint size, out nuint written);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateRemoteThread(IntPtr process, IntPtr attributes, nuint stack, IntPtr start, IntPtr parameter, uint flags, IntPtr id);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandleW(string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr module, string name);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}

/// <summary>Pose le curseur système sur une image BGRA. Chaque forme n'est dessinée qu'une fois : le curseur change rarement.</summary>
internal sealed unsafe class CursorPainter : IDisposable
{
    private const int Size = 64;
    private const int CursorShowing = 1;
    private const uint DiNormal = 3;

    private readonly IntPtr _dc = CreateCompatibleDC(IntPtr.Zero);
    private readonly byte[] _shape = new byte[Size * Size * 4];
    private IntPtr _current;
    private int _hotX;
    private int _hotY;

    public void Paint(IntPtr window, byte* target, int width, int height)
    {
        var info = new CursorInfo { Size = Marshal.SizeOf<CursorInfo>() };
        if (!GetCursorInfo(ref info) || info.Flags != CursorShowing || info.Cursor == IntPtr.Zero) return;
        var origin = new Point();
        if (!ClientToScreen(window, ref origin)) return;
        if (info.Cursor != _current) Load(info.Cursor);
        var left = info.X - origin.X - _hotX;
        var top = info.Y - origin.Y - _hotY;
        for (var y = Math.Max(0, -top); y < Size && top + y < height; y++)
        {
            for (var x = Math.Max(0, -left); x < Size && left + x < width; x++)
            {
                var from = (y * Size + x) * 4;
                var alpha = _shape[from + 3];
                if (alpha == 0) continue;
                var to = target + ((long)(top + y) * width + left + x) * 4;
                var keep = 255 - alpha;
                for (var c = 0; c < 3; c++) to[c] = (byte)Math.Min(255, _shape[from + c] + to[c] * keep / 255);
            }
        }
    }

    /// <summary>Dessiné sur du noir puis sur du blanc : la différence donne la transparence, quelle que soit la forme du curseur.</summary>
    private void Load(IntPtr cursor)
    {
        _current = cursor;
        (_hotX, _hotY) = (0, 0);
        if (GetIconInfo(cursor, out var icon))
        {
            (_hotX, _hotY) = (icon.HotX, icon.HotY);
            if (icon.Mask != IntPtr.Zero) DeleteObject(icon.Mask);
            if (icon.Color != IntPtr.Zero) DeleteObject(icon.Color);
        }
        var header = new BitmapInfo { Size = Marshal.SizeOf<BitmapInfo>(), Width = Size, Height = -Size, Planes = 1, BitCount = 32 };
        var bitmap = CreateDIBSection(_dc, ref header, 0, out var bits, IntPtr.Zero, 0);
        if (bitmap == IntPtr.Zero) return;
        var previous = SelectObject(_dc, bitmap);
        var pixels = (byte*)bits;
        var black = new byte[_shape.Length];
        new Span<byte>(pixels, _shape.Length).Clear();
        DrawIconEx(_dc, 0, 0, cursor, Size, Size, 0, IntPtr.Zero, DiNormal);
        GdiFlush();
        new Span<byte>(pixels, _shape.Length).CopyTo(black);
        new Span<byte>(pixels, _shape.Length).Fill(255);
        DrawIconEx(_dc, 0, 0, cursor, Size, Size, 0, IntPtr.Zero, DiNormal);
        GdiFlush();
        for (var i = 0; i < _shape.Length; i += 4)
        {
            var alpha = 255 - (pixels[i + 1] - black[i + 1]);
            _shape[i] = black[i];
            _shape[i + 1] = black[i + 1];
            _shape[i + 2] = black[i + 2];
            _shape[i + 3] = (byte)Math.Clamp(alpha, 0, 255);
        }
        SelectObject(_dc, previous);
        DeleteObject(bitmap);
    }

    public void Dispose() => DeleteDC(_dc);

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct CursorInfo
    {
        public int Size;
        public int Flags;
        public IntPtr Cursor;
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IconInfo
    {
        public bool IsIcon;
        public int HotX;
        public int HotY;
        public IntPtr Mask;
        public IntPtr Color;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfo
    {
        public int Size;
        public int Width;
        public int Height;
        public short Planes;
        public short BitCount;
        public int Compression;
        public int SizeImage;
        public int XPelsPerMeter;
        public int YPelsPerMeter;
        public int ClrUsed;
        public int ClrImportant;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorInfo(ref CursorInfo info);

    [DllImport("user32.dll")]
    private static extern bool GetIconInfo(IntPtr icon, out IconInfo info);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr window, ref Point point);

    [DllImport("user32.dll")]
    private static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, uint step, IntPtr brush, uint flags);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateCompatibleDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteDC(IntPtr dc);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, uint usage, out IntPtr bits, IntPtr section, uint offset);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SelectObject(IntPtr dc, IntPtr value);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr value);

    [DllImport("gdi32.dll")]
    private static extern bool GdiFlush();
}
