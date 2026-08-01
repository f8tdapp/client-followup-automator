This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Owner authentication

PipelineCue currently has one shared account. It is **not multi-tenant**: every
private read and mutation is authorized on the server against the verified
Supabase Auth user and the `PIPELINECUE_ALLOWED_EMAILS` allowlist. A future
account-ownership schema must replace this boundary before supporting multiple
customers.

Configure the variables listed in `.env.example`:

- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` support
  Supabase Auth. The anon key has no direct application-table privileges after
  Migration 011.
- `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never expose it through a
  `NEXT_PUBLIC_` variable.
- `PIPELINECUE_ALLOWED_EMAILS` must contain the real owner email (or a
  comma-separated transition list). Comparisons are trimmed and
  case-normalized.
- `PIPELINECUE_APP_URL` must be the deployment HTTPS origin with no path,
  query, fragment, or credentials. Localhost HTTP is accepted in development.
- `HUBSPOT_TOKEN_ENCRYPTION_KEY` must be exactly 32 random bytes encoded as
  base64 and must remain server-only. OAuth tokens use versioned AES-256-GCM
  envelopes. Existing unversioned plaintext development rows are rejected and
  require HubSpot reauthorization; they are never silently reinterpreted.

Enable email magic links, create the allowlisted Supabase user, and allow the
deployed `${PIPELINECUE_APP_URL}/auth/callback` URL in Supabase Auth. HubSpot separately requires
`HUBSPOT_REDIRECT_URI` ending in `/api/hubspot/callback`; the connect flow and
callback require the same verified owner session, and the callback also checks
its short-lived state cookie.

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
