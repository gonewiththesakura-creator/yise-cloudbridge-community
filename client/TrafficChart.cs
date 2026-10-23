using System.Windows;
using System.Windows.Media;

namespace CloudBridge.Client;

public sealed class TrafficChart : FrameworkElement
{
    private readonly Queue<(double Download, double Upload)> _samples = new();
    private static readonly Pen DownloadPen = CreatePen("#007AFF", 2.2);
    private static readonly Pen UploadPen = CreatePen("#30B0C7", 1.8);
    private static readonly Pen GridPen = CreatePen("#E5E5EA", 1);

    public int Capacity { get; set; } = 60;

    public void AddSample(double downloadMbps, double uploadMbps)
    {
        _samples.Enqueue((Math.Max(0, downloadMbps), Math.Max(0, uploadMbps)));
        while (_samples.Count > Capacity) _samples.Dequeue();
        InvalidateVisual();
    }

    public void Clear()
    {
        _samples.Clear();
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext drawingContext)
    {
        base.OnRender(drawingContext);
        var width = ActualWidth;
        var height = ActualHeight;
        if (width <= 1 || height <= 1) return;

        for (var line = 1; line <= 3; line++)
        {
            var y = height * line / 4d;
            drawingContext.DrawLine(GridPen, new Point(0, y), new Point(width, y));
        }

        var samples = _samples.ToArray();
        if (samples.Length < 2) return;
        var maximum = Math.Max(1, samples.Max(value => Math.Max(value.Download, value.Upload)) * 1.16);
        DrawSeries(drawingContext, samples.Select(value => value.Download).ToArray(), maximum, width, height, DownloadPen,
            Color.FromArgb(30, 0, 122, 255));
        DrawSeries(drawingContext, samples.Select(value => value.Upload).ToArray(), maximum, width, height, UploadPen,
            Color.FromArgb(20, 48, 176, 199));
    }

    private static void DrawSeries(DrawingContext context, double[] values, double maximum, double width, double height, Pen pen, Color fillColor)
    {
        var geometry = new StreamGeometry();
        using (var writer = geometry.Open())
        {
            for (var index = 0; index < values.Length; index++)
            {
                var x = width * index / Math.Max(1, values.Length - 1d);
                var y = height - Math.Clamp(values[index] / maximum, 0, 1) * (height - 4) - 2;
                if (index == 0) writer.BeginFigure(new Point(x, y), false, false);
                else writer.LineTo(new Point(x, y), true, false);
            }
        }
        geometry.Freeze();
        context.DrawGeometry(null, pen, geometry);

        var fill = new StreamGeometry();
        using (var writer = fill.Open())
        {
            writer.BeginFigure(new Point(0, height), true, true);
            for (var index = 0; index < values.Length; index++)
            {
                var x = width * index / Math.Max(1, values.Length - 1d);
                var y = height - Math.Clamp(values[index] / maximum, 0, 1) * (height - 4) - 2;
                writer.LineTo(new Point(x, y), true, false);
            }
            writer.LineTo(new Point(width, height), true, false);
        }
        fill.Freeze();
        context.DrawGeometry(new SolidColorBrush(fillColor), null, fill);
    }

    private static Pen CreatePen(string color, double thickness)
    {
        var pen = new Pen(new SolidColorBrush((Color)ColorConverter.ConvertFromString(color)), thickness)
        {
            StartLineCap = PenLineCap.Round,
            EndLineCap = PenLineCap.Round,
            LineJoin = PenLineJoin.Round,
        };
        pen.Freeze();
        return pen;
    }
}
