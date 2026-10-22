import { entitlementsClient } from "@byo-oss/entitlements/client";
import { createAuthClient } from "better-auth/react";

// Setup step 4: the client plugin.
export const authClient = createAuthClient({
  plugins: [entitlementsClient()],
});
