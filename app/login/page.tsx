import { redirect } from "next/navigation";
import { isAllowedOwnerEmail } from "@/lib/auth-config";
import { createSupabaseServerClient } from "@/lib/supabase-server";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const params = await searchParams;
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (user && isAllowedOwnerEmail(user.email)) redirect("/");

  return <main className="min-h-screen grid place-items-center bg-slate-950 p-6 text-slate-100"><section className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-8 shadow-xl"><p className="text-sm font-semibold text-cyan-400">PipelineCue</p><h1 className="mt-2 text-3xl font-semibold">Owner sign in</h1><p className="mt-3 text-slate-400">Enter the allowlisted owner email. We’ll send a secure magic link.</p>{params.sent && <p className="mt-5 rounded-lg bg-emerald-950 p-3 text-emerald-200">Check your inbox for the sign-in link.</p>}{params.error && <p className="mt-5 rounded-lg bg-rose-950 p-3 text-rose-200">Sign-in failed. Please request a new link.</p>}<form action="/api/auth/login" method="post" className="mt-6 space-y-4"><label className="block text-sm">Email<input name="email" type="email" required autoComplete="email" className="mt-2 w-full rounded-lg border border-slate-700 bg-slate-950 px-4 py-3" /></label><button className="w-full rounded-lg bg-cyan-500 px-4 py-3 font-semibold text-slate-950 hover:bg-cyan-400">Send magic link</button></form></section></main>;
}
