export type GuideSummary = { city: string; intro: string; price: number; purchased: boolean };
export type LockedPlace = { slug: string; name: string; why_go: string; locked: true };
export type UnlockedPlace = { slug: string; name: string; why_go: string; description: string; how_to_get_there: string; cost: string; booking_tip: string; lat: number; lng: number; is_preview: boolean; locked?: false };
export type Place = LockedPlace | UnlockedPlace;
export type Guide = { city: string; intro: string; price: number; purchased: boolean; places: Place[] };
export type Favorite = { id: number; city: string; placeSlug: string; createdAt: string };
export type User = { email: string };

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:5055/api";
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...init.headers } });
  if (!response.ok) { const body = await response.text(); throw new Error(response.status === 401 ? "Please sign in to continue." : body || "Something went wrong."); }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export const isUnlocked = (place: Place): place is UnlockedPlace => !place.locked && typeof (place as UnlockedPlace).description === "string" && Number.isFinite((place as UnlockedPlace).lat) && Number.isFinite((place as UnlockedPlace).lng);
export const citySlug = (city: string) => city.toLowerCase();
export const photoFor = (city: string, slug?: string) => `https://images.unsplash.com/photo-${city.toLowerCase() === "paris" ? "1502602898657-3e91760cbb34" : "1539037116277-4db20889f2d4"}?auto=format&fit=crop&w=1200&q=85${slug ? `&sig=${slug.length}` : ""}`;
