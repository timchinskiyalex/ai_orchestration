import type { Metadata } from "next";
import "./globals.css";
import "./card-media.css";
import { Nav } from "../components/Nav";

export const metadata: Metadata = { title: "Wanderwell | City guides", description: "Thoughtful city guides for Madrid and Paris." };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><Nav />{children}</body></html>;
}
