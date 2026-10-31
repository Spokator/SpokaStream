using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;

namespace SpokaAudio;

/// <summary>
/// Capture d'écran ou de fenêtre par Windows.Graphics.Capture, convertie en NV12 sur la carte graphique.
/// WGC limite par défaut à un intervalle de 16,7 ms : sur un écran 144 Hz, la première image après ce délai
/// tombe à la 3e synchro, soit 48 i/s. MinUpdateInterval lève cette limite (Windows 11 24H2) ; la cadence voulue
/// est ensuite tenue ici. La capture de bureau de Chromium ne règle pas cette propriété.
/// </summary>
public sealed class ScreenCapture : IVideoCapture
{
    /// <summary>
    /// Débit mesuré du WebSocket local vers la page, plafonné par le service réseau de Chromium.
    /// Deux connexions en parallèle n'y changent rien : au-delà, une définition ne peut plus tenir sa cadence.
    /// </summary>
    private const double TransportBytesPerSecond = 340e6;
    private const int MinimumUsefulFps = 48;

    private readonly ID3D11Device _device;
    private readonly ID3D11DeviceContext _context;
    private readonly IDirect3DDevice _winrtDevice;
    private readonly GraphicsCaptureItem _item;
    private readonly Direct3D11CaptureFramePool _pool;
    private readonly GraphicsCaptureSession _session;
    private readonly FrameServer _server;
    private readonly Lock _lock = new();
    private readonly Action _onClosed;

    private FrameConverter _converter;
    private SizeInt32 _poolSize;
    private byte[] _buffer = [];
    private double _pace;
    private double _deadline;
    private int _maxHeight;
    private bool _disposed;

    public string Url => _server.Url;
    public int Width => _converter.Width;
    public int Height => _converter.Height;

    /// <summary>Rend null si cette machine ou cette définition seraient mieux servies par la capture de Chromium.</summary>
    public static ScreenCapture? TryStart(IntPtr window, IntPtr monitor, int fps, int maxHeight, Action onClosed)
    {
        if (!GraphicsCaptureSession.IsSupported()) return null;
        var item = window != IntPtr.Zero ? CaptureInterop.ItemForWindow(window) : CaptureInterop.ItemForMonitor(monitor);
        var (width, height) = FrameConverter.OutputSize(item.Size.Width, item.Size.Height, maxHeight);
        if (width * height * 1.5 * Math.Min(fps, MinimumUsefulFps) > TransportBytesPerSecond) return null;
        return new ScreenCapture(item, fps, maxHeight, onClosed);
    }

    private ScreenCapture(GraphicsCaptureItem item, int fps, int maxHeight, Action onClosed)
    {
        _item = item;
        _onClosed = onClosed;
        _maxHeight = maxHeight;
        _pace = Stopwatch.Frequency / (double)fps;

        D3D11.D3D11CreateDevice(null, DriverType.Hardware, DeviceCreationFlags.BgraSupport | DeviceCreationFlags.VideoSupport,
            [FeatureLevel.Level_11_1, FeatureLevel.Level_11_0], out ID3D11Device? device, out ID3D11DeviceContext? context).CheckError();
        _device = device!;
        _context = context!;
        using (var multithread = _context.QueryInterface<ID3D11Multithread>()) multithread.SetMultithreadProtected(true);
        using (var dxgi = _device.QueryInterface<IDXGIDevice>())
        {
            Marshal.ThrowExceptionForHR(CaptureInterop.CreateDirect3D11DeviceFromDXGIDevice(dxgi.NativePointer, out var inspectable));
            _winrtDevice = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
            Marshal.Release(inspectable);
        }

        _poolSize = item.Size;
        _converter = new FrameConverter(_device, _context, _poolSize.Width, _poolSize.Height, maxHeight);
        _server = new FrameServer();
        _pool = Direct3D11CaptureFramePool.CreateFreeThreaded(_winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, _poolSize);
        _session = _pool.CreateCaptureSession(item);
        try
        {
            _session.IsBorderRequired = false;
        }
        catch
        {
            // Avant Windows 11 : la bordure jaune reste, la capture marche quand même.
        }
        try
        {
            _session.MinUpdateInterval = TimeSpan.FromMilliseconds(1);
        }
        catch
        {
            // Avant Windows 11 24H2 : cadence limitée par Windows, comme la capture de Chromium.
        }
        _item.Closed += (_, _) => _onClosed();
        _pool.FrameArrived += OnFrame;
        _session.StartCapture();
    }

    public void Configure(int fps, int maxHeight)
    {
        lock (_lock)
        {
            _pace = Stopwatch.Frequency / (double)fps;
            if (maxHeight == _maxHeight) return;
            _maxHeight = maxHeight;
            RebuildConverter();
        }
    }

    private void RebuildConverter()
    {
        _converter.Dispose();
        _converter = new FrameConverter(_device, _context, _poolSize.Width, _poolSize.Height, _maxHeight);
    }

    private void OnFrame(Direct3D11CaptureFramePool pool, object _)
    {
        using var frame = pool.TryGetNextFrame();
        if (frame is null) return;
        lock (_lock)
        {
            if (_disposed) return;
            if (frame.ContentSize.Width != _poolSize.Width || frame.ContentSize.Height != _poolSize.Height)
            {
                // Fenêtre redimensionnée : l'image suivante arrivera à la bonne taille.
                _poolSize = frame.ContentSize;
                pool.Recreate(_winrtDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, _poolSize);
                RebuildConverter();
                return;
            }
            // L'écran peut aller plus vite que la cadence voulue : on garde la première image après chaque échéance.
            double now = Stopwatch.GetTimestamp();
            if (now < _deadline - _pace * 0.25) return;
            _deadline = Math.Max(_deadline + _pace, now);

            var length = FrameServer.HeaderBytes + _converter.FrameBytes;
            if (_buffer.Length < length) _buffer = new byte[length];
            BinaryPrimitives.WriteInt32LittleEndian(_buffer.AsSpan(0), _converter.Width);
            BinaryPrimitives.WriteInt32LittleEndian(_buffer.AsSpan(4), _converter.Height);
            BinaryPrimitives.WriteInt64LittleEndian(_buffer.AsSpan(8), FrameServer.NowMicroseconds());
            using var texture = CaptureInterop.TextureOf(frame.Surface);
            _converter.Convert(texture, _buffer, FrameServer.HeaderBytes);
            _buffer = _server.Publish(_buffer, length);
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            _converter.Dispose();
        }
        _pool.FrameArrived -= OnFrame;
        _session.Dispose();
        _pool.Dispose();
        _server.Dispose();
        _context.Dispose();
        _device.Dispose();
    }
}

/// <summary>BGRA vers NV12 sur la carte graphique, puis relecture. La mise à l'échelle se fait au passage.</summary>
internal sealed class FrameConverter : IDisposable
{
    private readonly ID3D11DeviceContext _context;
    private readonly ID3D11VideoDevice _videoDevice;
    private readonly ID3D11VideoContext1 _video;
    private readonly ID3D11VideoProcessorEnumerator _enumerator;
    private readonly ID3D11VideoProcessor _processor;
    private readonly ID3D11Texture2D _target;
    private readonly ID3D11Texture2D _staging;
    private readonly ID3D11VideoProcessorOutputView _output;

    public int Width { get; }
    public int Height { get; }
    public int FrameBytes => Width * Height * 3 / 2;

    /// <summary>NV12 exige des dimensions paires.</summary>
    public static (int Width, int Height) OutputSize(int width, int height, int maxHeight)
    {
        if (maxHeight > 0 && height > maxHeight)
        {
            width = (int)Math.Round(width * (double)maxHeight / height);
            height = maxHeight;
        }
        return (Math.Max(2, width & ~1), Math.Max(2, height & ~1));
    }

    public FrameConverter(ID3D11Device device, ID3D11DeviceContext context, int sourceWidth, int sourceHeight, int maxHeight)
    {
        _context = context;
        (Width, Height) = OutputSize(sourceWidth, sourceHeight, maxHeight);
        _videoDevice = device.QueryInterface<ID3D11VideoDevice>();
        _video = context.QueryInterface<ID3D11VideoContext1>();
        var description = new VideoProcessorContentDescription
        {
            InputFrameFormat = VideoFrameFormat.Progressive,
            InputWidth = (uint)sourceWidth,
            InputHeight = (uint)sourceHeight,
            OutputWidth = (uint)Width,
            OutputHeight = (uint)Height,
            InputFrameRate = new Rational(60, 1),
            OutputFrameRate = new Rational(60, 1),
            Usage = VideoUsage.OptimalSpeed,
        };
        _videoDevice.CreateVideoProcessorEnumerator(description, out _enumerator!).CheckError();
        _videoDevice.CreateVideoProcessor(_enumerator, 0, out _processor!).CheckError();
        _video.VideoProcessorSetStreamColorSpace1(_processor, 0, ColorSpaceType.RgbFullG22NoneP709);
        _video.VideoProcessorSetOutputColorSpace1(_processor, ColorSpaceType.YcbcrStudioG22LeftP709);
        _video.VideoProcessorSetStreamAutoProcessingMode(_processor, 0, false);

        var texture = new Texture2DDescription
        {
            Width = (uint)Width,
            Height = (uint)Height,
            MipLevels = 1,
            ArraySize = 1,
            Format = Format.NV12,
            SampleDescription = new SampleDescription(1, 0),
            Usage = ResourceUsage.Default,
            BindFlags = BindFlags.RenderTarget,
        };
        _target = device.CreateTexture2D(texture);
        _staging = device.CreateTexture2D(texture with { Usage = ResourceUsage.Staging, BindFlags = BindFlags.None, CPUAccessFlags = CpuAccessFlags.Read });
        _videoDevice.CreateVideoProcessorOutputView(_target, _enumerator, new VideoProcessorOutputViewDescription { ViewDimension = VideoProcessorOutputViewDimension.Texture2D }, out _output!).CheckError();
    }

    /// <summary>
    /// Attend la carte graphique (1 ms environ) plutôt que de lire une image plus ancienne :
    /// une file de relecture éviterait cette attente mais ajouterait deux images de latence.
    /// </summary>
    public unsafe void Convert(ID3D11Texture2D source, byte[] destination, int offset)
    {
        var inputDescription = new VideoProcessorInputViewDescription { ViewDimension = VideoProcessorInputViewDimension.Texture2D };
        _videoDevice.CreateVideoProcessorInputView(source, _enumerator, inputDescription, out var input).CheckError();
        using (input)
        {
            _video.VideoProcessorBlt(_processor, _output, 0, 1, [new VideoProcessorStream { Enable = true, InputSurface = input }]).CheckError();
        }
        _context.CopyResource(_staging, _target);
        var mapped = _context.Map(_staging, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
        try
        {
            fixed (byte* output = destination)
            {
                var source0 = (byte*)mapped.DataPointer;
                var pitch = (int)mapped.RowPitch;
                var target = output + offset;
                for (var y = 0; y < Height; y++)
                {
                    Buffer.MemoryCopy(source0 + y * pitch, target, Width, Width);
                    target += Width;
                }
                var chroma = source0 + Height * pitch;
                for (var y = 0; y < Height / 2; y++)
                {
                    Buffer.MemoryCopy(chroma + y * pitch, target, Width, Width);
                    target += Width;
                }
            }
        }
        finally
        {
            _context.Unmap(_staging, 0);
        }
    }

    public void Dispose()
    {
        _output.Dispose();
        _staging.Dispose();
        _target.Dispose();
        _processor.Dispose();
        _enumerator.Dispose();
        _video.Dispose();
        _videoDevice.Dispose();
    }
}

internal static class CaptureInterop
{
    private static readonly Guid CaptureItemIid = new("79C3F95B-31F7-4EC2-A464-632EF5D30760");

    private static IGraphicsCaptureItemInterop Factory() =>
        ActivationFactory.Get("Windows.Graphics.Capture.GraphicsCaptureItem").AsInterface<IGraphicsCaptureItemInterop>();

    public static GraphicsCaptureItem ItemForWindow(IntPtr window) => Wrap(Factory().CreateForWindow(window, CaptureItemIid));

    public static GraphicsCaptureItem ItemForMonitor(IntPtr monitor) => Wrap(Factory().CreateForMonitor(monitor, CaptureItemIid));

    private static GraphicsCaptureItem Wrap(IntPtr pointer)
    {
        var item = GraphicsCaptureItem.FromAbi(pointer);
        Marshal.Release(pointer);
        return item;
    }

    public static ID3D11Texture2D TextureOf(IDirect3DSurface surface)
    {
        var access = surface.As<IDirect3DDxgiInterfaceAccess>();
        var iid = typeof(ID3D11Texture2D).GUID;
        return new ID3D11Texture2D(access.GetInterface(ref iid));
    }

    [DllImport("d3d11.dll", ExactSpelling = true)]
    public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);

    [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        IntPtr CreateForWindow(IntPtr window, in Guid iid);
        IntPtr CreateForMonitor(IntPtr monitor, in Guid iid);
    }

    [ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDirect3DDxgiInterfaceAccess
    {
        IntPtr GetInterface(ref Guid iid);
    }
}
