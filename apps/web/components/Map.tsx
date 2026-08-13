"use client";
import { useEffect, useRef } from "react";
import type { UnlockedPlace } from "../lib/api";

export function Map({ places, city }: { places: UnlockedPlace[]; city: string }) {
  const element = useRef<HTMLDivElement>(null);
  useEffect(() => { let map: import("leaflet").Map | undefined; let disposed = false;
    (async () => { if (!element.current || places.length === 0) return; const L = await import("leaflet"); if (disposed || !element.current) return;
      map = L.map(element.current, { scrollWheelZoom: false }).setView([places[0].lat, places[0].lng], 13);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "© OpenStreetMap contributors" }).addTo(map);
      const bounds: [number, number][] = [];
      places.forEach((place, index) => { bounds.push([place.lat, place.lng]); L.marker([place.lat, place.lng]).addTo(map!).bindPopup(`<strong>${index + 1}. ${place.name}</strong><br/>${place.why_go}`); });
      if (bounds.length > 1) map.fitBounds(bounds, { padding: [36, 36] });
    })(); return () => { disposed = true; map?.remove(); };
  }, [places]);
  return <section className="map-section"><div className="eyebrow">The places you can see</div><h2>Pin your way through {city}</h2><p>Only places included in your current guide view appear on the map.</p><div ref={element} className="map" aria-label={`${city} map`} /></section>;
}
