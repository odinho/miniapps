import { getSleeps, getDiapers, postEvents } from "../api.js";
import { getClientId } from "../sync.js";
import { refreshState } from "../main.js";
import { el, formatDuration, formatTime } from "./components.js";
import { showConfirm } from "./toast.js";
import {
  MOODS,
  METHODS,
  MOOD_EMOJI,
  METHOD_EMOJI,
  FALL_ASLEEP_LABELS,
} from "../constants.js";
import { toLocal, toLocalDate } from "../utils.js";
import type { SleepLogRow, SleepPauseRow, DiaperLogRow } from "../../types.js";
const DIAPER_ICONS: Record<string, string> = {
  wet: "💧",
  dirty: "💩",
  both: "💧💩",
  dry: "✨",
  potty_wet: "🚽",
  potty_dirty: "🚽",
  potty_nothing: "🚽",
  diaper_only: "🧷",
};
const DIAPER_LABELS: Record<string, string> = {
  wet: "Våt",
  dirty: "Skitten",
  both: "Våt + skitten",
  dry: "Tørr",
  potty_wet: "Tiss på do",
  potty_dirty: "Bæsj på do",
  potty_nothing: "Ingenting på do",
  diaper_only: "Berre bleie",
};
const DIAPER_STATUS_LABELS: Record<string, string> = {
  dry: "Tørr bleie",
  damp: "Litt våt bleie",
  wet: "Våt bleie",
};

type HistoryEntry =
  | (SleepLogRow & { _kind: "sleep"; _sortTime: string })
  | (DiaperLogRow & { _kind: "diaper"; _sortTime: string });

export async function renderHistory(container: HTMLElement): Promise<void> {
  container.innerHTML = "";
  const view = el("div", { className: "view" });
  const [sleeps, diapers] = await Promise.all([
    getSleeps({ limit: 50 }),
    getDiapers({ limit: 50 }),
  ]);

  // Merge into unified list with sortTime
  const entries: HistoryEntry[] = [
    ...sleeps.map((s) => ({ ...s, _kind: "sleep" as const, _sortTime: s.start_time })),
    ...diapers.map((d) => ({ ...d, _kind: "diaper" as const, _sortTime: d.time })),
  ];
  entries.sort((a, b) => new Date(b._sortTime).getTime() - new Date(a._sortTime).getTime());

  view.appendChild(el("h2", { className: "history-header" }, ["Logg"]));

  if (entries.length === 0) {
    view.appendChild(
      el("div", { className: "history-empty" }, [
        el("div", { style: { fontSize: "3rem", marginBottom: "16px" } }, ["📋"]),
        el("div", null, ["Ingen oppføringar enno"]),
        el("div", { style: { fontSize: "0.9rem", marginTop: "8px" } }, [
          "Trykk på søvnknappen på heimeskjermen for å starta",
        ]),
      ]),
    );
    container.appendChild(view);
    return;
  }

  const todayLocal = toLocalDate(new Date().toISOString());

  const grouped = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const date = toLocalDate(e._sortTime);
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date)!.push(e);
  }

  const log = el("div", { className: "sleep-log" });

  for (const [date, dayEntries] of grouped) {
    const d = new Date(date + "T12:00:00");
    const isToday = date === todayLocal;
    const yesterdayLocal = (() => {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      return toLocalDate(y.toISOString());
    })();
    const isYesterday = date === yesterdayLocal;
    const label = isToday
      ? "I dag"
      : isYesterday
        ? "I går"
        : d.toLocaleDateString("nb-NO", { weekday: "short", month: "short", day: "numeric" });

    log.appendChild(
      el(
        "div",
        {
          style: {
            fontSize: "0.8rem",
            color: "var(--text-light)",
            padding: "8px 4px 4px",
            fontWeight: "600",
            textTransform: "uppercase",
            letterSpacing: "0.03em",
          },
        },
        [label],
      ),
    );

    for (const entry of dayEntries) {
      if (entry._kind === "sleep") {
        let durationMs = entry.end_time
          ? new Date(entry.end_time).getTime() - new Date(entry.start_time).getTime()
          : 0;
        if (entry.pauses?.length) {
          for (const p of entry.pauses) {
            const ps = new Date(p.pause_time).getTime();
            const pe = p.resume_time
              ? new Date(p.resume_time).getTime()
              : entry.end_time
                ? new Date(entry.end_time).getTime()
                : Date.now();
            durationMs -= pe - ps;
          }
        }
        const duration = entry.end_time ? formatDuration(Math.max(0, durationMs)) : "ongoing…";
        const icon = entry.type === "night" ? "🌙" : "😴";
        const times = `${formatTime(entry.start_time)} — ${entry.end_time ? formatTime(entry.end_time) : "no"}`;

        const entryPauses: SleepPauseRow[] = entry.pauses || [];
        const metaChildren: (Node | string)[] = [entry.type === "night" ? "Nattesøvn" : "Lur"];
        if (entryPauses.length > 0) {
          let totalPauseMs = 0;
          for (const p of entryPauses) {
            const ps = new Date(p.pause_time).getTime();
            const pe = p.resume_time
              ? new Date(p.resume_time).getTime()
              : entry.end_time
                ? new Date(entry.end_time).getTime()
                : Date.now();
            totalPauseMs += pe - ps;
          }
          const pauseMin = Math.floor(totalPauseMs / 60000);
          metaChildren.push(
            ` · ${entryPauses.length} pause${entryPauses.length > 1 ? "r" : ""} (${pauseMin}m)`,
          );
        }
        if (entry.mood || entry.method) {
          const badges: (Node | string)[] = [];
          if (entry.mood && MOOD_EMOJI[entry.mood])
            badges.push(el("span", { className: "tag-badge" }, [MOOD_EMOJI[entry.mood]]));
          if (entry.method && METHOD_EMOJI[entry.method])
            badges.push(el("span", { className: "tag-badge" }, [METHOD_EMOJI[entry.method]]));
          metaChildren.push(el("span", { className: "tag-badges" }, badges));
        }
        if (entry.fall_asleep_time) {
          metaChildren.push(
            ` · ⏱️ ${FALL_ASLEEP_LABELS[entry.fall_asleep_time] || entry.fall_asleep_time}`,
          );
        }
        if (entry.woke_by) {
          metaChildren.push(` · ${entry.woke_by === "self" ? "Vakna sjølv" : "Vekt av oss"}`);
        }

        const infoChildren: (Node | string)[] = [
          el("div", { className: "log-times" }, [times]),
          el("div", { className: "log-meta" }, metaChildren),
        ];
        if (entry.notes) {
          infoChildren.push(
            el("div", { className: "log-meta", style: { fontStyle: "italic" } }, [entry.notes]),
          );
        }
        if (entry.wake_notes) {
          infoChildren.push(
            el("div", { className: "log-meta", style: { fontStyle: "italic" } }, [
              `Oppvakning: ${entry.wake_notes}`,
            ]),
          );
        }

        const item = el("div", { className: "sleep-log-item" }, [
          el("span", { className: "log-icon" }, [icon]),
          el("div", { className: "log-info" }, infoChildren),
          el("span", { className: "log-duration" }, [duration]),
        ]);
        item.addEventListener("click", () => showEditModal(entry, container));
        log.appendChild(item);
      } else {
        const icon = DIAPER_ICONS[entry.type] || "💩";
        const isPotty = entry.type.startsWith("potty_") || entry.type === "diaper_only";
        const metaParts = [DIAPER_LABELS[entry.type] || entry.type];
        if (isPotty && entry.amount && DIAPER_STATUS_LABELS[entry.amount]) {
          metaParts.push(DIAPER_STATUS_LABELS[entry.amount]);
        } else if (!isPotty && entry.amount) {
          metaParts.push(entry.amount);
        }
        const meta = metaParts.join(" · ");
        const categoryLabel = isPotty ? "Do" : "Bleie";

        const item = el("div", { className: "sleep-log-item diaper-log-item" }, [
          el("span", { className: "log-icon" }, [icon]),
          el("div", { className: "log-info" }, [
            el("div", { className: "log-times" }, [formatTime(entry.time)]),
            el("div", { className: "log-meta" }, [meta]),
          ]),
          el("span", { className: "log-duration" }, [categoryLabel]),
        ]);
        item.addEventListener("click", () => showDiaperEditModal(entry, container));
        log.appendChild(item);
      }
    }
  }

  view.appendChild(log);
  container.appendChild(view);
}

export function showEditModal(entry: SleepLogRow, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal" });

  const startDateInput = el("input", {
    type: "date",
    value: toLocal(entry.start_time).slice(0, 10),
  }) as HTMLInputElement;
  const startTimeInput = el("input", {
    type: "time",
    value: toLocal(entry.start_time).slice(11, 16),
  }) as HTMLInputElement;
  const endDateInput = el("input", {
    type: "date",
    value: entry.end_time ? toLocal(entry.end_time).slice(0, 10) : "",
  }) as HTMLInputElement;
  const endTimeInput = el("input", {
    type: "time",
    value: entry.end_time ? toLocal(entry.end_time).slice(11, 16) : "",
  }) as HTMLInputElement;

  let selectedType = entry.type;
  const napPill = el(
    "button",
    { className: `type-pill ${selectedType === "nap" ? "active" : ""}` },
    ["😴 Lur"],
  );
  const nightPill = el(
    "button",
    { className: `type-pill ${selectedType === "night" ? "active" : ""}` },
    ["🌙 Natt"],
  );

  const updatePills = () => {
    napPill.className = `type-pill ${selectedType === "nap" ? "active" : ""}`;
    nightPill.className = `type-pill ${selectedType === "night" ? "active" : ""}`;
  };
  napPill.addEventListener("click", () => {
    selectedType = "nap";
    updatePills();
  });
  nightPill.addEventListener("click", () => {
    selectedType = "night";
    updatePills();
  });

  // Mood pills
  let selectedMood: string | null = entry.mood || null;
  const moodPills = MOODS.map((m) => {
    const pill = el(
      "button",
      { className: `tag-pill ${selectedMood === m.value ? "active" : ""}`, "data-mood": m.value },
      [
        el("span", { className: "tag-emoji" }, [m.label]),
        el("span", { className: "tag-label" }, [m.title]),
      ],
    );
    pill.addEventListener("click", () => {
      selectedMood = selectedMood === m.value ? null : m.value;
      moodPills.forEach((p) =>
        p.classList.toggle("active", p.getAttribute("data-mood") === selectedMood),
      );
    });
    return pill;
  });

  // Method pills
  let selectedMethod: string | null = entry.method || null;
  const methodPills = METHODS.map((m) => {
    const pill = el(
      "button",
      {
        className: `tag-pill ${selectedMethod === m.value ? "active" : ""}`,
        "data-method": m.value,
      },
      [
        el("span", { className: "tag-emoji" }, [m.label]),
        el("span", { className: "tag-label" }, [m.title]),
      ],
    );
    pill.addEventListener("click", () => {
      selectedMethod = selectedMethod === m.value ? null : m.value;
      methodPills.forEach((p) =>
        p.classList.toggle("active", p.getAttribute("data-method") === selectedMethod),
      );
    });
    return pill;
  });

  // Fall-asleep time
  let selectedFallAsleep: string | null = entry.fall_asleep_time || null;
  const FALL_ASLEEP = [
    { value: "<5", label: "< 5 min" },
    { value: "5-15", label: "5–15 min" },
    { value: "15-30", label: "15–30 min" },
    { value: "30+", label: "30+ min" },
  ] as const;
  const fallAsleepPills = FALL_ASLEEP.map((b) => {
    const pill = el(
      "button",
      {
        className: `type-pill ${selectedFallAsleep === b.value ? "active" : ""}`,
        "data-fall-asleep": b.value,
      },
      [b.label],
    );
    pill.addEventListener("click", () => {
      selectedFallAsleep = selectedFallAsleep === b.value ? null : b.value;
      fallAsleepPills.forEach(
        (p, i) =>
          (p.className = `type-pill ${selectedFallAsleep === FALL_ASLEEP[i].value ? "active" : ""}`),
      );
    });
    return pill;
  });

  // Notes
  const noteInput = el("input", {
    type: "text",
    placeholder: "Valfritt notat...",
    value: entry.notes || "",
  }) as HTMLInputElement;

  modal.appendChild(el("h2", null, ["Endra søvn"]));
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Type"]),
      el("div", { className: "type-pills" }, [napPill, nightPill]),
    ]),
  );
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Start"]),
      el("div", { className: "datetime-row" }, [startDateInput, startTimeInput]),
    ]),
  );
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Slutt"]),
      el("div", { className: "datetime-row" }, [endDateInput, endTimeInput]),
    ]),
  );
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Humør ved legging"]),
      el("div", { className: "tag-pills" }, moodPills),
    ]),
  );
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Metode"]),
      el("div", { className: "tag-pills" }, methodPills),
    ]),
  );
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Innsovningstid"]),
      el("div", { className: "type-pills" }, fallAsleepPills),
    ]),
  );
  modal.appendChild(
    el("div", { className: "form-group" }, [el("label", null, ["Notat"]), noteInput]),
  );

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Lagra"]);
  const deleteBtn = el("button", { className: "btn btn-danger" }, ["Slett"]);
  const cancelBtn = el("button", { className: "btn btn-ghost" }, ["Avbryt"]);

  saveBtn.addEventListener("click", async () => {
    await postEvents([
      {
        type: "sleep.updated",
        payload: {
          sleepId: entry.id,
          startTime: new Date(`${startDateInput.value}T${startTimeInput.value}`).toISOString(),
          endTime:
            endDateInput.value && endTimeInput.value
              ? new Date(`${endDateInput.value}T${endTimeInput.value}`).toISOString()
              : undefined,
          type: selectedType,
          mood: selectedMood,
          method: selectedMethod,
          fallAsleepTime: selectedFallAsleep,
          notes: noteInput.value.trim() || undefined,
        },
        clientId: getClientId(),
      },
    ]);
    close();
    await refreshState();
    renderHistory(container);
  });

  deleteBtn.addEventListener("click", async () => {
    const confirmed = await showConfirm(
      "Sletta denne søvnoppføringa? Dette kan ikkje angrast.",
      "Slett",
      "Avbryt",
    );
    if (confirmed) {
      await postEvents([
        { type: "sleep.deleted", payload: { sleepId: entry.id }, clientId: getClientId() },
      ]);
      close();
      await refreshState();
      renderHistory(container);
    }
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", escHandler);

  modal.appendChild(el("div", { className: "btn-row" }, [deleteBtn, saveBtn]));
  modal.appendChild(el("div", { style: { textAlign: "center", marginTop: "12px" } }, [cancelBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", escHandler);
  }
}

function showDiaperEditModal(entry: DiaperLogRow, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal" });

  modal.appendChild(el("h2", null, ["Bleiedetaljar"]));

  // Editable type pills
  let selectedType = entry.type;
  const types = [
    { value: "wet", label: "💧 Våt" },
    { value: "dirty", label: "💩 Skitten" },
    { value: "both", label: "💧💩 Begge" },
    { value: "dry", label: "✨ Tørr" },
  ];
  const typePills = types.map((t) => {
    const pill = el(
      "button",
      {
        className: `type-pill ${selectedType === t.value ? "active" : ""}`,
        "data-diaper-type": t.value,
      },
      [t.label],
    );
    pill.addEventListener("click", () => {
      selectedType = t.value;
      typePills.forEach((p, i) => {
        p.className = `type-pill ${selectedType === types[i].value ? "active" : ""}`;
      });
    });
    return pill;
  });
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Type"]),
      el("div", { className: "type-pills diaper-type-pills" }, typePills),
    ]),
  );

  // Amount
  let selectedAmount = entry.amount || "middels";
  const amounts = [
    { value: "lite", label: "Lite" },
    { value: "middels", label: "Middels" },
    { value: "mykje", label: "Mykje" },
  ];
  const amountPills = amounts.map((a) => {
    const pill = el(
      "button",
      { className: `type-pill ${selectedAmount === a.value ? "active" : ""}` },
      [a.label],
    );
    pill.addEventListener("click", () => {
      selectedAmount = a.value;
      amountPills.forEach((p, i) => {
        p.className = `type-pill ${selectedAmount === amounts[i].value ? "active" : ""}`;
      });
    });
    return pill;
  });
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Mengd"]),
      el("div", { className: "type-pills" }, amountPills),
    ]),
  );

  // Note
  const noteInput = el("input", {
    type: "text",
    placeholder: "Valfritt notat...",
    value: entry.note || "",
  }) as HTMLInputElement;
  modal.appendChild(
    el("div", { className: "form-group" }, [el("label", null, ["Notat"]), noteInput]),
  );

  // Time display
  modal.appendChild(
    el(
      "div",
      { style: { color: "var(--text-light)", fontSize: "0.85rem", marginBottom: "16px" } },
      [`Logga kl. ${formatTime(entry.time)}`],
    ),
  );

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Lagra"]);
  const deleteBtn = el("button", { className: "btn btn-danger" }, ["Slett"]);
  const cancelBtn = el("button", { className: "btn btn-ghost" }, ["Avbryt"]);

  saveBtn.addEventListener("click", async () => {
    await postEvents([
      {
        type: "diaper.updated",
        payload: {
          diaperId: entry.id,
          type: selectedType,
          amount: selectedAmount,
          note: noteInput.value.trim() || undefined,
        },
        clientId: getClientId(),
      },
    ]);
    close();
    await refreshState();
    renderHistory(container);
  });

  deleteBtn.addEventListener("click", async () => {
    const confirmed = await showConfirm(
      "Sletta denne bleieoppføringa? Dette kan ikkje angrast.",
      "Slett",
      "Avbryt",
    );
    if (confirmed) {
      await postEvents([
        { type: "diaper.deleted", payload: { diaperId: entry.id }, clientId: getClientId() },
      ]);
      close();
      await refreshState();
      renderHistory(container);
    }
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  document.addEventListener("keydown", escHandler);

  modal.appendChild(el("div", { className: "btn-row" }, [deleteBtn, saveBtn]));
  modal.appendChild(el("div", { style: { textAlign: "center", marginTop: "12px" } }, [cancelBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", escHandler);
  }
}
