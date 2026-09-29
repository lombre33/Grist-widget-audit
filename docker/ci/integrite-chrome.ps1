# Sous Windows : une ligne par processus chrome.exe — « pid|type|niveau|--no-sandbox ».
# « niveau » est le niveau d'intégrité du jeton du processus : 0 non fiable,
# 4096 (0x1000) faible, 8192 (0x2000) moyen, 12288 élevé ; négatif si illisible.
# Le bac à sable de Chromium sous Windows abaisse le jeton des processus de rendu
# (non fiable ou faible) ; sous --no-sandbox ils gardent le niveau moyen du
# navigateur : c'est la preuve directe, indépendante de tout argument de ligne de
# commande, utilisée par docker/ci/verifier-windows.mjs.
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Integrite {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint acces, bool herite, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr h, uint acces, out IntPtr jeton);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr jeton, int classe, IntPtr tampon, int taille, out int retour);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, uint n);
  public static int Niveau(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return -1;
    IntPtr jeton;
    if (!OpenProcessToken(h, 0x8, out jeton)) { CloseHandle(h); return -2; }
    int taille;
    GetTokenInformation(jeton, 25, IntPtr.Zero, 0, out taille);
    IntPtr tampon = Marshal.AllocHGlobal(taille);
    int niveau = -3;
    if (GetTokenInformation(jeton, 25, tampon, taille, out taille)) {
      IntPtr sid = Marshal.ReadIntPtr(tampon);
      byte n = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
      niveau = Marshal.ReadInt32(GetSidSubAuthority(sid, (uint)(n - 1)));
    }
    Marshal.FreeHGlobal(tampon); CloseHandle(jeton); CloseHandle(h);
    return niveau;
  }
}
"@
Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ForEach-Object {
  $type = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }
  $sans = [bool]($_.CommandLine -match '--no-sandbox')
  '{0}|{1}|{2}|{3}' -f $_.ProcessId, $type, [Integrite]::Niveau($_.ProcessId), $sans
}
