/**
 * Environment variable defaults for cli-lite.
 *
 * This file MUST have zero imports so that when it is the first `import` in
 * index.ts it is evaluated before any SDK / common code that eagerly validates
 * the NEXT_PUBLIC_* variables.
 *
 * Bun auto-loads .env.development.local which may override NEXT_PUBLIC_* vars
 * with local dev values (e.g. localhost URLs). We force-set critical vars so
 * cli-lite always talks to the production API, while allowing an explicit
 * CODEBUFF_LITE_APP_URL override for testing.
 */

// Force-set the app URL to production. Bun's .env loading can set this to
// localhost which breaks cli-lite. Allow explicit override via CODEBUFF_LITE_APP_URL.
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL =
  process.env.CODEBUFF_LITE_APP_URL ?? 'https://www.codebuff.com'

const envDefaults: Record<string, string> = {
  NEXT_PUBLIC_CB_ENVIRONMENT: 'prod',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@codebuff.com',
  NEXT_PUBLIC_POSTHOG_API_KEY: 'cli-lite',
  NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://us.i.posthog.com',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'cli-lite',
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL: 'https://billing.stripe.com/p/login/placeholder',
  NEXT_PUBLIC_WEB_PORT: '3000',
}
for (const [key, value] of Object.entries(envDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value
  }
}
