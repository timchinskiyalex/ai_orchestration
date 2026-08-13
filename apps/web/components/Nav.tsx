"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, User } from "../lib/api";

export function Nav() {
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => { api<User>("/auth/me").then(setUser).catch(() => setUser(null)); }, []);
  async function logout() { await api("/auth/logout", { method: "POST" }); setUser(null); window.location.href = "/"; }
  return <header className="nav"><Link className="brand" href="/">wander<span>well</span></Link><nav><Link href="/">Guides</Link>{user ? <><Link href="/favorites">Saved</Link><button className="nav-button" onClick={logout}>Sign out</button></> : <><Link href="/login">Sign in</Link><Link className="nav-cta" href="/register">Join the club</Link></>}</nav></header>;
}
