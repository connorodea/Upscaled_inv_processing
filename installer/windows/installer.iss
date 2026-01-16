; Upscaled Inventory - Windows Installer
#define MyAppName "Upscaled Inventory"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Upscaled"
#define MyAppExeName "upscaled.cmd"
#define MyAppDir "..\\..\\dist\\windows\\app"

[Setup]
AppId={{6F1B3C6A-8E6E-4DB4-9D38-2A7A0BE6E2A1}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\\Upscaled
DefaultGroupName={#MyAppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
OutputDir=..\\..\\dist\\windows
OutputBaseFilename=UpscaledSetup
Compression=lzma2
SolidCompression=yes
ChangesEnvironment=yes
SetupIconFile={#MyAppDir}\\assets\\icon.ico

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#MyAppDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\\{#MyAppName}"; Filename: "{app}\\bin\\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\\assets\\icon.ico"
Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\bin\\{#MyAppExeName}"; WorkingDir: "{app}"; IconFilename: "{app}\\assets\\icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop icon"; Flags: unchecked

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\\bin"; Flags: preservestringtype

[Run]
Filename: "{app}\\bin\\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent
