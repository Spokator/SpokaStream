using System.Diagnostics;

namespace SpokaAudio;

/// <summary>
/// Le dernier mot avant d'entrer dans un jeu. Discord et OBS y entrent avec une DLL signée, connue des éditeurs d'anti-triche : pas nous.
/// Un doute suffit à renoncer : la capture normale ne touche pas au jeu, et on perd au pire la souris d'un jeu OpenGL.
/// Tout se lit sans ouvrir le jeu. Le test capture-game vérifie qu'un jeu protégé ne reçoit pas la DLL.
/// </summary>
internal static class AntiCheat
{
    private const int FolderDepth = 4;

    /// <summary>Ces services ne tournent qu'avec un jeu protégé. Vanguard n'y est pas : lui tourne tout le temps.</summary>
    private static readonly string[] Services = ["EasyAntiCheat", "EasyAntiCheat_EOS", "BEService", "BEService_x64", "EAAntiCheat.GameServiceLauncher", "PnkBstrA", "PnkBstrB"];

    private static readonly string[] Games = ["League of Legends.exe", "LeagueClient.exe", "LeagueClientUx.exe", "RiotClientServices.exe", "VALORANT-Win64-Shipping.exe"];

    /// <summary>Ce qu'un anti-triche laisse à côté du jeu, en dossier ou en fichier.</summary>
    private static readonly string[] Traces =
    [
        "EasyAntiCheat", "EasyAntiCheat_EOS", "EasyAntiCheat_x64.dll", "EasyAntiCheat_EOS_Setup.exe",
        "BattlEye", "BEClient_x64.dll", "BEService_x64.exe",
        "EAAntiCheat.Installer.exe", "EAAntiCheat.GameServiceLauncher.exe",
        "GameGuard", "XIGNCODE", "PnkBstrA.exe", "mhyprot3.sys", "HoYoKProtect.sys",
    ];

    public static bool Protects(string gamePath)
    {
        if (gamePath.Contains(@"\Riot Games\", StringComparison.OrdinalIgnoreCase)) return true;
        if (Games.Contains(Path.GetFileName(gamePath), StringComparer.OrdinalIgnoreCase)) return true;
        if (Services.Any(IsRunning)) return true;

        var shared = SharedFolders();
        var folder = new DirectoryInfo(Path.GetDirectoryName(gamePath)!);
        for (var depth = 0; depth < FolderDepth && folder?.Parent is not null && !shared.Contains(folder.FullName); depth++)
        {
            if (Traces.Any(trace => Path.Exists(Path.Combine(folder.FullName, trace)))) return true;
            // Au-dessus de la racine d'un jeu Steam, ce sont les autres jeux.
            if (string.Equals(folder.Parent?.Name, "common", StringComparison.OrdinalIgnoreCase)) break;
            folder = folder.Parent;
        }
        return false;
    }

    /// <summary>Un jeu y laisse des traces pour tous les autres : un vieux dossier BattlEye dans AppData ne dit rien du jeu qu'on regarde.</summary>
    private static HashSet<string> SharedFolders()
    {
        Environment.SpecialFolder[] known =
        [
            Environment.SpecialFolder.UserProfile, Environment.SpecialFolder.LocalApplicationData, Environment.SpecialFolder.ApplicationData,
            Environment.SpecialFolder.CommonApplicationData, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86,
        ];
        var folders = known.Select(Environment.GetFolderPath).Append(Path.TrimEndingDirectorySeparator(Path.GetTempPath()));
        return new HashSet<string>(folders, StringComparer.OrdinalIgnoreCase);
    }

    private static bool IsRunning(string name)
    {
        var found = Process.GetProcessesByName(name);
        foreach (var process in found) process.Dispose();
        return found.Length > 0;
    }
}
