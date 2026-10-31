using System.Runtime.InteropServices;

namespace SpokaAudio;

/// <summary>Lien entre une fenêtre capturée et son application, pour viser le son de cette seule fenêtre.</summary>
public static class Windows
{
    public static int? ProcessOf(long hwnd)
    {
        GetWindowThreadProcessId(new IntPtr(hwnd), out var pid);
        return pid == 0 ? null : (int)pid;
    }

    public static (int X, int Y, int Width, int Height)? RectOf(long hwnd)
    {
        var handle = new IntPtr(hwnd);
        if (!IsWindow(handle) || !GetWindowRect(handle, out var rect)) return null;
        return (rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
    }

    public static IntPtr MonitorAt(int x, int y) => MonitorFromPoint(new Point { X = x, Y = y }, 2);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X, Y;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point point, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hwnd);
}

/// <summary>
/// Touches surveillées même quand un jeu a le focus (appuyer pour parler). Lecture d'état par scrutation :
/// contrairement à un hook clavier, elle ne voit QUE les touches demandées et n'ajoute aucune latence aux frappes.
/// </summary>
public sealed class KeyWatcher : IDisposable
{
    private readonly Action<int, bool> _onChange;
    private readonly Lock _lock = new();
    private HashSet<int> _keys = [];
    private readonly Dictionary<int, bool> _state = [];
    private readonly Thread _thread;
    private volatile bool _stop;

    public KeyWatcher(Action<int, bool> onChange)
    {
        _onChange = onChange;
        _thread = new Thread(Run) { IsBackground = true, Name = "touches" };
        _thread.Start();
    }

    public void Watch(IEnumerable<int> keys)
    {
        lock (_lock)
        {
            _keys = [.. keys];
            _state.Clear();
        }
    }

    private void Run()
    {
        while (!_stop)
        {
            lock (_lock)
            {
                foreach (var key in _keys)
                {
                    var down = (GetAsyncKeyState(key) & 0x8000) != 0;
                    _state.TryGetValue(key, out var was);
                    if (down == was) continue;
                    _state[key] = down;
                    _onChange(key, down);
                }
            }
            Thread.Sleep(12);
        }
    }

    public void Dispose() => _stop = true;

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
}
