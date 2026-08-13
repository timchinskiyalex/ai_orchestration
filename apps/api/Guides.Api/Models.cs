using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;

namespace Guides.Api;

public sealed class ApplicationUser : IdentityUser
{
}

public sealed class Purchase
{
    public int Id { get; set; }
    public required string UserId { get; set; }
    public required string City { get; set; }
    public DateTime PurchasedAt { get; set; }
}

public sealed class Favorite
{
    public int Id { get; set; }
    public required string UserId { get; set; }
    public required string City { get; set; }
    public required string PlaceSlug { get; set; }
    public DateTime CreatedAt { get; set; }
}

public sealed class Rating
{
    public int Id { get; set; }
    public required string UserId { get; set; }
    public required string City { get; set; }
    public required string PlaceSlug { get; set; }
    public int Stars { get; set; }
    public string? Comment { get; set; }
    public DateTime CreatedAt { get; set; }
}

public sealed class GuidesDbContext(DbContextOptions<GuidesDbContext> options)
    : IdentityDbContext<ApplicationUser>(options)
{
    public DbSet<Purchase> Purchases => Set<Purchase>();
    public DbSet<Favorite> Favorites => Set<Favorite>();
    public DbSet<Rating> Ratings => Set<Rating>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.Entity<Purchase>()
            .HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.UserId)
            .IsRequired()
            .OnDelete(DeleteBehavior.Cascade);
        builder.Entity<Favorite>()
            .HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.UserId)
            .IsRequired()
            .OnDelete(DeleteBehavior.Cascade);
        builder.Entity<Rating>()
            .HasOne<ApplicationUser>()
            .WithMany()
            .HasForeignKey(x => x.UserId)
            .IsRequired()
            .OnDelete(DeleteBehavior.Cascade);
        builder.Entity<Purchase>().HasIndex(x => new { x.UserId, x.City }).IsUnique();
        builder.Entity<Favorite>().HasIndex(x => new { x.UserId, x.City, x.PlaceSlug }).IsUnique();
        builder.Entity<Rating>().HasIndex(x => new { x.UserId, x.City, x.PlaceSlug }).IsUnique();
        builder.Entity<Purchase>().Property(x => x.City).HasMaxLength(80);
        builder.Entity<Favorite>().Property(x => x.City).HasMaxLength(80);
        builder.Entity<Favorite>().Property(x => x.PlaceSlug).HasMaxLength(160);
        builder.Entity<Rating>().Property(x => x.City).HasMaxLength(80);
        builder.Entity<Rating>().Property(x => x.PlaceSlug).HasMaxLength(160);
        builder.Entity<Rating>().Property(x => x.Comment).HasMaxLength(2000);
        builder.Entity<Rating>().ToTable(table =>
            table.HasCheckConstraint("CK_Ratings_Stars", "Stars >= 1 AND Stars <= 5"));
    }
}

public sealed record CredentialsRequest([Required, EmailAddress] string Email, [Required] string Password);
public sealed record FavoriteRequest([Required] string City, [Required] string PlaceSlug);
public sealed record RatingRequest([Range(1, 5)] int Stars, string? Comment);

public sealed class CityGuide
{
    public required string City { get; init; }
    public required string Intro { get; init; }
    public required List<GuidePlace> Places { get; init; }
}

public sealed class GuidePlace
{
    public required string Slug { get; init; }
    public required string Name { get; init; }
    [JsonPropertyName("why_go")]
    public required string WhyGo { get; init; }
    public required string Description { get; init; }
    [JsonPropertyName("how_to_get_there")]
    public required string HowToGetThere { get; init; }
    public required string Cost { get; init; }
    [JsonPropertyName("booking_tip")]
    public required string BookingTip { get; init; }
    public decimal Lat { get; init; }
    public decimal Lng { get; init; }
    [JsonPropertyName("is_preview")]
    public bool IsPreview { get; init; }
}
