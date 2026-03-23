import { getState, setMutationHook, type AppState } from "./api.js";
import {
  flushQueue,
  cacheState,
  getCachedState,
  connectSSE,
  markLocalMutation,
  applyQueuedEvents,
  hasPendingEvents,
} from "./sync.js";
import { injectStyles } from "./ui/styles.js";
import { renderDashboard, cleanupDashboard } from "./ui/dashboard.js";
import { renderHistory } from "./ui/history.js";
import { renderSettings } from "./ui/settings.js";
import { renderStats } from "./ui/stats.js";
import { renderEventsScreen } from "./ui/events.js";
import { el } from "./ui/components.js";

let currentState: AppState | null = null;

export function getAppState(): AppState | null {
  return currentState;
}

export function setAppState(state: AppState): void {
  currentState = state;
  cacheState(state);
}

export async function refreshState(): Promise<AppState | null> {
  try {
    await flushQueue();
    currentState = await getState();
    cacheState(currentState);
    return currentState;
  } catch {
    currentState = getCachedState();
    // Apply any queued events to cached state so offline changes are reflected
    if (currentState && hasPendingEvents()) {
      currentState = applyQueuedEvents(currentState);
    }
    return currentState;
  }
}

export function navigateTo(hash: string): void {
  window.location.hash = hash;
}

async function main() {
  setMutationHook(markLocalMutation);
  injectStyles();

  const app = document.getElementById("app")!;
  const content = el("div", {
    id: "content",
    style: { flex: "1", overflow: "hidden", display: "flex", flexDirection: "column" },
  });
  app.appendChild(content);

  // Bottom nav
  const nav = el("nav", { className: "nav-bar" });
  const tabs = [
    { icon: "🏠", label: "Heim", hash: "#/" },
    { icon: "📋", label: "Logg", hash: "#/history" },
    { icon: "📊", label: "Statistikk", hash: "#/stats" },
    { icon: "⚙️", label: "Innstillingar", hash: "#/settings" },
  ];
  const tabButtons: HTMLButtonElement[] = [];
  for (const tab of tabs) {
    const btn = el("button", { className: "nav-tab" }, [
      el("span", { className: "nav-icon" }, [tab.icon]),
      el("span", null, [tab.label]),
    ]);
    btn.addEventListener("click", () => {
      window.location.hash = tab.hash;
    });
    tabButtons.push(btn);
    nav.appendChild(btn);
  }
  // Sync indicator dot (subtle, inside the nav)
  const syncDot = el("span", { id: "sync-dot" });
  Object.assign(syncDot.style, {
    width: "6px",
    height: "6px",
    borderRadius: "50%",
    background: "var(--success)",
    position: "absolute",
    top: "8px",
    right: "8px",
    opacity: "0.6",
  });
  nav.style.position = "relative";
  nav.appendChild(syncDot);
  app.appendChild(nav);

  // Initial load
  await refreshState();

  let routeSeq = 0;

  async function route() {
    const seq = ++routeSeq;
    cleanupDashboard(); // Stop any running timers/intervals from dashboard
    const hash = window.location.hash || "#/";
    if (!currentState?.baby && hash !== "#/settings") {
      window.location.hash = "#/settings";
      return;
    }
    tabButtons.forEach((btn, i) => {
      btn.classList.toggle("active", hash === tabs[i].hash);
    });

    const hashBase = hash.split("?")[0];
    switch (hashBase) {
      case "#/history":
        await renderHistory(content);
        break;
      case "#/stats":
        await renderStats(content);
        break;
      case "#/settings":
        renderSettings(content, { onboarding: !currentState?.baby });
        break;
      case "#/events":
        await renderEventsScreen(content);
        break;
      default:
        renderDashboard(content);
    }

    // Only animate if this is still the latest route
    if (seq === routeSeq) {
      content.classList.remove("view-fade-in");
      // Force reflow to restart animation
      void content.offsetWidth;
      content.classList.add("view-fade-in");
    }
  }

  window.addEventListener("hashchange", route);
  route();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }

  // Real-time sync via SSE — only re-render dashboard (the live view).
  // History and stats fetch their own data, so re-rendering them on every SSE update
  // would cause unnecessary refetches and disrupt scroll position / modal state.
  connectSSE((state) => {
    // Reapply any queued offline events on top of server state so optimistic
    // changes (e.g. an in-progress nap started while offline) aren't lost.
    const effective = hasPendingEvents() ? applyQueuedEvents(state) : state;
    setAppState(effective);
    const hash = window.location.hash || "#/";
    if (hash === "#/" || hash === "") {
      renderDashboard(content);
    }
    // Other routes will pick up the new state when navigated to
  });

  // When connectivity returns, flush queued offline events to the server.
  window.addEventListener("online", async () => {
    const result = await flushQueue();
    if (result) {
      setAppState(result.state);
      const hash = window.location.hash || "#/";
      if (hash === "#/" || hash === "") {
        renderDashboard(content);
      }
    }
  });
}

main().catch(console.error);
