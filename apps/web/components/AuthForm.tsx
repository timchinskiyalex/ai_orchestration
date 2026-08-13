"use client";
import Link from "next/link";
import { FormEvent, useState } from "react";
import { api, User } from "../lib/api";
export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const [message, setMessage] = useState(""); const [pending, setPending] = useState(false); const isLogin = mode === "login";
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setPending(true); setMessage(""); const data = new FormData(event.currentTarget); try { await api<User>(`/auth/${mode}`, { method: "POST", body: JSON.stringify({ email: data.get("email"), password: data.get("password") }) }); window.location.href = "/"; } catch (error) { setMessage(error instanceof Error ? error.message : "Unable to continue."); } finally { setPending(false); } }
  return <main className="auth-page"><div className="auth-image" /><form className="auth-card" onSubmit={submit}><p className="eyebrow">Wanderwell account</p><h1>{isLogin ? "Welcome back." : "Start somewhere beautiful."}</h1><p>{isLogin ? "Sign in to unlock your guides and keep your favorite finds." : "Create an account to collect places and unlock city guides."}</p><label>Email<input type="email" name="email" autoComplete="email" required /></label><label>Password<input type="password" name="password" autoComplete={isLogin ? "current-password" : "new-password"} minLength={8} required /></label>{message && <p className="form-error">{message}</p>}<button className="button button-dark" disabled={pending}>{pending ? "One moment…" : isLogin ? "Sign in" : "Create account"}</button><p className="auth-switch">{isLogin ? "New here?" : "Already a member?"} <Link href={isLogin ? "/register" : "/login"}>{isLogin ? "Create an account" : "Sign in"}</Link></p></form></main>;
}
