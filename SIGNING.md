# Host App Code Signing

This project supports signing the built host executable with a PFX certificate.

## Release Rules

- GitHub Release に載せるのは Setup のみ。
- Portable はローカル配布・検証用として保持し、GitHub Release には含めない。
- 対象は host / client / layout すべて同じ運用にそろえる。
- リリース版は Setup と Portable の両方を同じ version でビルドしておく。

## Prerequisites

- A code-signing certificate in PFX format
- PFX password
- Windows SDK SignTool (already available on this machine)

## Build and Sign

1. Build the app:

   npm run build

2. Set environment variables in PowerShell:

   $env:SIGN_CERT_PFX_PATH="C:\path\to\your-cert.pfx"
   $env:SIGN_CERT_PFX_PASSWORD="your-password"

3. Sign and verify:

   npm run sign

The default target is:

- dist\KakiMoni_Host-win32-x64\KakiMoni_Host.exe

## Optional Parameters

You can call the script directly for custom values:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/sign-host.ps1 -ExePath "dist\KakiMoni_Host-win32-x64\KakiMoni_Host.exe" -CertPath "C:\path\cert.pfx" -CertPassword "password" -TimestampUrl "http://timestamp.digicert.com"
```
