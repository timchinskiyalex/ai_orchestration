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
const cityPhotos: Record<string, string> = { paris: "1502602898657-3e91760cbb34", madrid: "1539037116277-4db20889f2d4" };

// Individual Unsplash photos keep each guide card tied to its own place.
const placePhotos: Record<string, string> = {
  "paris/eiffel-tower": "1502602898657-3e91760cbb34", "paris/musee-du-louvre": "1499856871958-5b9627545d1a", "paris/montmartre-and-sacre-coeur": "1500916434205-0c77489c6cf7", "paris/musee-dorsay": "1508050919630-b135583b29ab", "paris/notre-dame-de-paris": "1471623432079-b009d30b9c3e", "paris/sainte-chapelle": "1520939817895-060bdaf4fe1b", "paris/arc-de-triomphe": "1549144511-f099e773c147", "paris/jardin-du-luxembourg": "1500534623283-312aade485b7", "paris/le-marais": "1500315331616-db4f707c902a", "paris/centre-pompidou": "1550340499-a6c60fc8287c", "paris/canal-saint-martin": "1501339847302-ac426a4a7cbb", "paris/marche-des-enfants-rouges": "1542838132-92c53300491e", "paris/pantheon": "1500534314209-a25ddb2bd429", "paris/palais-garnier": "1522083165195-3424ed129620", "paris/seine-river-walk": "1657695065418-f5eacaa15f20",
  "madrid/museo-del-prado": "1543783207-ec64e4d95325", "madrid/palacio-real-de-madrid": "1539037116277-4db20889f2d4", "madrid/parque-del-retiro": "1523531294919-4bcd7c65e216", "madrid/museo-reina-sofia": "1551163943-3f6a855d1153", "madrid/museo-thyssen-bornemisza": "1564399579883-451a5d44ec08", "madrid/mercado-de-san-miguel": "1550989460-0adf9ea622e2", "madrid/plaza-mayor": "1720344083161-52d34dc47642", "madrid/templo-de-debod": "1529260830199-42c24126f198", "madrid/gran-via": "1551792343-d9c6f7255970", "madrid/puerta-del-sol": "1539635278303-d4002c07eae3", "madrid/matadero-madrid": "1519608487953-e999c86e7454", "madrid/barrio-de-las-letras": "1513026705753-bc3fffca8bf4", "madrid/mercado-de-san-anton": "1550966871-3ed3cdb5ed0c", "madrid/estadio-santiago-bernabeu": "1574629810360-7efbbe195018", "madrid/lavapies": "1487958449943-2429e8be8625"
};

export const photoFor = (city: string, slug?: string) => {
  const cityKey = city.toLowerCase();
  const photo = slug ? placePhotos[`${cityKey}/${slug}`] : cityPhotos[cityKey];
  return `https://images.unsplash.com/photo-${photo ?? cityPhotos.paris}?auto=format&fit=crop&w=1200&q=85`;
};
