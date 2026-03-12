using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Unicode;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

record OCRLine(double[][] box, string text, double score);
record OCRMeta(string engine, string profile, string profileSource, bool accuracy, string languageHint);
record OCRPayload(string text, List<OCRLine> lines, OCRMeta meta);

static class Program
{
    static async Task<int> Main(string[] args)
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        Console.Error.Write(string.Empty);

        try
        {
            var options = ParseArguments(args);
            var bitmap = await LoadBitmapAsync(options.ImagePath);
            var engine = CreateEngine(options.LanguageHint);
            var result = await engine.RecognizeAsync(bitmap);

            var lines = result.Lines
                .Select(line => new OCRLine(
                    ToBox(line.Words.Select(word => word.BoundingRect).ToList()),
                    NormalizeLine(line.Text),
                    1.0))
                .Where(line => !string.IsNullOrWhiteSpace(line.text))
                .ToList();

            var payload = new OCRPayload(
                string.Join("\n", lines.Select(line => line.text)),
                lines,
                new OCRMeta("windows_media_ocr", "auto", "auto", options.Accuracy, options.LanguageHint)
            );

            var json = JsonSerializer.Serialize(
                payload,
                new JsonSerializerOptions
                {
                    Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
                    WriteIndented = false
                });

            Console.Write(json);
            return 0;
        }
        catch (Exception ex)
        {
            var message = JsonSerializer.Serialize(new { error = ex.Message });
            Console.Error.Write(message);
            return 1;
        }
    }

    private static CLIOptions ParseArguments(string[] args)
    {
        string? imagePath = null;
        var accuracy = false;
        var languageHint = "ko+en";

        for (var index = 0; index < args.Length; index++)
        {
            switch (args[index])
            {
                case "--image-path":
                    if (index + 1 >= args.Length)
                    {
                        throw new InvalidOperationException("Missing required argument: --image-path");
                    }
                    imagePath = args[++index];
                    break;
                case "--accuracy":
                    accuracy = true;
                    break;
                case "--language-hint":
                    if (index + 1 >= args.Length)
                    {
                        throw new InvalidOperationException("Missing value for --language-hint");
                    }
                    languageHint = args[++index];
                    break;
            }
        }

        if (string.IsNullOrWhiteSpace(imagePath))
        {
            throw new InvalidOperationException("Missing required argument: --image-path");
        }

        return new CLIOptions(imagePath, accuracy, languageHint);
    }

    private static OcrEngine CreateEngine(string languageHint)
    {
        var preferred = languageHint.Contains("ko", StringComparison.OrdinalIgnoreCase)
            ? new[] { "ko-KR", "ko", "en-US", "en" }
            : new[] { "en-US", "en" };

        var available = OcrEngine.AvailableRecognizerLanguages
            .ToDictionary(language => language.LanguageTag, language => language, StringComparer.OrdinalIgnoreCase);

        foreach (var candidate in preferred)
        {
            if (available.TryGetValue(candidate, out var language))
            {
                var engine = OcrEngine.TryCreateFromLanguage(language);
                if (engine is not null)
                {
                    return engine;
                }
            }
        }

        var profileEngine = OcrEngine.TryCreateFromUserProfileLanguages();
        if (profileEngine is not null)
        {
            return profileEngine;
        }

        throw new InvalidOperationException("Windows OCR language is not available. Install the Korean or English language pack in Windows settings.");
    }

    private static async Task<SoftwareBitmap> LoadBitmapAsync(string imagePath)
    {
        await using var stream = new InMemoryRandomAccessStream();
        var bytes = await File.ReadAllBytesAsync(imagePath);
        await stream.WriteAsync(bytes.AsBuffer());
        stream.Seek(0);

        var decoder = await BitmapDecoder.CreateAsync(stream);
        return await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore);
    }

    private static string NormalizeLine(string line)
    {
        var parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return string.Join(" ", parts).Trim();
    }

    private static double[][] ToBox(IReadOnlyList<Windows.Foundation.Rect> rects)
    {
        if (rects.Count == 0)
        {
            return new[]
            {
                new[] { 0d, 0d },
                new[] { 0d, 0d },
                new[] { 0d, 0d },
                new[] { 0d, 0d },
            };
        }

        var minX = rects.Min(rect => rect.X);
        var minY = rects.Min(rect => rect.Y);
        var maxX = rects.Max(rect => rect.X + rect.Width);
        var maxY = rects.Max(rect => rect.Y + rect.Height);

        return new[]
        {
            new[] { minX, minY },
            new[] { maxX, minY },
            new[] { maxX, maxY },
            new[] { minX, maxY },
        };
    }

    private sealed record CLIOptions(string ImagePath, bool Accuracy, string LanguageHint);
}
