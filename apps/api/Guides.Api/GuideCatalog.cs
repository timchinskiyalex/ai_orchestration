using System.Text.Json;

namespace Guides.Api;

public sealed class GuideCatalog
{
    private readonly Dictionary<string, CityGuide> _guides;

    public GuideCatalog(IHostEnvironment environment)
    {
        var directory = Path.Combine(environment.ContentRootPath, "Content");
        if (!Directory.Exists(directory))
            directory = Path.Combine(AppContext.BaseDirectory, "Content");

        if (!Directory.Exists(directory))
            throw new DirectoryNotFoundException("The guide content directory was not found.");

        _guides = Directory.EnumerateFiles(directory, "*.json")
            .Select(file => JsonSerializer.Deserialize<CityGuide>(File.ReadAllText(file), JsonOptions))
            .OfType<CityGuide>()
            .ToDictionary(guide => guide.City, StringComparer.OrdinalIgnoreCase);

        if (_guides.Count == 0)
            throw new InvalidOperationException("No city guides were loaded.");
    }

    public IReadOnlyCollection<CityGuide> All => _guides.Values;
    public bool TryGet(string city, out CityGuide guide) => _guides.TryGetValue(city, out guide!);
    public static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };
}
