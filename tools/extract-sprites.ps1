param(
  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
)

Add-Type -AssemblyName System.Drawing

function Export-GhostSprite {
  param(
    [string]$InputPath,
    [string]$OutputPath,
    [System.Drawing.Rectangle]$Crop,
    [ValidateSet('lumen', 'umbra')][string]$Kind
  )

  $source = [System.Drawing.Bitmap]::FromFile($InputPath)
  try {
    $out = New-Object System.Drawing.Bitmap 384, 384, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($out)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, 384, 384), $Crop, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $graphics.Dispose() }

      for ($y = 0; $y -lt $out.Height; $y++) {
        for ($x = 0; $x -lt $out.Width; $x++) {
          $c = $out.GetPixel($x, $y)
          $max = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
          $min = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
          $sat = $max - $min
          if ($Kind -eq 'lumen') {
            $signal = [Math]::Max(0, ($c.R - $c.B) + ($c.G - $c.B) * 0.35)
          } else {
            $signal = [Math]::Max(0, ($c.B - $c.G) + ($c.R - $c.G) * 0.25)
          }
          $alpha = [Math]::Min(255, [Math]::Max(0, ($signal - 8) * 4.2 + ($sat - 16) * 2.2))
          if ($alpha -lt 10) { $alpha = 0 }
          $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int]$alpha, $c.R, $c.G, $c.B))
        }
      }

      $out.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $out.Dispose() }
  } finally { $source.Dispose() }
}

function Export-MechanismSprite {
  param(
    [string]$InputPath,
    [string]$OutputPath,
    [System.Drawing.Rectangle]$Crop,
    [int]$Width,
    [int]$Height
  )

  $source = [System.Drawing.Bitmap]::FromFile($InputPath)
  try {
    $out = New-Object System.Drawing.Bitmap $Width, $Height, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($out)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($source, [System.Drawing.Rectangle]::new(0, 0, $Width, $Height), $Crop, [System.Drawing.GraphicsUnit]::Pixel)
      } finally { $graphics.Dispose() }

      for ($y = 0; $y -lt $out.Height; $y++) {
        for ($x = 0; $x -lt $out.Width; $x++) {
          $c = $out.GetPixel($x, $y)
          $max = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
          $min = [Math]::Min($c.R, [Math]::Min($c.G, $c.B))
          $sat = $max - $min
          $brightness = ($c.R + $c.G + $c.B) / 3
          $alpha = 255
          if ($brightness -gt 148 -and $sat -lt 24) {
            $alpha = [Math]::Max(0, [Math]::Min(255, ($sat - 5) * 14 + (178 - $brightness) * 5))
          }
          if ($alpha -lt 12) { $alpha = 0 }
          $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb([int]$alpha, $c.R, $c.G, $c.B))
        }
      }
      $out.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $out.Dispose() }
  } finally { $source.Dispose() }
}

$art = Join-Path $ProjectRoot 'art'
$sourceArt = Join-Path $art 'source'

Export-GhostSprite `
  -InputPath (Join-Path $sourceArt 'ghost-lumen-sheet-source.jpg') `
  -OutputPath (Join-Path $art 'ghost-lumen.png') `
  -Crop ([System.Drawing.Rectangle]::new(70, 35, 390, 330)) `
  -Kind lumen

Export-GhostSprite `
  -InputPath (Join-Path $sourceArt 'ghost-umbra-sheet-source.jpg') `
  -OutputPath (Join-Path $art 'ghost-umbra.png') `
  -Crop ([System.Drawing.Rectangle]::new(55, 25, 430, 330)) `
  -Kind umbra

$mechanisms = Join-Path $sourceArt 'mechanisms-concept.png'
if (Test-Path -LiteralPath $mechanisms) {
  Export-MechanismSprite `
    -InputPath $mechanisms `
    -OutputPath (Join-Path $art 'pressure-plate.png') `
    -Crop ([System.Drawing.Rectangle]::new(45, 700, 735, 305)) `
    -Width 512 -Height 212

  Export-MechanismSprite `
    -InputPath $mechanisms `
    -OutputPath (Join-Path $art 'gate-block.png') `
    -Crop ([System.Drawing.Rectangle]::new(900, 0, 570, 1024)) `
    -Width 384 -Height 690
}

Write-Output 'Exported game-ready ghost and mechanism sprites'
