import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@fontsource-variable/geist/wght.css";
import { App } from "./App";
import "./styles.css";

const isOverlay = new URLSearchParams(window.location.search).get("overlay") === "1";

if (isOverlay) {
  // An OBS browser source needs genuine transparency. The fragment credential is
  // intentionally handled by OverlayApp, never by this entry point or a router.
  document.documentElement.classList.add("overlay-page");
  document.body.classList.add("overlay-page");
}

const root = document.getElementById("root");
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 5_000,
      refetchOnWindowFocus: false
    }
  }
});

if (!root) {
  throw new Error("Backseat could not find its application root.");
}

createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
