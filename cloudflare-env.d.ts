declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    // Secrets and settings of DOT Viagens (see MECANICA_DO_SISTEMA.txt, section 10).
    SERPAPI_KEY?: string;
    SUPABASE_URL?: string;
    SUPABASE_SECRET_KEY?: string;
    SUPABASE_SERVICE_ROLE_KEY?: string;
    NSANGU_API_KEY?: string;
    NSANGU_BASE_URL?: string;
    WIPAY_BASE_URL?: string;
    WIPAY_CLIENT_ID?: string;
    WIPAY_CLIENT_SECRET?: string;
    WIPAY_WEBHOOK_SECRET?: string;
    VERO_API_KEY?: string;
    VERO_ORG_ID?: string;
    AUTH_SECRET?: string;
    OFFER_SECRET?: string;
    CRON_SECRET?: string;
    ADMIN_PHONES?: string;
    PUBLIC_BASE_URL?: string;
    OTP_HOURLY_LIMIT?: string;
  }
}
