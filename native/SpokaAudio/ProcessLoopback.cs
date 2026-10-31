using System.Runtime.InteropServices;

namespace SpokaAudio;

/// <summary>
/// Capture WASAPI par processus (Windows 10 2004+) : le son d'une application et de ses enfants,
/// ou tout le son de la machine SAUF une application. Aucune API web ne donne accès à ça.
/// </summary>
public sealed class ProcessLoopback : IDisposable
{
    public const int SampleRate = 48000;
    public const int Channels = 2;

    private const string VirtualDevice = "VAD\\Process_Loopback";
    private const uint StreamFlagsLoopback = 0x00020000;
    private const uint StreamFlagsEventCallback = 0x00040000;
    private const uint StreamFlagsAutoConvertPcm = 0x80000000;
    private const uint StreamFlagsSrcDefaultQuality = 0x08000000;
    private const uint BufferFlagsSilent = 0x2;
    private const ushort WaveFormatIeeeFloat = 3;
    private const long BufferDuration100ns = 200_000; // 20 ms de tampon côté Windows : c'est la latence de capture

    private readonly int _pid;
    private readonly bool _exclude;
    private readonly Action<float[], int> _onSamples;
    private readonly Action<string> _onError;
    private readonly ManualResetEventSlim _stop = new(false);
    private Thread? _thread;

    public ProcessLoopback(int pid, bool exclude, Action<float[], int> onSamples, Action<string> onError)
    {
        _pid = pid;
        _exclude = exclude;
        _onSamples = onSamples;
        _onError = onError;
    }

    public void Start()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "capture", Priority = ThreadPriority.Highest };
        _thread.SetApartmentState(ApartmentState.MTA);
        _thread.Start();
    }

    private void Run()
    {
        IntPtr bufferEvent = IntPtr.Zero;
        IAudioClient? client = null;
        IAudioCaptureClient? capture = null;
        var task = IntPtr.Zero;
        try
        {
            client = Activate(_pid, _exclude);
            var format = new WaveFormatEx
            {
                Tag = WaveFormatIeeeFloat,
                Channels = Channels,
                SamplesPerSec = SampleRate,
                BitsPerSample = 32,
                BlockAlign = Channels * 4,
                AvgBytesPerSec = SampleRate * Channels * 4,
                ExtraSize = 0,
            };
            Check(client.Initialize(0, StreamFlagsLoopback | StreamFlagsEventCallback | StreamFlagsAutoConvertPcm | StreamFlagsSrcDefaultQuality,
                BufferDuration100ns, 0, ref format, IntPtr.Zero), "Initialize");

            bufferEvent = CreateEventW(IntPtr.Zero, false, false, null);
            Check(client.SetEventHandle(bufferEvent), "SetEventHandle");

            var iid = typeof(IAudioCaptureClient).GUID;
            Check(client.GetService(ref iid, out var service), "GetService");
            capture = (IAudioCaptureClient)service;

            task = AvSetMmThreadCharacteristicsW("Pro Audio", out _);
            Check(client.Start(), "Start");

            var pending = new float[4096];
            var handles = new[] { bufferEvent, _stop.WaitHandle.SafeWaitHandle.DangerousGetHandle() };
            while (true)
            {
                var signaled = WaitForMultipleObjects(2, handles, false, 500);
                if (signaled == 1) break;
                while (true)
                {
                    Check(capture.GetNextPacketSize(out var frames), "GetNextPacketSize");
                    if (frames == 0) break;
                    Check(capture.GetBuffer(out var data, out var got, out var flags, out _, out _), "GetBuffer");
                    var samples = (int)got * Channels;
                    if (pending.Length < samples) pending = new float[samples * 2];
                    if ((flags & BufferFlagsSilent) != 0) Array.Clear(pending, 0, samples);
                    else Marshal.Copy(data, pending, 0, samples);
                    Check(capture.ReleaseBuffer(got), "ReleaseBuffer");
                    _onSamples(pending, samples);
                }
            }
            client.Stop();
        }
        catch (Exception e) when (!_stop.IsSet)
        {
            _onError(e.Message);
        }
        catch (Exception)
        {
            // Arrêt demandé : Windows peut invalider le flux à tout moment, rien à signaler.
        }
        finally
        {
            if (task != IntPtr.Zero) AvRevertMmThreadCharacteristics(task);
            if (bufferEvent != IntPtr.Zero) CloseHandle(bufferEvent);
            if (capture is not null) Marshal.ReleaseComObject(capture);
            if (client is not null) Marshal.ReleaseComObject(client);
        }
    }

    private static IAudioClient Activate(int pid, bool exclude)
    {
        var paramsSize = Marshal.SizeOf<ActivationParams>();
        var paramsPtr = Marshal.AllocHGlobal(paramsSize);
        var variantSize = Marshal.SizeOf<BlobVariant>();
        var variantPtr = Marshal.AllocHGlobal(variantSize);
        try
        {
            Marshal.StructureToPtr(new ActivationParams { ActivationType = 1, TargetProcessId = (uint)pid, LoopbackMode = exclude ? 1 : 0 }, paramsPtr, false);
            Marshal.StructureToPtr(new BlobVariant { Vt = 65, BlobSize = (uint)paramsSize, BlobData = paramsPtr }, variantPtr, false);

            var handler = new ActivationHandler();
            var iid = typeof(IAudioClient).GUID;
            Check(ActivateAudioInterfaceAsync(VirtualDevice, ref iid, variantPtr, handler, out var operation), "ActivateAudioInterfaceAsync");
            if (!handler.Completed.Wait(TimeSpan.FromSeconds(5))) throw new TimeoutException("Windows n'a pas répondu à l'activation de la capture.");
            Check(operation.GetActivateResult(out var hr, out var unknown), "GetActivateResult");
            Check(hr, "activation");
            Marshal.ReleaseComObject(operation);
            return (IAudioClient)unknown!;
        }
        finally
        {
            Marshal.FreeHGlobal(variantPtr);
            Marshal.FreeHGlobal(paramsPtr);
        }
    }

    private static void Check(int hr, string where)
    {
        if (hr < 0) throw new InvalidOperationException($"{where} : 0x{hr:X8}");
    }

    public void Dispose()
    {
        _stop.Set();
        _thread?.Join(1000);
    }

    [ComVisible(true)]
    private sealed class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
    {
        public ManualResetEventSlim Completed { get; } = new(false);
        public int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
        {
            Completed.Set();
            return 0;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ActivationParams
    {
        public int ActivationType;
        public uint TargetProcessId;
        public int LoopbackMode;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BlobVariant
    {
        public ushort Vt;
        public ushort Reserved1;
        public ushort Reserved2;
        public ushort Reserved3;
        public uint BlobSize;
        public IntPtr BlobData;
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormatEx
    {
        public ushort Tag;
        public ushort Channels;
        public int SamplesPerSec;
        public int AvgBytesPerSec;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort ExtraSize;
    }

    [DllImport("Mmdevapi.dll", ExactSpelling = true)]
    private static extern int ActivateAudioInterfaceAsync(
        [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
        ref Guid riid,
        IntPtr activationParams,
        IActivateAudioInterfaceCompletionHandler completionHandler,
        out IActivateAudioInterfaceAsyncOperation activationOperation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateEventW(IntPtr attributes, bool manualReset, bool initialState, string? name);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool waitAll, uint milliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("avrt.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr AvSetMmThreadCharacteristicsW(string taskName, out uint taskIndex);

    [DllImport("avrt.dll")]
    private static extern bool AvRevertMmThreadCharacteristics(IntPtr handle);

    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject { }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceCompletionHandler
    {
        [PreserveSig] int ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
    }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IActivateAudioInterfaceAsyncOperation
    {
        [PreserveSig] int GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object? activatedInterface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, ref WaveFormatEx format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out long devicePosition, out long qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }
}
