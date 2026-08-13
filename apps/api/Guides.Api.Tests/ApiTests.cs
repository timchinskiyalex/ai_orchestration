using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace Guides.Api.Tests;

public sealed class ApiTests : IClassFixture<ApiFactory>
{
    private readonly ApiFactory _factory;

    public ApiTests(ApiFactory factory) => _factory = factory;

    [Fact]
    public async Task Register_logout_login_and_me_use_cookie_authentication()
    {
        using var client = _factory.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true, AllowAutoRedirect = false });
        var email = NewEmail();
        var register = await client.PostAsJsonAsync("/api/auth/register", new { email, password = "SecurePass1!" });
        Assert.Equal(HttpStatusCode.Created, register.StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/auth/me")).StatusCode);

        Assert.Equal(HttpStatusCode.NoContent, (await client.PostAsync("/api/auth/logout", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/auth/me")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/auth/login", new { email, password = "SecurePass1!" })).StatusCode);

        using var me = JsonDocument.Parse(await (await client.GetAsync("/api/auth/me")).Content.ReadAsStringAsync());
        Assert.Equal(email, me.RootElement.GetProperty("email").GetString());
    }

    [Fact]
    public async Task Anonymous_guide_hides_locked_fields_and_purchase_reveals_them()
    {
        using var anonymous = _factory.CreateClient();
        using var anonymousGuide = JsonDocument.Parse(await (await anonymous.GetAsync("/api/guides/madrid")).Content.ReadAsStringAsync());
        var locked = anonymousGuide.RootElement.GetProperty("places").EnumerateArray().First(place =>
            place.TryGetProperty("locked", out var isLocked) && isLocked.GetBoolean());
        Assert.True(locked.TryGetProperty("why_go", out _));
        Assert.False(locked.TryGetProperty("description", out _));
        Assert.False(locked.TryGetProperty("cost", out _));
        Assert.False(locked.TryGetProperty("lat", out _));

        using var client = await RegisteredClient();
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/guides/madrid/purchase", null)).StatusCode);
        using var purchasedGuide = JsonDocument.Parse(await (await client.GetAsync("/api/guides/madrid")).Content.ReadAsStringAsync());
        var revealed = purchasedGuide.RootElement.GetProperty("places").EnumerateArray().First(place => place.GetProperty("slug").GetString() == locked.GetProperty("slug").GetString());
        Assert.True(revealed.TryGetProperty("description", out _));
        Assert.True(revealed.TryGetProperty("lat", out _));
    }

    [Fact]
    public async Task Favorites_require_authentication_and_can_be_created_listed_and_removed()
    {
        using var anonymous = _factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync("/api/favorites")).StatusCode);

        using var client = await RegisteredClient();
        var add = await client.PostAsJsonAsync("/api/favorites", new { city = "Paris", placeSlug = "eiffel-tower" });
        Assert.Equal(HttpStatusCode.OK, add.StatusCode);
        using var created = JsonDocument.Parse(await add.Content.ReadAsStringAsync());
        var id = created.RootElement.GetProperty("id").GetInt32();

        using var favorites = JsonDocument.Parse(await (await client.GetAsync("/api/favorites")).Content.ReadAsStringAsync());
        Assert.Contains(favorites.RootElement.EnumerateArray(), favorite => favorite.GetProperty("placeSlug").GetString() == "eiffel-tower");
        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync($"/api/favorites/{id}")).StatusCode);
    }

    [Fact]
    public async Task Ratings_are_public_and_repeat_post_upserts_the_users_rating()
    {
        using var client = await RegisteredClient();
        const string path = "/api/guides/paris/places/eiffel-tower/ratings";
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(path, new { stars = 4, comment = "Great view" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(path, new { stars = 5, comment = "Even better at dusk" })).StatusCode);

        using var ratings = JsonDocument.Parse(await (await _factory.CreateClient().GetAsync(path)).Content.ReadAsStringAsync());
        Assert.Equal(1, ratings.RootElement.GetProperty("ratings").GetArrayLength());
        Assert.Equal(5, ratings.RootElement.GetProperty("ratings")[0].GetProperty("stars").GetInt32());
        Assert.Equal(5m, ratings.RootElement.GetProperty("average").GetDecimal());
    }

    private async Task<HttpClient> RegisteredClient()
    {
        var client = _factory.CreateClient(new WebApplicationFactoryClientOptions { HandleCookies = true, AllowAutoRedirect = false });
        var response = await client.PostAsJsonAsync("/api/auth/register", new { email = NewEmail(), password = "SecurePass1!" });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return client;
    }

    private static string NewEmail() => $"test-{Guid.NewGuid():N}@example.com";
}

public sealed class ApiFactory : WebApplicationFactory<Program>, IDisposable
{
    private readonly string _databasePath = Path.Combine(Path.GetTempPath(), $"guides-api-{Guid.NewGuid():N}.db");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["ConnectionStrings:DefaultConnection"] = $"Data Source={_databasePath}"
        }));
    }

    public new void Dispose()
    {
        base.Dispose();
        try
        {
            if (File.Exists(_databasePath))
                File.Delete(_databasePath);
        }
        catch (IOException)
        {
            // The operating system will clean this uniquely named test database.
        }
    }
}
