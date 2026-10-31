using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Vortice.Mathematics;

namespace SpokaAudio;

/// <summary>Ce que l'application attend d'une capture, quelle que soit la méthode.</summary>
public interface IVideoCapture : IDisposable
{
    string Url { get; }
    int Width { get; }
    int Height { get; }
    void Configure(int fps, int maxHeight);
}

/// <summary>
/// Capture par duplication du bureau, sans Windows.Graphics.Capture.
/// WGC force le curseur logiciel, dessiné par le compositeur. Dans un jeu OpenGL ou Vulkan qui présente sans passer par lui,
/// plus personne ne le dessine : la vraie souris disparaît de l'écran du joueur (microsoft/Windows.UI.Composition-Win32-Samples#128).
/// Ici le curseur reste matériel. La duplication ne le met pas dans l'image : c'est à nous de le poser dessus.
/// Une fenêtre se découpe dans l'image de l'écran : ce qui passe devant elle part donc avec.
/// </summary>
public sealed class DesktopDuplication : IVideoCapture
{
    private const double TransportBytesPerSecond = 340e6;
    private const int MinimumUsefulFps = 48;
    private const uint AcquireTimeoutMs = 100;
    private const int RetryMs = 250;
    private const int ShapeMonochrome = 1;
    private const int ShapeColor = 2;
    private const int ShapeMasked = 4;

    private readonly ID3D11Device _device;
    private readonly ID3D11DeviceContext _context;
    private readonly IDXGIOutput1 _output;
    private readonly FrameServer _server = new();
    private readonly Lock _lock = new();
    private readonly Action _onClosed;
    private readonly IntPtr _window;
    private readonly Thread _thread;

    private IDXGIOutputDuplication? _duplication;
    private FrameConverter? _converter;
    private ID3D11Texture2D? _frame;
    private ID3D11Texture2D? _cursorCopy;
    private int _cursorCopySize;
    private int _width;
    private int _height;
    private int _maxHeight;
    private double _pace;
    private double _deadline;
    private byte[] _buffer = [];
    private volatile bool _stopping;

    private byte[] _shape = [];
    private int _shapeType;
    private int _shapeWidth;
    private int _shapeHeight;
    private int _shapePitch;
    private bool _pointerVisible;
    private int _pointerX;
    private int _pointerY;

    public string Url => _server.Url;
    public int Width { get; private set; }
    public int Height { get; private set; }

    /// <summary>Rend null si cette machine ne sait pas dupliquer cet écran : l'appelant revient à WGC.</summary>
    public static DesktopDuplication? TryStart(IntPtr window, IntPtr monitor, int fps, int maxHeight, Action onClosed)
    {
        if (window != IntPtr.Zero) monitor = MonitorFromWindow(window, MonitorDefaultToNearest);
        using var factory = DXGI.CreateDXGIFactory1<IDXGIFactory1>();
        for (uint a = 0; factory.EnumAdapters1(a, out var adapter).Success; a++)
        {
            using (adapter)
            {
                for (uint o = 0; adapter.EnumOutputs(o, out var candidate).Success; o++)
                {
                    using (candidate)
                    {
                        var description = candidate.Description;
                        if (description.Monitor != monitor) continue;
                        // Une image d'écran tourné arrive couchée : WGC la redresse, autant le lui laisser.
                        if (description.Rotation is not (ModeRotation.Identity or ModeRotation.Unspecified)) return null;
                        var bounds = description.DesktopCoordinates;
                        var (width, height) = FrameConverter.OutputSize(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top, maxHeight);
                        if (width * height * 1.5 * Math.Min(fps, MinimumUsefulFps) > TransportBytesPerSecond) return null;
                        try
                        {
                            return new DesktopDuplication(adapter, candidate, window, fps, maxHeight, onClosed);
                        }
                        catch (SharpGen.Runtime.SharpGenException)
                        {
                            return null;
                        }
                    }
                }
            }
        }
        return null;
    }

    private DesktopDuplication(IDXGIAdapter1 adapter, IDXGIOutput output, IntPtr window, int fps, int maxHeight, Action onClosed)
    {
        _window = window;
        _onClosed = onClosed;
        _maxHeight = maxHeight;
        _pace = Stopwatch.Frequency / (double)fps;
        _output = output.QueryInterface<IDXGIOutput1>();
        // La duplication exige un appareil sur la carte qui affiche cet écran, pas forcément la carte par défaut.
        D3D11.D3D11CreateDevice(adapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
            [FeatureLevel.Level_11_1, FeatureLevel.Level_11_0], out ID3D11Device? device, out ID3D11DeviceContext? context).CheckError();
        _device = device!;
        _context = context!;
        using (var multithread = _context.QueryInterface<ID3D11Multithread>()) multithread.SetMultithreadProtected(true);
        _duplication = _output.DuplicateOutput(_device);
        var region = Region();
        (Width, Height) = FrameConverter.OutputSize(Math.Max(2, region.Right - region.Left), Math.Max(2, region.Bottom - region.Top), maxHeight);
        _thread = new Thread(Loop) { IsBackground = true, Name = "duplication" };
        _thread.Start();
    }

    /// <summary>La zone à garder, en pixels de cet écran. Vide quand la fenêtre est réduite ou hors de l'écran.</summary>
    private (int Left, int Top, int Right, int Bottom) Region()
    {
        var bounds = _output.Description.DesktopCoordinates;
        var (left, top, right, bottom) = (0, 0, bounds.Right - bounds.Left, bounds.Bottom - bounds.Top);
        if (_window == IntPtr.Zero) return (left, top, right, bottom);
        if (DwmGetWindowAttribute(_window, ExtendedFrameBounds, out var rect, Marshal.SizeOf<Rect>()) != 0 && !GetWindowRect(_window, out rect)) return default;
        return (Math.Max(left, rect.Left - bounds.Left), Math.Max(top, rect.Top - bounds.Top), Math.Min(right, rect.Right - bounds.Left), Math.Min(bottom, rect.Bottom - bounds.Top));
    }

    private void Loop()
    {
        while (!_stopping)
        {
            if (_window != IntPtr.Zero && !IsWindow(_window))
            {
                _onClosed();
                return;
            }
            if (_duplication is null && !Reopen())
            {
                Thread.Sleep(RetryMs);
                continue;
            }
            var result = _duplication!.AcquireNextFrame(AcquireTimeoutMs, out var info, out var resource);
            if (result.Code == Vortice.DXGI.ResultCode.WaitTimeout.Code) continue;
            if (result.Failure)
            {
                // Changement de définition, écran de verrouillage, élévation : Windows retire la duplication, il faut la redemander.
                _duplication.Dispose();
                _duplication = null;
                continue;
            }
            try
            {
                ReadPointer(info);
                using var texture = resource!.QueryInterface<ID3D11Texture2D>();
                lock (_lock)
                {
                    if (!_stopping) Publish(texture);
                }
            }
            finally
            {
                resource?.Dispose();
                _duplication.ReleaseFrame();
            }
        }
    }

    private bool Reopen()
    {
        try
        {
            _duplication = _output.DuplicateOutput(_device);
            return true;
        }
        catch (SharpGen.Runtime.SharpGenException)
        {
            return false;
        }
    }

    private unsafe void ReadPointer(in OutduplFrameInfo info)
    {
        if (info.LastMouseUpdateTime != 0)
        {
            _pointerVisible = info.PointerPosition.Visible;
            if (_pointerVisible)
            {
                _pointerX = info.PointerPosition.Position.X;
                _pointerY = info.PointerPosition.Position.Y;
            }
        }
        if (info.PointerShapeBufferSize == 0) return;
        if (_shape.Length < info.PointerShapeBufferSize) _shape = new byte[info.PointerShapeBufferSize];
        fixed (byte* buffer = _shape)
        {
            var result = _duplication!.GetFramePointerShape((uint)_shape.Length, (IntPtr)buffer, out _, out var shape);
            if (result.Failure) return;
            _shapeType = (int)shape.Type;
            _shapeWidth = (int)shape.Width;
            _shapeHeight = (int)(_shapeType == ShapeMonochrome ? shape.Height / 2 : shape.Height);
            _shapePitch = (int)shape.Pitch;
        }
    }

    /// <summary>La première image après chaque échéance est gardée, comme avec WGC.</summary>
    private void Publish(ID3D11Texture2D desktop)
    {
        double now = Stopwatch.GetTimestamp();
        if (now < _deadline - _pace * 0.25) return;
        var (left, top, right, bottom) = Region();
        var (width, height) = (right - left, bottom - top);
        if (width < 2 || height < 2) return;
        _deadline = Math.Max(_deadline + _pace, now);
        if (width != _width || height != _height || _converter is null) Rebuild(desktop, width, height);

        _context.CopySubresourceRegion(_frame!, 0, 0, 0, 0, desktop, 0, new Box(left, top, 0, right, bottom, 1));
        DrawPointer(left, top);

        var length = FrameServer.HeaderBytes + _converter!.FrameBytes;
        if (_buffer.Length < length) _buffer = new byte[length];
        BinaryPrimitives.WriteInt32LittleEndian(_buffer.AsSpan(0), _converter.Width);
        BinaryPrimitives.WriteInt32LittleEndian(_buffer.AsSpan(4), _converter.Height);
        BinaryPrimitives.WriteInt64LittleEndian(_buffer.AsSpan(8), FrameServer.NowMicroseconds());
        _converter.Convert(_frame!, _buffer, FrameServer.HeaderBytes);
        _buffer = _server.Publish(_buffer, length);
    }

    private void Rebuild(ID3D11Texture2D desktop, int width, int height)
    {
        _converter?.Dispose();
        _frame?.Dispose();
        _width = width;
        _height = height;
        _frame = _device.CreateTexture2D(new Texture2DDescription
        {
            Width = (uint)width,
            Height = (uint)height,
            MipLevels = 1,
            ArraySize = 1,
            Format = desktop.Description.Format,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default,
            BindFlags = BindFlags.ShaderResource | BindFlags.RenderTarget,
        });
        _converter = new FrameConverter(_device, _context, width, height, _maxHeight);
        (Width, Height) = (_converter.Width, _converter.Height);
    }

    /// <summary>
    /// Pose le curseur sur l'image : on relit le petit carré dessous, on le mélange, on le remet.
    /// Le curseur fait quelques dizaines de pixels : pas besoin de shader pour ça.
    /// </summary>
    private unsafe void DrawPointer(int left, int top)
    {
        if (!_pointerVisible || _shapeWidth == 0 || _shapeHeight == 0) return;
        var x = _pointerX - left;
        var y = _pointerY - top;
        var (x0, y0) = (Math.Max(0, x), Math.Max(0, y));
        var (x1, y1) = (Math.Min(_width, x + _shapeWidth), Math.Min(_height, y + _shapeHeight));
        if (x1 <= x0 || y1 <= y0) return;
        var (w, h) = (x1 - x0, y1 - y0);

        var side = Math.Max(_shapeWidth, _shapeHeight);
        if (_cursorCopy is null || _cursorCopySize < side)
        {
            _cursorCopy?.Dispose();
            _cursorCopySize = Math.Max(side, 128);
            _cursorCopy = _device.CreateTexture2D(new Texture2DDescription
            {
                Width = (uint)_cursorCopySize,
                Height = (uint)_cursorCopySize,
                MipLevels = 1,
                ArraySize = 1,
                Format = _frame!.Description.Format,
                SampleDescription = new SampleDescription(1, 0),
                Usage = ResourceUsage.Staging,
                CPUAccessFlags = CpuAccessFlags.Read | CpuAccessFlags.Write,
            });
        }
        _context.CopySubresourceRegion(_cursorCopy, 0, 0, 0, 0, _frame!, 0, new Box(x0, y0, 0, x1, y1, 1));
        var mapped = _context.Map(_cursorCopy, 0, MapMode.ReadWrite, Vortice.Direct3D11.MapFlags.None);
        try
        {
            fixed (byte* shape = _shape)
            {
                for (var row = 0; row < h; row++)
                {
                    var target = (uint*)((byte*)mapped.DataPointer + row * mapped.RowPitch);
                    for (var column = 0; column < w; column++)
                    {
                        var (sx, sy) = (column + x0 - x, row + y0 - y);
                        target[column] = Blend(shape, sx, sy, target[column]);
                    }
                }
            }
        }
        finally
        {
            _context.Unmap(_cursorCopy, 0);
        }
        _context.CopySubresourceRegion(_frame!, 0, (uint)x0, (uint)y0, 0, _cursorCopy, 0, new Box(0, 0, 0, w, h, 1));
    }

    /// <summary>Les trois formes de curseur de Windows. Le masque inverse ce qu'il y a dessous : c'est le curseur en I sur un texte.</summary>
    private unsafe uint Blend(byte* shape, int x, int y, uint under)
    {
        if (_shapeType == ShapeMonochrome)
        {
            var bit = (byte)(0x80 >> (x % 8));
            var and = (shape[y * _shapePitch + x / 8] & bit) != 0;
            var xor = (shape[(y + _shapeHeight) * _shapePitch + x / 8] & bit) != 0;
            var value = and ? under : 0u;
            return (xor ? value ^ 0x00FFFFFF : value) | 0xFF000000;
        }
        var pixel = *(uint*)(shape + y * _shapePitch + x * 4);
        var alpha = pixel >> 24;
        if (_shapeType == ShapeMasked) return (alpha == 0 ? pixel : under ^ pixel) | 0xFF000000;
        if (_shapeType != ShapeColor || alpha == 0) return under;
        if (alpha == 255) return pixel;
        var inverse = 255 - alpha;
        var outer = (pixel & 0xFF00FF) * alpha + (under & 0xFF00FF) * inverse;
        var green = (pixel & 0x00FF00) * alpha + (under & 0x00FF00) * inverse;
        return 0xFF000000 | ((outer >> 8) & 0xFF00FF) | ((green >> 8) & 0x00FF00);
    }

    public void Configure(int fps, int maxHeight)
    {
        lock (_lock)
        {
            _pace = Stopwatch.Frequency / (double)fps;
            if (maxHeight == _maxHeight) return;
            _maxHeight = maxHeight;
            _converter?.Dispose();
            _converter = null;
        }
    }

    public void Dispose()
    {
        _stopping = true;
        _thread.Join(TimeSpan.FromSeconds(2));
        lock (_lock)
        {
            _converter?.Dispose();
            _frame?.Dispose();
            _cursorCopy?.Dispose();
        }
        _duplication?.Dispose();
        _server.Dispose();
        _output.Dispose();
        _context.Dispose();
        _device.Dispose();
    }

    private const uint MonitorDefaultToNearest = 2;
    private const int ExtendedFrameBounds = 9;

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
}
