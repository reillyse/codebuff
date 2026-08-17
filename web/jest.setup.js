import '@testing-library/jest-dom'

// `common/src/env.ts` validates NEXT_PUBLIC_* at module load and throws a
// ZodError if any are missing, so importing almost any route handler fails
// outright when these are unset. Tests must not depend on real secrets, so seed
// the same placeholder defaults CI uses (see .github/workflows/notify-weft.yml).
//
// Only fills values that are not already set, so a real environment (or CI with
// actual secrets) still wins.
const testEnvDefaults = {
  NEXT_PUBLIC_CB_ENVIRONMENT: 'test',
  NEXT_PUBLIC_CODEBUFF_APP_URL: 'https://codebuff.com',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@codebuff.com',
  NEXT_PUBLIC_POSTHOG_API_KEY: 'placeholder',
  NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://app.posthog.com',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_placeholder',
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL: 'https://billing.stripe.com',
  NEXT_PUBLIC_WEB_PORT: '3000',
  NEXT_PUBLIC_INFISICAL_UP: 'true',

  // Server-side schema (packages/internal/src/env.ts) is validated at module
  // load too. These suites mock their DB and network dependencies, so the values
  // are never used — they only need to satisfy the schema. Deliberately obvious
  // placeholders so a real credential can never be mistaken for one of these.
  DATABASE_URL: 'postgres://placeholder:placeholder@localhost:5432/placeholder',
  PORT: '3000',
  NEXTAUTH_SECRET: 'placeholder-nextauth-secret',
  CODEBUFF_GITHUB_ID: 'placeholder',
  CODEBUFF_GITHUB_SECRET: 'placeholder',
  ANTHROPIC_API_KEY: 'placeholder',
  OPENAI_API_KEY: 'placeholder',
  OPEN_ROUTER_API_KEY: 'placeholder',
  GRAVITY_API_KEY: 'placeholder',
  LINKUP_API_KEY: 'placeholder',
  LOOPS_API_KEY: 'placeholder',
  DISCORD_APPLICATION_ID: 'placeholder',
  DISCORD_BOT_TOKEN: 'placeholder',
  DISCORD_PUBLIC_KEY: 'placeholder',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  STRIPE_WEBHOOK_SECRET_KEY: 'whsec_placeholder',
  STRIPE_SUBSCRIPTION_100_PRICE_ID: 'price_placeholder_100',
  STRIPE_SUBSCRIPTION_200_PRICE_ID: 'price_placeholder_200',
  STRIPE_SUBSCRIPTION_500_PRICE_ID: 'price_placeholder_500',
  STRIPE_TEAM_FEE_PRICE_ID: 'price_placeholder_team',
}

for (const [key, value] of Object.entries(testEnvDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value
  }
}
