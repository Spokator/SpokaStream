using System.Runtime.InteropServices;
using System.Text.Json.Nodes;

namespace SpokaAudio;

/// <summary>
/// Gestes d'un ami qui a la main. C'est ici, et pas dans l'interface, que se tiennent les garde-fous :
/// même une application compromise ne peut pas viser autre chose que ce que le diffuseur a accepté.
///   - Rien ne part sans armement, et l'armement vise une seule fenêtre ou un seul écran.
///   - Fenêtre : le geste est jeté dès qu'elle n'est plus au premier plan.
///   - Écran : SpokaStream reste hors d'atteinte, et rien ne vise un autre écran.
///   - Seules les touches de la table existent : ni touche Windows, ni raccourcis système.
///   - Sans signe de vie, tout est relâché : une coupure ne laisse pas une touche enfoncée.
/// Les fenêtres lancées en administrateur restent hors d'atteinte : Windows refuse d'y injecter quoi que ce soit.
/// </summary>
public sealed class RemoteInput : IDisposable
{
    private const long AliveTimeoutMs = 3000;

    private readonly Action<bool> _onBlocked;
    private readonly Lock _lock = new();
    private readonly HashSet<string> _keys = [];
    private readonly HashSet<int> _buttons = [];
    private readonly HashSet<uint> _own = [];
    private readonly Timer _watchdog;
    private IntPtr _window;
    private IntPtr _monitor;
    private bool _armed;
    private bool _blocked;
    private long _lastAlive;

    public RemoteInput(Action<bool> onBlocked)
    {
        _onBlocked = onBlocked;
        _watchdog = new Timer(_ => CheckAlive(), null, 500, 500);
    }

    public void Arm(long hwnd, int x, int y, int appPid)
    {
        lock (_lock)
        {
            ReleaseAll();
            _window = new IntPtr(hwnd);
            _monitor = hwnd == 0 ? MonitorFromPoint(new Point { X = x, Y = y }, 2) : IntPtr.Zero;
            _own.Clear();
            _own.Add((uint)Environment.ProcessId);
            _own.Add((uint)appPid);
            _armed = true;
            _blocked = false;
            _lastAlive = Environment.TickCount64;
            if (hwnd != 0) Focus(_window);
        }
    }

    public void Disarm()
    {
        lock (_lock)
        {
            ReleaseAll();
            _armed = false;
            _window = IntPtr.Zero;
            _monitor = IntPtr.Zero;
        }
    }

    public void Apply(JsonArray events)
    {
        lock (_lock)
        {
            if (!_armed) return;
            _lastAlive = Environment.TickCount64;
            var focused = TargetFocused();
            if (focused == _blocked)
            {
                _blocked = !focused;
                _onBlocked(_blocked);
            }
            if (!focused)
            {
                ReleaseAll();
                return;
            }
            foreach (var item in events)
                if (item is JsonObject input) Dispatch(input);
        }
    }

    private void Dispatch(JsonObject input)
    {
        switch ((string?)input["k"])
        {
            case "move":
                MoveTo((double?)input["x"] ?? 0, (double?)input["y"] ?? 0);
                break;
            case "rel":
                Mouse(Math.Clamp((int?)input["x"] ?? 0, -2000, 2000), Math.Clamp((int?)input["y"] ?? 0, -2000, 2000), 0, MouseMove);
                break;
            case "button":
                Button((int?)input["button"] ?? -1, (bool?)input["down"] == true);
                break;
            case "wheel":
                if (PointerOnTarget()) Mouse(0, 0, (uint)Math.Clamp((int?)input["delta"] ?? 0, -1200, 1200), MouseWheel);
                break;
            case "key":
                Key((string?)input["code"] ?? "", (bool?)input["down"] == true);
                break;
        }
    }

    private void MoveTo(double x, double y)
    {
        if (!TargetRect(out var rect)) return;
        var px = rect.Left + Math.Clamp(x, 0, 1) * Math.Max(0, rect.Right - rect.Left - 1);
        var py = rect.Top + Math.Clamp(y, 0, 1) * Math.Max(0, rect.Bottom - rect.Top - 1);
        var left = GetSystemMetrics(76);
        var top = GetSystemMetrics(77);
        var width = Math.Max(1, GetSystemMetrics(78) - 1);
        var height = Math.Max(1, GetSystemMetrics(79) - 1);
        Mouse((int)((px - left) * 65535 / width), (int)((py - top) * 65535 / height), 0, MouseMove | MouseAbsolute | MouseVirtualDesk);
    }

    private void Button(int button, bool down)
    {
        if (button is < 0 or > 2) return;
        // Une pression doit tomber sur la cible. Son relâchement passe toujours, sinon le bouton resterait enfoncé.
        if (down && !PointerOnTarget()) return;
        if (!down && !_buttons.Contains(button)) return;
        if (down) _buttons.Add(button);
        else _buttons.Remove(button);
        Mouse(0, 0, 0, ButtonFlag(button, down));
    }

    private static uint ButtonFlag(int button, bool down) => button switch
    {
        0 => down ? 0x0002u : 0x0004u,
        2 => down ? 0x0008u : 0x0010u,
        _ => down ? 0x0020u : 0x0040u,
    };

    private void Key(string code, bool down)
    {
        if (!ScanCodes.TryGetValue(code, out var key)) return;
        if (down)
        {
            if (Forbidden(code)) return;
            _keys.Add(code);
        }
        else if (!_keys.Remove(code))
        {
            return;
        }
        SendKey(key.Scan, key.Extended, down);
    }

    /// <summary>
    /// Alt+F4 fermerait le jeu, Alt+Tab sortirait de la fenêtre, et Ctrl+Alt+lettre est la forme de tous les
    /// raccourcis globaux de SpokaStream : un ami ne doit pas pouvoir couper le stream ni accepter à la place du diffuseur.
    /// E reste permis pour écrire € avec Alt Gr, qui vaut Ctrl+Alt pour Windows.
    /// </summary>
    private bool Forbidden(string code)
    {
        var ctrl = _keys.Contains("ControlLeft") || _keys.Contains("ControlRight");
        var altGr = _keys.Contains("AltRight");
        var alt = _keys.Contains("AltLeft") || altGr;
        if (alt && code is "Tab" or "F4" or "Escape" or "Space") return true;
        if (ctrl && code == "Escape") return true;
        var system = (ctrl && alt) || altGr;
        return system && (code is "Delete" or "End" || (code.StartsWith("Key", StringComparison.Ordinal) && code != "KeyE"));
    }

    private void ReleaseAll()
    {
        foreach (var code in _keys)
            if (ScanCodes.TryGetValue(code, out var key)) SendKey(key.Scan, key.Extended, false);
        _keys.Clear();
        foreach (var button in _buttons) Mouse(0, 0, 0, ButtonFlag(button, false));
        _buttons.Clear();
    }

    private void CheckAlive()
    {
        lock (_lock)
        {
            if (_armed && Environment.TickCount64 - _lastAlive > AliveTimeoutMs) ReleaseAll();
        }
    }

    private bool TargetFocused()
    {
        var foreground = GetForegroundWindow();
        if (foreground == IntPtr.Zero) return false;
        if (_window != IntPtr.Zero) return !IsIconic(_window) && IsOnTarget(foreground);
        return !IsOwn(foreground) && MonitorFromWindow(foreground, 2) == _monitor;
    }

    /// <summary>Les menus et boîtes de dialogue d'une fenêtre lui appartiennent : ils font partie de la cible.</summary>
    private bool IsOnTarget(IntPtr window) => window == _window || GetAncestor(window, 3) == _window;

    private bool IsOwn(IntPtr window)
    {
        GetWindowThreadProcessId(window, out var pid);
        return _own.Contains(pid);
    }

    private bool PointerOnTarget()
    {
        if (!GetCursorPos(out var point)) return false;
        var window = WindowFromPoint(point);
        if (window == IntPtr.Zero) return false;
        var root = GetAncestor(window, 2);
        if (_window != IntPtr.Zero) return IsOnTarget(root);
        return !IsOwn(root) && MonitorFromPoint(point, 2) == _monitor;
    }

    private bool TargetRect(out Rect rect)
    {
        if (_window != IntPtr.Zero)
        {
            // La capture montre la fenêtre sans son ombre : GetWindowRect décalerait les clics de quelques pixels.
            if (DwmGetWindowAttribute(_window, 9, out rect, Marshal.SizeOf<Rect>()) == 0) return true;
            return GetWindowRect(_window, out rect);
        }
        var info = new MonitorInfo { Size = Marshal.SizeOf<MonitorInfo>() };
        var known = GetMonitorInfo(_monitor, ref info);
        rect = info.Monitor;
        return known;
    }

    /// <summary>
    /// Windows réserve le premier plan à qui vient de recevoir une entrée. Le moteur n'en reçoit jamais :
    /// une pression d'Alt le temps de l'appel suffit, sans rien déclencher dans l'application visée.
    /// </summary>
    private static void Focus(IntPtr window)
    {
        if (IsIconic(window)) ShowWindow(window, 9);
        keybd_event(0x12, 0, 0, UIntPtr.Zero);
        SetForegroundWindow(window);
        keybd_event(0x12, 0, 2, UIntPtr.Zero);
    }

    private static void Mouse(int x, int y, uint data, uint flags)
    {
        var input = new Input { Type = 0, Data = new InputData { Mouse = new MouseInput { X = x, Y = y, Data = data, Flags = flags } } };
        SendInput(1, [input], Marshal.SizeOf<Input>());
    }

    private static void SendKey(ushort scan, bool extended, bool down)
    {
        // Le code de position, et non le caractère : c'est ce que lisent les jeux, en DirectInput comme en Raw Input.
        var flags = KeyScanCode | (extended ? KeyExtended : 0) | (down ? 0 : KeyUp);
        var input = new Input { Type = 1, Data = new InputData { Keyboard = new KeyboardInput { Scan = scan, Flags = flags } } };
        SendInput(1, [input], Marshal.SizeOf<Input>());
    }

    public void Dispose()
    {
        _watchdog.Dispose();
        Disarm();
    }

    private static readonly Dictionary<string, (ushort Scan, bool Extended)> ScanCodes = BuildScanCodes();

    private static Dictionary<string, (ushort, bool)> BuildScanCodes()
    {
        var table = new Dictionary<string, (ushort, bool)>();
        void Row(ushort first, params string[] codes)
        {
            foreach (var code in codes) table[code] = (first++, false);
        }
        void Extended(ushort scan, string code) => table[code] = (scan, true);

        Row(0x01, "Escape", "Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8", "Digit9", "Digit0", "Minus", "Equal", "Backspace", "Tab");
        Row(0x10, "KeyQ", "KeyW", "KeyE", "KeyR", "KeyT", "KeyY", "KeyU", "KeyI", "KeyO", "KeyP", "BracketLeft", "BracketRight", "Enter", "ControlLeft");
        Row(0x1E, "KeyA", "KeyS", "KeyD", "KeyF", "KeyG", "KeyH", "KeyJ", "KeyK", "KeyL", "Semicolon", "Quote", "Backquote", "ShiftLeft", "Backslash");
        Row(0x2C, "KeyZ", "KeyX", "KeyC", "KeyV", "KeyB", "KeyN", "KeyM", "Comma", "Period", "Slash", "ShiftRight", "NumpadMultiply", "AltLeft", "Space", "CapsLock");
        Row(0x3B, "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10");
        Row(0x47, "Numpad7", "Numpad8", "Numpad9", "NumpadSubtract", "Numpad4", "Numpad5", "Numpad6", "NumpadAdd", "Numpad1", "Numpad2", "Numpad3", "Numpad0", "NumpadDecimal");
        Row(0x56, "IntlBackslash", "F11", "F12");
        Extended(0x1C, "NumpadEnter");
        Extended(0x1D, "ControlRight");
        Extended(0x35, "NumpadDivide");
        Extended(0x38, "AltRight");
        Extended(0x47, "Home");
        Extended(0x48, "ArrowUp");
        Extended(0x49, "PageUp");
        Extended(0x4B, "ArrowLeft");
        Extended(0x4D, "ArrowRight");
        Extended(0x4F, "End");
        Extended(0x50, "ArrowDown");
        Extended(0x51, "PageDown");
        Extended(0x52, "Insert");
        Extended(0x53, "Delete");
        return table;
    }

    private const uint MouseMove = 0x0001;
    private const uint MouseWheel = 0x0800;
    private const uint MouseVirtualDesk = 0x4000;
    private const uint MouseAbsolute = 0x8000;
    private const uint KeyExtended = 0x0001;
    private const uint KeyUp = 0x0002;
    private const uint KeyScanCode = 0x0008;

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int Size;
        public Rect Monitor;
        public Rect Work;
        public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int X, Y;
        public uint Data, Flags, Time;
        public IntPtr Extra;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort Key, Scan;
        public uint Flags, Time;
        public IntPtr Extra;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputData
    {
        [FieldOffset(0)] public MouseInput Mouse;
        [FieldOffset(0)] public KeyboardInput Keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint Type;
        public InputData Data;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);

    [DllImport("user32.dll")]
    private static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);

    [DllImport("user32.dll")]
    private static extern IntPtr GetAncestor(IntPtr window, uint flags);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr WindowFromPoint(Point point);

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(Point point, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr window, out Rect rect);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("dwmapi.dll")]
    private static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out Rect value, int size);
}
