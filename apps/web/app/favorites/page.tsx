"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, Favorite, Guide, isUnlocked, UnlockedPlace } from "../../lib/api";
type Saved = Favorite & { place?: UnlockedPlace };
export default function FavoritesPage() {
  const [saved, setSaved] = useState<Saved[]>([]); const [status, setStatus] = useState("Loading your saved places…");
  useEffect(() => { api<Favorite[]>("/favorites").then(async favorites => { const guides = await Promise.all([...new Set(favorites.map(f => f.city))].map(city => api<Guide>(`/guides/${encodeURIComponent(city)}`).catch(() => null))); setSaved(favorites.map(favorite => ({ ...favorite, place: guides.find(guide => guide?.city.toLowerCase() === favorite.city.toLowerCase())?.places.find(place => place.slug === favorite.placeSlug) as UnlockedPlace | undefined })).filter(item => item.place && isUnlocked(item.place))); setStatus(""); }).catch(() => setStatus("Sign in to see the places you’ve saved.")); }, []);
  async function remove(item: Saved) { await api(`/favorites/${item.id}`, { method: "DELETE" }); setSaved(list => list.filter(savedItem => savedItem.id !== item.id)); }
  return <main className="favorites-page"><section className="favorites-heading"><p className="eyebrow">Your collection</p><h1>Saved <em>somewhere</em>s.</h1><p>Every place that made you pause — gathered here for the next time you need an idea.</p></section>{status && <p className="empty-state">{status}</p>}{!status && saved.length === 0 && <div className="empty-state">Nothing saved yet. <Link href="/">Explore the city guides</Link> and bookmark the places that call to you.</div>}<div className="saved-grid">{saved.map(item => item.place && <article className="saved-card" key={item.id}><div><p className="eyebrow">{item.city}</p><h2>{item.place.name}</h2><p>{item.place.why_go}</p></div><div><Link href={`/guides/${item.city.toLowerCase()}`}>Open guide →</Link><button className="text-button" onClick={() => remove(item)}>Remove</button></div></article>)}</div></main>;
}
