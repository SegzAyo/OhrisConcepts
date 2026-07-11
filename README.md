# Ohris Concepts

The Ohris Concepts landing page is a static site with a small Vercel Function for the contact form. Contact submissions are stored in Supabase Postgres; the database credential is only read on the server.

## Local setup

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env.local`.
3. Replace `YOUR_URL_ENCODED_PASSWORD` in `.env.local` with the URL-encoded Supabase database password.
4. Start the site with `npx vercel dev`.

Never put `DATABASE_URL` in `index.html`, browser JavaScript, or any variable prefixed with `PUBLIC_`, `VITE_`, or `NEXT_PUBLIC_`.

The API creates `public.contact_submissions` on its first successful connection. The equivalent SQL is also tracked in `supabase/migrations/` for explicit database migrations. Row-level security is enabled and the browser-facing Supabase roles receive no table access.

## Deploy to Vercel

Use these project settings:

- Root Directory: repository root
- Framework Preset: Other
- Build Command: leave empty
- Output Directory: leave empty

Then open **Project Settings → Environment Variables** and add `DATABASE_URL` for Production (and Preview if you want preview forms to work). Redeploy after adding or changing it; environment changes do not affect an existing deployment.

For Vercel Functions, use the Supabase **Transaction pooler** connection string on port `6543`. The supplied port `5432` URL is the session pooler and can work, but it is intended for longer-lived clients. Retrieve the transaction-mode URL from **Supabase → Connect**, insert the real password there, and save the completed value directly in Vercel.

Database traffic always uses TLS. By default the connection uses `sslmode=require`, which encrypts traffic without validating the pooler's certificate chain. For full `verify-full` validation, download the project CA certificate from **Supabase → Database Settings → SSL Configuration** and add its PEM value as `DATABASE_CA_CERT` in Vercel.

## Verification

Run all local checks:

```sh
npm run check
```

After deployment, submit the form or call the endpoint directly:

```sh
curl -i https://YOUR_DOMAIN/api/contact \
  -H 'Content-Type: application/json' \
  --data '{"email":"you@example.com"}'
```
