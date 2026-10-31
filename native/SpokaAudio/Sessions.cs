using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

namespace SpokaAudio;

public sealed record AudioApp(int Pid, string Name, string? Path, string? Title, double Peak);

/// <summary>Liste les applications qui ont une session audio ouverte, regroupées par application.</summary>
public static class Sessions
{
    public static List<AudioApp> List()
    {
        var byRoot = new Dictionary<int, AudioApp>();
        using var enumerator = new MMDeviceEnumerator();
        foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            using (device)
            {
                var sessions = device.AudioSessionManager.Sessions;
                for (var i = 0; i < sessions.Count; i++)
                {
                    using var session = sessions[i];
                    var pid = (int)session.GetProcessID;
                    if (pid == 0 || session.IsSystemSoundsSession) continue;
                    var root = ProcessTree.RootOf(pid);
                    var peak = (double)session.AudioMeterInformation.MasterPeakValue;
                    if (byRoot.TryGetValue(root, out var known))
                    {
                        if (peak > known.Peak) byRoot[root] = known with { Peak = peak };
                        continue;
                    }
                    var (name, path, title) = Describe(root);
                    byRoot[root] = new AudioApp(root, name, path, title, peak);
                }
            }
        }
        return byRoot.Values.OrderByDescending(a => a.Peak > 0.0005).ThenBy(a => a.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
    }

    public static (string Name, string? Path, string? Title) Describe(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            string? path = null;
            string? description = null;
            try
            {
                path = process.MainModule?.FileName;
                description = process.MainModule?.FileVersionInfo.FileDescription;
            }
            catch
            {
                // Processus protégé ou d'un autre utilisateur : on garde au moins son nom.
            }
            var title = string.IsNullOrWhiteSpace(process.MainWindowTitle) ? null : process.MainWindowTitle;
            var name = string.IsNullOrWhiteSpace(description) ? process.ProcessName : description!;
            return (name, path, title);
        }
        catch
        {
            return ($"Processus {pid}", null, null);
        }
    }
}

/// <summary>
/// Un navigateur ou Spotify joue le son depuis un processus enfant : il faut viser la racine de l'application
/// avec INCLUDE_TARGET_PROCESS_TREE, sinon on capterait un sous-processus ou rien du tout.
/// </summary>
public static class ProcessTree
{
    private const uint SnapshotProcess = 2;

    public static int RootOf(int pid)
    {
        var parents = Snapshot();
        if (!parents.TryGetValue(pid, out var current)) return pid;
        var root = pid;
        var guard = 0;
        while (parents.TryGetValue(current.Parent, out var parent)
               && string.Equals(parent.Exe, current.Exe, StringComparison.OrdinalIgnoreCase)
               && guard++ < 32)
        {
            root = current.Parent;
            current = parent;
        }
        return root;
    }

    private static Dictionary<int, (int Parent, string Exe)> Snapshot()
    {
        var result = new Dictionary<int, (int, string)>();
        var handle = CreateToolhelp32Snapshot(SnapshotProcess, 0);
        if (handle == new IntPtr(-1)) return result;
        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
            if (!Process32FirstW(handle, ref entry)) return result;
            do
            {
                result[(int)entry.ProcessId] = ((int)entry.ParentProcessId, entry.ExeFile);
            } while (Process32NextW(handle, ref entry));
        }
        finally
        {
            CloseHandle(handle);
        }
        return result;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriClassBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern bool Process32NextW(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
