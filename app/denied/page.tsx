export default function DeniedPage() {
  return <main className="min-h-screen grid place-items-center bg-slate-950 p-6 text-slate-100"><section className="max-w-md rounded-2xl border border-rose-900 bg-slate-900 p-8"><h1 className="text-3xl font-semibold">Access denied</h1><p className="mt-3 text-slate-300">You are signed in, but this email is not on the PipelineCue owner allowlist.</p><form action="/api/auth/logout" method="post" className="mt-6"><button className="rounded-lg border border-slate-600 px-4 py-2">Sign out</button></form></section></main>;
}
