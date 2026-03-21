import { el, formatTime } from "./components.js";

const BASE = "";

const TYPE_COLORS: Record<string, string> = {
  "baby.created": "#9c27b0",
  "baby.updated": "#ab47bc",
  "sleep.started": "#1565c0",
  "sleep.ended": "#1976d2",
  "sleep.updated": "#1e88e5",
  "sleep.manual": "#2196f3",
  "sleep.deleted": "#64b5f6",
  "sleep.tagged": "#42a5f5",
  "sleep.paused": "#90caf9",
  "sleep.resumed": "#bbdefb",
  "diaper.logged": "#2e7d32",
  "diaper.updated": "#43a047",
  "diaper.deleted": "#66bb6a",
  "day.started": "#ef6c00",
};

interface EventItem {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  client_id: string;
  client_event_id: string;
  timestamp: string;
  domain_id: string | null;
}

const PAGE_SIZE = 30;

export async function renderEventsScreen(container: HTMLElement): Promise<void> {
  container.innerHTML = "";
  const view = el("div", { className: "view" });

  // Check for domainId filter in hash params
  const hashParts = window.location.hash.split("?");
  const hashParams = new URLSearchParams(hashParts[1] || "");
  const domainIdParam = hashParams.get("domainId");

  const title = domainIdParam ? "Entitetshistorikk" : "Hendingslogg";
  const header = el("h2", { style: { padding: "16px 16px 0", margin: "0" } }, [title]);
  view.appendChild(header);

  // Filter dropdown
  let selectedType = "";
  const filterRow = el("div", { style: { padding: "8px 16px", display: "flex", gap: "8px" } });
  const typeSelect = el("select", {
    style: {
      flex: "1",
      padding: "8px",
      borderRadius: "8px",
      border: "1px solid var(--border)",
      background: "var(--surface)",
      color: "var(--text)",
      fontSize: "0.9rem",
    },
  }) as HTMLSelectElement;

  const defaultOpt = el("option", { value: "" }, ["Alle typar"]) as HTMLOptionElement;
  typeSelect.appendChild(defaultOpt);
  for (const t of Object.keys(TYPE_COLORS)) {
    const opt = el("option", { value: t }, [t]) as HTMLOptionElement;
    typeSelect.appendChild(opt);
  }
  typeSelect.addEventListener("change", () => {
    selectedType = typeSelect.value;
    loadEvents(true);
  });
  filterRow.appendChild(typeSelect);
  view.appendChild(filterRow);

  // Events list container
  const listEl = el("div", {
    style: { flex: "1", overflow: "auto", padding: "0 16px 16px" },
    "data-testid": "events-list",
  });
  view.appendChild(listEl);

  let offset = 0;
  let total = 0;

  async function loadEvents(reset = false) {
    if (reset) {
      offset = 0;
      listEl.innerHTML = "";
    }

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (selectedType) params.set("type", selectedType);
    if (domainIdParam) params.set("domainId", domainIdParam);

    const res = await fetch(`${BASE}/api/events?${params}`);
    const data = await res.json();
    total = data.total;
    const events: EventItem[] = data.events;

    for (const evt of events) {
      listEl.appendChild(renderEventCard(evt));
    }

    offset += events.length;

    // Remove old load-more button
    listEl.querySelector(".load-more-btn")?.remove();

    if (offset < total) {
      const loadMoreBtn = el("button", {
        className: "btn btn-ghost load-more-btn",
        style: { width: "100%", marginTop: "8px" },
      }, ["Last fleire..."]);
      loadMoreBtn.addEventListener("click", () => loadEvents());
      listEl.appendChild(loadMoreBtn);
    }
  }

  await loadEvents(true);
  container.appendChild(view);
}

function renderEventCard(evt: EventItem): HTMLElement {
  const color = TYPE_COLORS[evt.type] || "#666";

  const pill = el("span", {
    style: {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "12px",
      background: color,
      color: "#fff",
      fontSize: "0.75rem",
      fontWeight: "600",
    },
  }, [evt.type]);

  const time = el("span", {
    style: { color: "var(--text-light)", fontSize: "0.8rem" },
  }, [formatEventTime(evt.timestamp)]);

  const headerRow = el("div", {
    style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" },
  }, [pill, time]);

  const preview = el("div", {
    style: {
      fontSize: "0.8rem",
      color: "var(--text-light)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      marginTop: "4px",
    },
  }, [payloadPreview(evt.payload)]);

  const expandedPayload = el("pre", {
    style: {
      display: "none",
      fontSize: "0.75rem",
      background: "var(--bg)",
      padding: "8px",
      borderRadius: "8px",
      overflow: "auto",
      maxHeight: "200px",
      marginTop: "8px",
      whiteSpace: "pre-wrap",
      wordBreak: "break-all",
    },
  }, [JSON.stringify(evt.payload, null, 2)]);

  const card = el("div", {
    className: "event-card",
    "data-testid": "event-card",
    style: {
      padding: "10px 12px",
      marginBottom: "6px",
      background: "var(--surface)",
      borderRadius: "10px",
      cursor: "pointer",
      borderLeft: `3px solid ${color}`,
    },
  }, [headerRow, preview, expandedPayload]);

  card.addEventListener("click", () => {
    const isExpanded = expandedPayload.style.display !== "none";
    expandedPayload.style.display = isExpanded ? "none" : "block";
    preview.style.display = isExpanded ? "block" : "none";
  });

  return card;
}

function payloadPreview(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (k.endsWith("DomainId") || k === "clientId") continue;
    if (typeof v === "string" && v.length > 30) {
      parts.push(`${k}: ${v.slice(0, 20)}...`);
    } else {
      parts.push(`${k}: ${JSON.stringify(v)}`);
    }
  }
  return parts.join(", ") || "(empty)";
}

function formatEventTime(iso: string): string {
  try {
    const d = new Date(iso);
    const date = d.toLocaleDateString("nb-NO", { day: "numeric", month: "short" });
    const time = formatTime(iso);
    return `${date} ${time}`;
  } catch {
    return iso;
  }
}
