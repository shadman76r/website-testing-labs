import { cookies } from "next/headers";
import { AppShell } from "@/components/app-shell";
import { LoginScreen } from "@/components/login-screen";
import { isAuthenticatedToken, isPasswordConfigured, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieStore = await cookies();
  const localBypass = process.env.NODE_ENV !== "production" && !isPasswordConfigured();
  const authenticated = localBypass || isAuthenticatedToken(cookieStore.get(SESSION_COOKIE)?.value);

  if (!authenticated) return <LoginScreen passwordConfigured={isPasswordConfigured()} production={process.env.NODE_ENV === "production"} />;
  return <AppShell />;
}
