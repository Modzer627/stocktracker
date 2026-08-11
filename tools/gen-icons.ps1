# Generates the PWA icon set with System.Drawing (no external tools needed).
# Run from the project root:  powershell -ExecutionPolicy Bypass -File tools\gen-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconDir = Join-Path $root "icons"
if (-not (Test-Path $iconDir)) { New-Item -ItemType Directory -Path $iconDir | Out-Null }

function New-Icon([int]$size, [string]$name, [double]$pad) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $bg = [System.Drawing.ColorTranslator]::FromHtml("#0F172A")
    $white = [System.Drawing.ColorTranslator]::FromHtml("#F1F5F9")
    $accent = [System.Drawing.ColorTranslator]::FromHtml("#38BDF8")
    $g.Clear($bg)

    # Barcode bars centered in the safe area
    $inner = $size * (1.0 - 2.0 * $pad)
    $x0 = $size * $pad
    $y0 = $size * ($pad + 0.08)
    $h = $size * (1.0 - 2.0 * ($pad + 0.08))
    $pattern = @(2, 1, 3, 1, 2, 2, 1, 3, 1, 2)   # relative bar widths, gaps equal widths
    $totalUnits = 0; foreach ($p in $pattern) { $totalUnits += $p + 1 }
    $unit = $inner / $totalUnits
    $brush = New-Object System.Drawing.SolidBrush($white)
    $x = $x0
    foreach ($p in $pattern) {
        $g.FillRectangle($brush, [single]$x, [single]$y0, [single]($p * $unit * 0.92), [single]$h)
        $x += ($p + 1) * $unit
    }

    # Accent scan line across the middle
    $accBrush = New-Object System.Drawing.SolidBrush($accent)
    $lineH = [Math]::Max(3, $size * 0.05)
    $g.FillRectangle($accBrush, [single]($size * ($pad * 0.6)), [single](($size - $lineH) / 2), [single]($size * (1 - 1.2 * $pad * 0.6)), [single]$lineH)

    $out = Join-Path $iconDir $name
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "wrote $out"
}

New-Icon 512 "icon-512.png" 0.16
New-Icon 192 "icon-192.png" 0.16
New-Icon 512 "icon-maskable-512.png" 0.26
New-Icon 180 "apple-touch-icon.png" 0.16
