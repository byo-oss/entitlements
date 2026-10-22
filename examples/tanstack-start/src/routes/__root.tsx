/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useNavigate,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { authClient } from "../lib/auth-client";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "@byo-oss/entitlements × TanStack Start" },
    ],
  }),
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  const navigate = useNavigate();
  const { data: session } = authClient.useSession();

  return (
    <>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          padding: "12px 24px",
          borderBottom: "1px solid #e5e5e5",
        }}
      >
        <strong>@byo-oss/entitlements × TanStack Start</strong>
        <nav style={{ display: "flex", gap: 12 }}>
          <Link to="/">Home</Link>
          <Link to="/plan">Plan</Link>
          <Link to="/staff">Staff</Link>
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", gap: 12 }}>
          {session ? (
            <>
              <span data-testid="whoami">{session.user.email}</span>
              <button
                type="button"
                onClick={async () => {
                  await authClient.signOut();
                  await navigate({ to: "/" });
                }}
              >
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </header>
      <main style={{ padding: 24 }}>
        <Outlet />
      </main>
    </>
  );
}
