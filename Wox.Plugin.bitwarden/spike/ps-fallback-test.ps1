$ErrorActionPreference = "Stop"
# Random throwaway value: this file must not contain a real credential.
$v = -join ((48..57 + 97..122 | Get-Random -Count 24 | ForEach-Object { [char]$_ }))
$s = ConvertTo-SecureString $v -AsPlainText -Force
$env:BW_TEST_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringUni(
    [Runtime.InteropServices.Marshal]::SecureStringToGlobalAllocUnicode($s))
node spike/env-probe.js 24
Remove-Item Env:BW_TEST_PASSWORD
$stillThere = [bool](Get-Item Env:BW_TEST_PASSWORD -ErrorAction SilentlyContinue)
Write-Output "env cleared after Remove-Item: $($stillThere -eq $False)"
Write-Output "powershell fallback path OK"
