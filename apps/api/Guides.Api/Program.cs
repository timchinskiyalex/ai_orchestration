using System.Security.Claims;
using Guides.Api;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddDbContext<GuidesDbContext>(options =>
    options.UseSqlite(builder.Configuration.GetConnectionString("DefaultConnection") ?? "Data Source=guides.db"));
builder.Services.AddIdentity<ApplicationUser, IdentityRole>(options =>
{
    options.User.RequireUniqueEmail = true;
    options.Password.RequiredLength = 8;
})
    .AddEntityFrameworkStores<GuidesDbContext>()
    .AddDefaultTokenProviders();
builder.Services.ConfigureApplicationCookie(options =>
{
    options.Cookie.HttpOnly = true;
    options.Cookie.SameSite = SameSiteMode.Lax;
    options.Events.OnRedirectToLogin = context =>
    {
        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return Task.CompletedTask;
    };
    options.Events.OnRedirectToAccessDenied = context =>
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return Task.CompletedTask;
    };
});
builder.Services.AddAuthorization();
builder.Services.AddCors(options => options.AddPolicy("nextjs", policy => policy
    .WithOrigins("http://localhost:3000")
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));
builder.Services.AddSingleton<GuideCatalog>();

var app = builder.Build();

using (var scope = app.Services.CreateScope())
    await scope.ServiceProvider.GetRequiredService<GuidesDbContext>().Database.EnsureCreatedAsync();

app.UseCors("nextjs");
app.UseAuthentication();
app.UseAuthorization();

var api = app.MapGroup("/api");

api.MapPost("/auth/register", async (CredentialsRequest request, UserManager<ApplicationUser> users, SignInManager<ApplicationUser> signIn) =>
{
    var user = new ApplicationUser { UserName = request.Email, Email = request.Email };
    var result = await users.CreateAsync(user, request.Password);
    if (!result.Succeeded)
        return Results.ValidationProblem(result.Errors.GroupBy(error => error.Code).ToDictionary(
            group => group.Key, group => group.Select(error => error.Description).ToArray()));

    await signIn.SignInAsync(user, isPersistent: false);
    return Results.Created("/api/auth/me", new { email = user.Email });
});

api.MapPost("/auth/login", async (CredentialsRequest request, SignInManager<ApplicationUser> signIn) =>
{
    var result = await signIn.PasswordSignInAsync(request.Email, request.Password, isPersistent: false, lockoutOnFailure: false);
    return result.Succeeded
        ? Results.Ok(new { email = request.Email })
        : Results.Unauthorized();
});

api.MapPost("/auth/logout", async (SignInManager<ApplicationUser> signIn) =>
{
    await signIn.SignOutAsync();
    return Results.NoContent();
});

api.MapGet("/auth/me", (ClaimsPrincipal principal) =>
    Results.Ok(new { email = principal.FindFirstValue(ClaimTypes.Email) ?? principal.Identity?.Name }))
    .RequireAuthorization();

api.MapGet("/guides", async (ClaimsPrincipal principal, GuidesDbContext db, GuideCatalog catalog) =>
{
    var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier);
    var purchasedCities = userId is null
        ? new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        : (await db.Purchases.Where(purchase => purchase.UserId == userId).Select(purchase => purchase.City).ToListAsync())
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
    return Results.Ok(catalog.All.OrderBy(guide => guide.City).Select(guide => new
    {
        city = guide.City,
        intro = guide.Intro,
        price = 4.99m,
        purchased = purchasedCities.Contains(guide.City)
    }));
});

api.MapGet("/guides/{city}", async (string city, ClaimsPrincipal principal, GuidesDbContext db, GuideCatalog catalog) =>
{
    if (!catalog.TryGet(city, out var guide))
        return Results.NotFound();

    var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier);
    var purchased = userId is not null && await db.Purchases.AnyAsync(purchase => purchase.UserId == userId && purchase.City == guide.City);
    var places = guide.Places.Select(place => place.IsPreview || purchased
        ? (object)new
        {
            slug = place.Slug,
            name = place.Name,
            why_go = place.WhyGo,
            description = place.Description,
            how_to_get_there = place.HowToGetThere,
            cost = place.Cost,
            booking_tip = place.BookingTip,
            lat = place.Lat,
            lng = place.Lng,
            is_preview = place.IsPreview
        }
        : new { slug = place.Slug, name = place.Name, why_go = place.WhyGo, locked = true });

    return Results.Ok(new { city = guide.City, intro = guide.Intro, price = 4.99m, purchased, places });
});

api.MapPost("/guides/{city}/purchase", async (string city, ClaimsPrincipal principal, GuidesDbContext db, GuideCatalog catalog) =>
{
    if (!catalog.TryGet(city, out var guide))
        return Results.NotFound();
    var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier)!;
    var existing = await db.Purchases.SingleOrDefaultAsync(purchase => purchase.UserId == userId && purchase.City == guide.City);
    if (existing is null)
    {
        existing = new Purchase { UserId = userId, City = guide.City, PurchasedAt = DateTime.UtcNow };
        db.Purchases.Add(existing);
        await db.SaveChangesAsync();
    }
    return Results.Ok(new { city = existing.City, purchased = true, purchasedAt = existing.PurchasedAt });
}).RequireAuthorization();

api.MapGet("/favorites", async (ClaimsPrincipal principal, GuidesDbContext db) =>
{
    var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier)!;
    var favorites = await db.Favorites.Where(favorite => favorite.UserId == userId)
        .OrderByDescending(favorite => favorite.CreatedAt)
        .Select(favorite => new { id = favorite.Id, city = favorite.City, placeSlug = favorite.PlaceSlug, createdAt = favorite.CreatedAt })
        .ToListAsync();
    return Results.Ok(favorites);
}).RequireAuthorization();

api.MapPost("/favorites", async (FavoriteRequest request, ClaimsPrincipal principal, GuidesDbContext db, GuideCatalog catalog) =>
{
    if (!TryFindPlace(catalog, request.City, request.PlaceSlug, out var guide))
        return Results.NotFound();
    var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier)!;
    var favorite = await db.Favorites.SingleOrDefaultAsync(item => item.UserId == userId && item.City == guide.City && item.PlaceSlug == request.PlaceSlug);
    if (favorite is null)
    {
        favorite = new Favorite { UserId = userId, City = guide.City, PlaceSlug = request.PlaceSlug, CreatedAt = DateTime.UtcNow };
        db.Favorites.Add(favorite);
        await db.SaveChangesAsync();
    }
    return Results.Ok(new { id = favorite.Id, city = favorite.City, placeSlug = favorite.PlaceSlug, createdAt = favorite.CreatedAt });
}).RequireAuthorization();

api.MapDelete("/favorites/{id:int}", async (int id, ClaimsPrincipal principal, GuidesDbContext db) =>
{
    var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier)!;
    var favorite = await db.Favorites.SingleOrDefaultAsync(item => item.Id == id && item.UserId == userId);
    if (favorite is null)
        return Results.NotFound();
    db.Favorites.Remove(favorite);
    await db.SaveChangesAsync();
    return Results.NoContent();
}).RequireAuthorization();

api.MapGet("/guides/{city}/places/{slug}/ratings", async (string city, string slug, GuidesDbContext db, GuideCatalog catalog) =>
{
    if (!TryFindPlace(catalog, city, slug, out var guide))
        return Results.NotFound();
    var ratings = await db.Ratings.Where(rating => rating.City == guide.City && rating.PlaceSlug == slug)
        .OrderByDescending(rating => rating.CreatedAt)
        .Select(rating => new { id = rating.Id, stars = rating.Stars, comment = rating.Comment, createdAt = rating.CreatedAt })
        .ToListAsync();
    return Results.Ok(new { average = ratings.Count == 0 ? 0m : ratings.Average(rating => (decimal)rating.stars), ratings });
});

api.MapPost("/guides/{city}/places/{slug}/ratings", async (string city, string slug, RatingRequest request, ClaimsPrincipal principal, GuidesDbContext db, GuideCatalog catalog) =>
{
    if (!TryFindPlace(catalog, city, slug, out var guide))
        return Results.NotFound();
    if (request.Stars is < 1 or > 5 || request.Comment?.Length > 2000)
        return Results.ValidationProblem(new Dictionary<string, string[]> { ["rating"] = ["Stars must be from 1 to 5 and comments may contain at most 2000 characters."] });

    var userId = principal.FindFirstValue(ClaimTypes.NameIdentifier)!;
    var rating = await db.Ratings.SingleOrDefaultAsync(item => item.UserId == userId && item.City == guide.City && item.PlaceSlug == slug);
    if (rating is null)
    {
        rating = new Rating { UserId = userId, City = guide.City, PlaceSlug = slug, Stars = request.Stars, Comment = request.Comment, CreatedAt = DateTime.UtcNow };
        db.Ratings.Add(rating);
    }
    else
    {
        rating.Stars = request.Stars;
        rating.Comment = request.Comment;
        rating.CreatedAt = DateTime.UtcNow;
    }
    await db.SaveChangesAsync();
    return Results.Ok(new { id = rating.Id, stars = rating.Stars, comment = rating.Comment, createdAt = rating.CreatedAt });
}).RequireAuthorization();

app.Run();

static bool TryFindPlace(GuideCatalog catalog, string city, string slug, out CityGuide guide)
{
    return catalog.TryGet(city, out guide!) && guide.Places.Any(place => string.Equals(place.Slug, slug, StringComparison.OrdinalIgnoreCase));
}

public partial class Program { }
