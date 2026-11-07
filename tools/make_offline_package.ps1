# Builds the offline package: the app plus Schedule Iguana's AI model (Llama 3.2 1B Instruct, q8,
# Llama 3.2 Community License) in one ZIP that runs with no internet. Output: dist\scaled-schedule-offline.zip
# Run from the repo root:  powershell -ExecutionPolicy Bypass -File tools\make_offline_package.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$stage = Join-Path $root 'dist\scaled-schedule'
$zip = Join-Path $root 'dist\scaled-schedule-offline.zip'
$model = 'onnx-community/Llama-3.2-1B-Instruct'
$files = 'config.json', 'generation_config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force $stage | Out-Null
Copy-Item (Join-Path $root 'app') (Join-Path $stage 'app') -Recurse
Copy-Item (Join-Path $root 'README.md'), (Join-Path $root 'LICENSE') $stage
Set-Content (Join-Path $stage 'Start scaled Schedule.bat') -Encoding ascii -Value @(
  '@echo off',
  'rem Opens scaled Schedule from this folder (needs Python). Everything runs on this computer.',
  'cd /d "%~dp0app"',
  'start "" http://localhost:5080/',
  'python -m http.server 5080 --bind 127.0.0.1'
)

# Reuse a previous download if it's complete, so rebuilding the package is quick.
$cache = Join-Path $root 'dist\model-cache'
foreach ($f in $files) {
  $dest = Join-Path $cache ($model + '/' + $f)
  if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
    Write-Host "Downloading $f ..."
    Invoke-WebRequest "https://huggingface.co/$model/resolve/main/$f" -OutFile $dest -UseBasicParsing
  }
}
Copy-Item (Join-Path $cache 'onnx-community') (Join-Path $stage 'app\models\onnx-community') -Recurse
Set-Content (Join-Path $stage 'app\models\MODEL-LICENSE.txt') -Value @(
  'Built with Llama. Schedule Iguana uses Llama 3.2 1B Instruct by Meta, licensed under the Llama 3.2',
  'Community License (https://www.llama.com/llama3_2/license/) and its Acceptable Use Policy',
  '(https://www.llama.com/llama3_2/use-policy/). Llama 3.2 is licensed under the Llama 3.2 Community License,',
  'Copyright (c) Meta Platforms, Inc. All Rights Reserved.',
  'Model files from https://huggingface.co/onnx-community/Llama-3.2-1B-Instruct (ONNX conversion).'
)

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
"Built $zip ($([math]::Round((Get-Item $zip).Length / 1MB)) MB)"
