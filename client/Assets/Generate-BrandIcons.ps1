# Reproducible multi-resolution icon, rendered from vector geometry with WPF.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase
$drawing = @'
<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Width="256" Height="256">
 <Border Margin="8" CornerRadius="60"><Border.Background><LinearGradientBrush StartPoint="0,0" EndPoint="1,1"><GradientStop Color="#53C9FF" Offset="0"/><GradientStop Color="#347BEF" Offset=".5"/><GradientStop Color="#7956DD" Offset="1"/></LinearGradientBrush></Border.Background></Border>
 <Border Margin="13" CornerRadius="55" BorderBrush="#80FFFFFF" BorderThickness="2"/>
 <Path Data="M22,100 V68 Q22,22 68,22 H188 Q234,22 234,68 V100 Q128,144 22,100Z"><Path.Fill><LinearGradientBrush StartPoint="0,0" EndPoint="0,1"><GradientStop Color="#73FFFFFF" Offset="0"/><GradientStop Color="#00FFFFFF" Offset="1"/></LinearGradientBrush></Path.Fill></Path>
 <Path Data="M57,166 V145 C57,99 89,70 128,70 S199,99 199,145 V166" Stroke="White" StrokeThickness="19" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
 <Path Data="M53,171 H203 M89,167 V141 M128,166 V125 M167,167 V141" Stroke="White" StrokeThickness="13" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
 <Path Data="M87,197 Q128,209 169,197" Stroke="#AAF2FF" StrokeThickness="8" StrokeStartLineCap="Round" StrokeEndLineCap="Round"/>
</Grid>
'@
$visual = [Windows.Markup.XamlReader]::Parse($drawing)
$visual.Measure([Windows.Size]::new(256,256))
$visual.Arrange([Windows.Rect]::new(0,0,256,256))
$visual.UpdateLayout()
$frames = @()
foreach ($size in @(16,20,24,32,40,48,64,128,256)) {
  $bitmap = [Windows.Media.Imaging.RenderTargetBitmap]::new($size,$size,96*$size/256,96*$size/256,[Windows.Media.PixelFormats]::Pbgra32)
  $bitmap.Render($visual)
  $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
  $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
  $memory = [IO.MemoryStream]::new()
  $encoder.Save($memory)
  $frames += ,@{Size=$size;Bytes=$memory.ToArray()}
  if ($size -eq 256) { [IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'YiseCloudBridge.png'),$memory.ToArray()) }
  $memory.Dispose()
}
$stream = [IO.File]::Create((Join-Path $PSScriptRoot 'YiseCloudBridge.ico'))
$writer = [IO.BinaryWriter]::new($stream)
try {
  $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
  $offset = 6 + 16*$frames.Count
  foreach ($frame in $frames) {
    $dimension = if ($frame.Size -eq 256) {0} else {$frame.Size}
    $writer.Write([byte]$dimension); $writer.Write([byte]$dimension); $writer.Write([byte]0); $writer.Write([byte]0)
    $writer.Write([uint16]1); $writer.Write([uint16]32); $writer.Write([uint32]$frame.Bytes.Length); $writer.Write([uint32]$offset)
    $offset += $frame.Bytes.Length
  }
  foreach ($frame in $frames) { $writer.Write([byte[]]$frame.Bytes) }
} finally { $writer.Dispose(); $stream.Dispose() }
Write-Output 'Brand icon generated in 9 sizes (16–256 px).'
