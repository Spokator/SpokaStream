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

    /// <summary>
    /// Les fenêtres qu'une personne reconnaîtrait. Chromium écarte celles qui répondent lentement et celles dont il
    /// n'obtient pas d'image : c'est le cas d'un jeu OpenGL en plein écran exclusif, justement ce qu'on veut diffuser.
    /// </summary>
    public static List<(long Hwnd, string Title)> Visible()
    {
        var found = new List<(long, string)>();
        var title = new char[256];
        var kind = new char[64];
        EnumWindows((window, _) =>
        {
            if (!IsWindowVisible(window) || GetWindow(window, GwOwner) != IntPtr.Zero) return true;
            var style = GetWindowLongPtrW(window, GwlExStyle).ToInt64();
            if ((style & (WsExToolWindow | WsExNoActivate)) != 0) return true;
            if (DwmGetWindowAttribute(window, DwmCloaked, out var cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            // Une fenêtre réduite ne mesure que 160 px de large : c'est pourtant l'état normal d'un jeu après un Alt+Tab.
            if (!IsIconic(window) && (!GetWindowRect(window, out var rect) || rect.Right - rect.Left < MinimumWidth || rect.Bottom - rect.Top < MinimumHeight)) return true;
            var length = GetWindowTextW(window, title, title.Length);
            if (length == 0) return true;
            var kindLength = GetClassNameW(window, kind, kind.Length);
            if (ShellClasses.Contains(new string(kind, 0, kindLength))) return true;
            found.Add((window.ToInt64(), new string(title, 0, length)));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    private const uint GwOwner = 4;
    private const int GwlExStyle = -20;
    private const long WsExToolWindow = 0x80;
    private const long WsExNoActivate = 0x08000000;
    private const int DwmCloaked = 14;
    private const int MinimumWidth = 320;
    private const int MinimumHeight = 200;
    private static readonly HashSet<string> ShellClasses = ["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

    /// <summary>Une fenêtre réduite ne produit aucune image : la choisir pour un direct, c'est vouloir la rouvrir.</summary>
    public static void Restore(IntPtr window)
    {
        if (window == IntPtr.Zero || !IsIconic(window)) return;
        ShowWindow(window, ShowRestore);
        Thread.Sleep(RestoreMs);
    }

    private const int ShowRestore = 9;
    private const int RestoreMs = 400;

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    private delegate bool EnumProc(IntPtr window, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc callback, IntPtr data);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr window, uint command);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindowLongPtrW(IntPtr window, int index);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextW(IntPtr window, char[] text, int count);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassNameW(IntPtr window, char[] text, int count);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

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
