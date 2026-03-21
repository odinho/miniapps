import { getAppState, setAppState } from "../main.js";
import { postEvents } from "../api.js";
import { queueEvent, getClientId } from "../sync.js";
import { getExpectedNapCount } from "../engine/schedule.js";
import {
  el,
  formatAge,
  formatDuration,
  renderTimerWithPauses,
  renderCountdown,
  formatTime,
} from "./components.js";
import { showToast } from "./toast.js";
import { renderArc } from "./arc.js";
import { showEditModal } from "./history.js";
import {
  MOODS,
  METHODS,
  MOOD_EMOJI,
  METHOD_EMOJI,
  FALL_ASLEEP_LABELS,
  FALL_ASLEEP_BUCKETS,
} from "../constants.js";
import { toLocalDate, toLocalTime } from "../utils.js";
import type { Baby, SleepLogRow, SleepPauseRow } from "../../types.js";

/** Send event optimistically — if offline, queue it and show a toast. Returns true if online. */
async function sendEvent(type: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const result = await postEvents([{ type, payload, clientId: getClientId() }]);
    setAppState(result.state);
    return true;
  } catch {
    queueEvent(type, payload);
    showToast("Lagra offline — synkar snart", "warning");
    return false;
  }
}

/** Simple hour-based classification fallback. */
function classifySleepTypeByHour(): "nap" | "night" {
  const hour = new Date().getHours();
  return hour >= 18 || hour < 6 ? "night" : "nap";
}

/** Smart classification: considers time-of-day, nap count, and last wake time. */
function classifySleepType(
  todaySleeps: SleepLogRow[],
  ageMonths?: number,
  customNapCount?: number | null,
): "nap" | "night" {
  const hour = new Date().getHours();
  // Clear night (before 6am or after 8pm)
  if (hour < 6 || hour >= 20) return "night";
  // Clear daytime (before 4pm)
  if (hour < 16) return "nap";
  // Ambiguous zone (16:00–19:59): check if naps are done for the day
  if (ageMonths != null) {
    const expectedNaps = getExpectedNapCount(ageMonths, customNapCount);
    const completedNaps = todaySleeps.filter((s) => s.type === "nap" && s.end_time).length;
    if (completedNaps >= expectedNaps) return "night";
  }
  // In the 16–18 range, if we haven't met nap count, still likely a nap
  if (hour < 18) return "nap";
  return "night";
}

function calcPauseMs(pauses: SleepPauseRow[]): number {
  let total = 0;
  for (const p of pauses) {
    const start = new Date(p.pause_time).getTime();
    const end = p.resume_time ? new Date(p.resume_time).getTime() : Date.now();
    total += end - start;
  }
  return total;
}

let cleanups: (() => void)[] = [];

// Track dismissed predicted naps (resets daily)
const DISMISSED_KEY = "babysovelogg_dismissed_predictions";

function getDismissedPredictions(): Set<number> {
  try {
    const stored = localStorage.getItem(DISMISSED_KEY);
    if (!stored) return new Set();
    const { date, indices } = JSON.parse(stored);
    if (date !== new Date().toISOString().slice(0, 10)) return new Set();
    return new Set(indices);
  } catch {
    return new Set();
  }
}

function dismissPrediction(index: number): void {
  const dismissed = getDismissedPredictions();
  dismissed.add(index);
  localStorage.setItem(
    DISMISSED_KEY,
    JSON.stringify({
      date: new Date().toISOString().slice(0, 10),
      indices: [...dismissed],
    }),
  );
}

export function cleanupDashboard() {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  // Clean up any lingering elements
  document.querySelector(".fab")?.remove();
  document.querySelector(".fab-menu")?.remove();
}

export function renderDashboard(container: HTMLElement): void {
  cleanupDashboard();
  container.innerHTML = "";

  const state = getAppState();
  if (!state?.baby) {
    window.location.hash = "#/settings";
    return;
  }

  const { baby, activeSleep, todaySleeps, stats, prediction, ageMonths, todayWakeUp } = state;

  // Show morning prompt if no wake-up time set and no sleeps today
  // But only during morning hours (5-11), not in the middle of the night
  const currentHourForPrompt = new Date().getHours();
  const isMorningTime = currentHourForPrompt >= 5 && currentHourForPrompt < 12;
  if (!todayWakeUp && todaySleeps.length === 0 && !activeSleep && isMorningTime) {
    showMorningPrompt(baby, container);
    return;
  }

  const isSleeping = !!activeSleep;
  const pauses: SleepPauseRow[] = activeSleep?.pauses || [];
  const isPaused = pauses.length > 0 && !pauses[pauses.length - 1].resume_time;

  const view = el("div", { className: "view" });
  const dash = el("div", { className: "dashboard", "data-testid": "dashboard" });

  // Header row: baby info + sleep button
  const sleepIcon = isSleeping ? "☀️" : "😴";
  const sleepLabel = isSleeping ? "Vakn" : "Sov";
  const btn = el(
    "button",
    {
      className: `sleep-button ${isSleeping ? "sleeping" : "awake"}`,
      "data-testid": "sleep-button",
    },
    [
      el("span", { className: "icon" }, [sleepIcon]),
      el("span", { className: "label" }, [sleepLabel]),
    ],
  );

  dash.appendChild(
    el("div", { className: "header-row" }, [
      el("div", { className: "baby-info" }, [
        el("span", { className: "baby-name", "data-testid": "baby-name" }, [baby.name]),
        el("span", { className: "baby-age", "data-testid": "baby-age" }, [
          formatAge(baby.birthdate),
        ]),
      ]),
      btn,
    ]),
  );

  btn.addEventListener("click", async () => {
    if (isSleeping && activeSleep) {
      // End sleep — save immediately, then show optional wake-up sheet
      // Get fresh sleep data with any tags set after start (via tag sheet)
      const currentState = getAppState();
      const sleepSnapshot = currentState?.activeSleep
        ? { ...currentState.activeSleep }
        : { ...activeSleep };
      const sleepId = activeSleep.id;
      await sendEvent("sleep.ended", { sleepId, endTime: new Date().toISOString() });
      renderDashboard(container);
      showWakeUpSheet(sleepId, sleepSnapshot, container);
    } else {
      // Start sleep — then show bedtime tag sheet
      const type = classifySleepType(todaySleeps, ageMonths, baby.custom_nap_count);
      await sendEvent("sleep.started", {
        babyId: baby.id,
        startTime: new Date().toISOString(),
        type,
      });
      renderDashboard(container);
      // Get the new active sleep ID from state
      const newState = getAppState();
      if (newState?.activeSleep?.id) {
        showTagSheet(newState.activeSleep.id, container);
      }
    }
  });

  // Pause/resume button when sleeping
  if (isSleeping && activeSleep) {
    const pauseBtn = el(
      "button",
      {
        className: `btn ${isPaused ? "btn-primary" : "btn-ghost"} pause-btn`,
        "data-testid": "pause-btn",
      },
      [isPaused ? "▶️ Fortset" : "⏸️ Pause"],
    );
    pauseBtn.addEventListener("click", async () => {
      const eventType = isPaused ? "sleep.resumed" : "sleep.paused";
      const payload = isPaused
        ? { sleepId: activeSleep.id, resumeTime: new Date().toISOString() }
        : { sleepId: activeSleep.id, pauseTime: new Date().toISOString() };
      await sendEvent(eventType, payload);
      renderDashboard(container);
    });
    dash.appendChild(pauseBtn);
  }

  // 12-hour arc visualization
  const isNightMode = document.documentElement.getAttribute("data-theme") === "night";

  // Filter out dismissed predicted naps
  const dismissed = getDismissedPredictions();
  const filteredPrediction = prediction
    ? {
        ...prediction,
        predictedNaps: prediction.predictedNaps?.filter((_, i) => !dismissed.has(i)),
      }
    : null;
  // Keep the original prediction array for index mapping
  const originalPredictedNaps = prediction?.predictedNaps || [];

  const arcSvg = renderArc({
    todaySleeps: todaySleeps.map((s) => ({
      start_time: s.start_time,
      end_time: s.end_time,
      type: s.type as "nap" | "night",
    })),
    activeSleep: activeSleep
      ? { start_time: activeSleep.start_time, type: activeSleep.type as "nap" | "night" }
      : null,
    prediction: filteredPrediction,
    isNightMode,
    wakeUpTime: todayWakeUp?.wake_time,
    startTimeLabel: isNightMode
      ? null
      : todayWakeUp?.wake_time
        ? formatTime(todayWakeUp.wake_time)
        : null,
    endTimeLabel: isNightMode
      ? null
      : prediction?.bedtime
        ? "~" + formatTime(prediction.bedtime)
        : null,
    onSleepClick: (index: number) => {
      const sleep = todaySleeps[index];
      if (sleep) showEditModal(sleep, container);
    },
    onStartClick: () => {
      if (isNightMode) {
        // Night start = find the night sleep entry
        const nightSleep = todaySleeps.find((s) => s.type === "night");
        if (nightSleep) showEditModal(nightSleep, container);
        else showWakeUpPanel(baby, container);
      } else {
        // Day start = wake-up time, allow editing
        showWakeUpPanel(baby, container);
      }
    },
    onEndClick: () => {
      if (isNightMode) {
        // Night end = morning wake-up
        showWakeUpPanel(baby, container);
      } else {
        // Day end = bedtime. Show the night sleep entry if exists
        const nightSleep = todaySleeps.find((s) => s.type === "night");
        if (nightSleep) {
          showEditModal(nightSleep, container);
        } else if (prediction?.bedtime) {
          showToast(`Leggetid: ~${formatTime(prediction.bedtime)}`, "info");
        }
      }
    },
    onPredictedNapClick: (filteredIndex: number) => {
      // Map filtered index back to original prediction index
      const filteredNaps = filteredPrediction?.predictedNaps || [];
      const clickedNap = filteredNaps[filteredIndex];
      if (!clickedNap) return;
      const origIndex = originalPredictedNaps.findIndex(
        (p: { startTime: string }) => p.startTime === clickedNap.startTime,
      );
      if (origIndex >= 0) showPredictedNapSheet(origIndex, clickedNap, baby, container);
    },
  });
  const arcContainer = el("div", { className: "arc-container" });
  arcContainer.appendChild(arcSvg);

  // Center text inside arc (countdown or timer)
  const arcCenter = el("div", { className: "arc-center-text" });

  if (isSleeping && activeSleep) {
    const arcTimer = renderTimerWithPauses(
      activeSleep.start_time,
      () => calcPauseMs(pauses),
      isPaused,
    );
    cleanups.push(arcTimer.stop);
    arcCenter.appendChild(
      el("div", { className: "arc-center-label" }, [
        isPaused ? "⏸️ Pause" : activeSleep.type === "night" ? "💤 Søv" : "😴 Lurar",
      ]),
    );
    arcCenter.appendChild(arcTimer.element);
    const editLink = el("span", { className: "edit-start-link" }, [
      "Starta " + formatTime(activeSleep.start_time),
    ]);
    editLink.addEventListener("click", () => showEditModal(activeSleep, container));
    arcCenter.appendChild(editLink);
  } else {
    const now = new Date();
    const currentHour = now.getHours();
    const isDeepNight = currentHour >= 0 && currentHour < 5;
    const isEvening = currentHour >= 20;

    if (isDeepNight) {
      // Middle of the night - show sleep encouragement & wake-up countdown
      arcCenter.appendChild(el("div", { className: "arc-center-label" }, ["God natt 💤"]));
      if (todayWakeUp?.wake_time) {
        const wakeTime = new Date(todayWakeUp.wake_time);
        const msUntilWake = wakeTime.getTime() - now.getTime();
        if (msUntilWake > 0) {
          const cd = renderCountdown(todayWakeUp.wake_time);
          cleanups.push(cd.stop);
          arcCenter.appendChild(cd.element);
          arcCenter.appendChild(
            el(
              "div",
              {
                className: "edit-start-link",
                style: { textDecoration: "none", cursor: "default", pointerEvents: "auto" },
              },
              [`Vaknar ${formatTime(todayWakeUp.wake_time)}`],
            ),
          );
        }
      }
    } else if (prediction?.nextNap) {
      const nextNapTime = new Date(prediction.nextNap);
      const hoursUntilNap = (nextNapTime.getTime() - now.getTime()) / 3600000;

      if ((isEvening || hoursUntilNap < 0) && prediction?.bedtime) {
        // Evening or past nap time - show bedtime
        const bedtime = new Date(prediction.bedtime);
        const bedtimeInPast = bedtime.getTime() < now.getTime();
        if (bedtimeInPast) {
          arcCenter.appendChild(el("div", { className: "arc-center-label" }, ["Etter leggetid"]));
          arcCenter.appendChild(
            el("span", { className: "countdown-value" }, [formatTime(prediction.bedtime)]),
          );
        } else {
          const cd = renderCountdown(prediction.bedtime);
          cleanups.push(cd.stop);
          arcCenter.appendChild(el("div", { className: "arc-center-label" }, ["Leggetid om"]));
          arcCenter.appendChild(cd.element);
          arcCenter.appendChild(
            el(
              "div",
              {
                className: "edit-start-link",
                style: { textDecoration: "none", cursor: "default", pointerEvents: "auto" },
              },
              [formatTime(prediction.bedtime)],
            ),
          );
        }
      } else if (hoursUntilNap > 0) {
        const cd = renderCountdown(prediction.nextNap);
        cleanups.push(cd.stop);
        arcCenter.appendChild(el("div", { className: "arc-center-label" }, ["Neste lur"]));
        arcCenter.appendChild(cd.element);
      }

      // Show "awake since" info (only if wake time is in the past)
      const lastSleep = todaySleeps.find((s) => s.end_time);
      const awakeSince = lastSleep?.end_time || todayWakeUp?.wake_time;
      if (awakeSince) {
        const awakeMs = now.getTime() - new Date(awakeSince).getTime();
        if (awakeMs > 60000) {
          arcCenter.appendChild(
            el(
              "div",
              {
                className: "edit-start-link",
                style: { textDecoration: "none", cursor: "default", pointerEvents: "auto" },
              },
              [`Vaken ${formatDuration(awakeMs)}`],
            ),
          );
        }
      }
    }
  }

  arcContainer.appendChild(arcCenter);

  // Action buttons in the arc gap
  const arcActions = el("div", { className: "arc-actions" });
  if (isNightMode) {
    if (isSleeping) {
      // During active night sleep: pause + diaper
      const pauseActionBtn = el("button", { className: "arc-action-btn night" }, [
        isPaused ? "▶️ Fortset" : "⏸️ Pause",
      ]);
      pauseActionBtn.addEventListener("click", async () => {
        const eventType = isPaused ? "sleep.resumed" : "sleep.paused";
        const payload = isPaused
          ? { sleepId: activeSleep!.id, resumeTime: new Date().toISOString() }
          : { sleepId: activeSleep!.id, pauseTime: new Date().toISOString() };
        await sendEvent(eventType, payload);
        renderDashboard(container);
      });
      arcActions.appendChild(pauseActionBtn);
    } else {
      // Night, not sleeping: night waking + morning
      const nightBtn = el("button", { className: "arc-action-btn night" }, ["🌙 Nattevaking"]);
      nightBtn.addEventListener("click", async () => {
        await sendEvent("sleep.started", {
          babyId: baby.id,
          startTime: new Date().toISOString(),
          type: "night",
        });
        renderDashboard(container);
      });
      const morningBtn = el("button", { className: "arc-action-btn morning" }, ["☀️ Morgon"]);
      morningBtn.addEventListener("click", () => showWakeUpPanel(baby, container));
      arcActions.appendChild(nightBtn);
      arcActions.appendChild(morningBtn);
    }
  } else {
    if (isSleeping) {
      // Sleeping during day: pause + wake
      const pauseActionBtn = el("button", { className: "arc-action-btn nap" }, [
        isPaused ? "▶️ Fortset" : "⏸️ Pause",
      ]);
      pauseActionBtn.addEventListener("click", async () => {
        const eventType = isPaused ? "sleep.resumed" : "sleep.paused";
        const payload = isPaused
          ? { sleepId: activeSleep!.id, resumeTime: new Date().toISOString() }
          : { sleepId: activeSleep!.id, pauseTime: new Date().toISOString() };
        await sendEvent(eventType, payload);
        renderDashboard(container);
      });
      arcActions.appendChild(pauseActionBtn);
    } else {
      // Daytime, awake: nap + diaper
      const napBtn = el("button", { className: "arc-action-btn nap" }, ["😴 Lur"]);
      napBtn.addEventListener("click", async () => {
        await sendEvent("sleep.started", {
          babyId: baby.id,
          startTime: new Date().toISOString(),
          type: "nap",
        });
        renderDashboard(container);
      });
      const isPottyMode = baby.potty_mode === 1;
      const diaperBtn = el("button", { className: "arc-action-btn diaper" }, [
        isPottyMode ? "🚽 Do" : "🧷 Bleie",
      ]);
      diaperBtn.addEventListener("click", () =>
        isPottyMode ? showPottyModal(baby, container) : showDiaperModal(baby, container),
      );
      arcActions.appendChild(napBtn);
      arcActions.appendChild(diaperBtn);
    }
  }
  dash.appendChild(arcContainer);

  // Today's stats
  if (stats) {
    const napCountEl = el("div", { className: "stat-value" });
    const napTimeEl = el("div", { className: "stat-value" });
    const totalSleepEl = el("div", { className: "stat-value" });

    const updateStats = () => {
      let activeMinutes = 0;
      if (activeSleep) {
        const elapsedMs =
          Date.now() - new Date(activeSleep.start_time).getTime() - calcPauseMs(pauses);
        activeMinutes = Math.max(0, elapsedMs) / 60000;
      }
      const isActiveNap = activeSleep?.type === "nap";
      const napCount = stats.napCount + (isActiveNap ? 1 : 0);
      const napMinutes = stats.totalNapMinutes + (isActiveNap ? activeMinutes : 0);
      const totalMinutes = stats.totalNapMinutes + stats.totalNightMinutes + activeMinutes;

      napCountEl.textContent = String(napCount);
      napTimeEl.textContent = formatDuration(napMinutes * 60000);
      totalSleepEl.textContent = formatDuration(totalMinutes * 60000);
    };

    updateStats();

    if (isSleeping) {
      const statsInterval = setInterval(updateStats, 1000);
      cleanups.push(() => clearInterval(statsInterval));
    }

    // Compact inline summary below arc
    const napLabel = el("span", { className: "summary-label" }, [" lurar"]);
    const updateNapLabel = () => {
      napLabel.textContent = napCountEl.textContent === "1" ? " lur" : " lurar";
    };

    // Observe changes to nap count to update singular/plural
    const observer = new MutationObserver(updateNapLabel);
    observer.observe(napCountEl, { childList: true, characterData: true, subtree: true });
    cleanups.push(() => observer.disconnect());
    updateNapLabel();

    const summaryRow = el("div", { className: "summary-row" }, [
      el("span", null, [napCountEl, napLabel]),
      el("span", { className: "summary-sep" }, ["·"]),
      el("span", null, [napTimeEl, el("span", { className: "summary-label" }, [" lurtid"])]),
      el("span", { className: "summary-sep" }, ["·"]),
      el("span", null, [totalSleepEl, el("span", { className: "summary-label" }, [" totalt"])]),
    ]);
    dash.appendChild(summaryRow);
  }

  // Action buttons - below stats, in the big open space
  dash.appendChild(arcActions);

  view.appendChild(dash);
  container.appendChild(view);
}

function makeDateTimeInputs(iso: string): {
  dateInput: HTMLInputElement;
  timeInput: HTMLInputElement;
  getValue: () => string;
} {
  const dateInput = el("input", { type: "date", value: toLocalDate(iso) }) as HTMLInputElement;
  const timeInput = el("input", { type: "time", value: toLocalTime(iso) }) as HTMLInputElement;
  return {
    dateInput,
    timeInput,
    getValue: () => `${dateInput.value}T${timeInput.value}`,
  };
}

function dateTimeGroup(
  label: string,
  dt: { dateInput: HTMLInputElement; timeInput: HTMLInputElement },
): HTMLElement {
  return el("div", { className: "form-group" }, [
    el("label", null, [label]),
    el("div", { className: "datetime-row" }, [dt.dateInput, dt.timeInput]),
  ]);
}

function _showManualSleepModal(baby: Baby, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal" });

  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 3600000);

  const startDt = makeDateTimeInputs(oneHourAgo.toISOString());
  const endDt = makeDateTimeInputs(now.toISOString());

  let selectedType = classifySleepTypeByHour();
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

  modal.appendChild(el("h2", null, ["Legg til søvn"]));
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Type"]),
      el("div", { className: "type-pills" }, [napPill, nightPill]),
    ]),
  );
  modal.appendChild(dateTimeGroup("Start", startDt));
  modal.appendChild(dateTimeGroup("Slutt", endDt));

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Lagra"]);
  const cancelBtn = el("button", { className: "btn btn-ghost" }, ["Avbryt"]);

  saveBtn.addEventListener("click", async () => {
    const start = new Date(startDt.getValue());
    const end = new Date(endDt.getValue());
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      showToast("Fyll inn begge tidene", "warning");
      return;
    }
    if (end <= start) {
      showToast("Slutt må vera etter start", "warning");
      return;
    }

    try {
      const result = await postEvents([
        {
          type: "sleep.manual",
          payload: {
            babyId: baby.id,
            startTime: start.toISOString(),
            endTime: end.toISOString(),
            type: selectedType,
          },
          clientId: getClientId(),
        },
      ]);
      setAppState(result.state);
      showToast("Søvn lagt til", "success");
      close();
      renderDashboard(container);
    } catch {
      showToast("Klarte ikkje lagra", "error");
    }
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  modal.appendChild(el("div", { className: "btn-row" }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
}

function _showEditStartModal(activeSleep: SleepLogRow, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal" });

  const startDt = makeDateTimeInputs(activeSleep.start_time);

  modal.appendChild(el("h2", null, ["Endra starttid"]));
  modal.appendChild(dateTimeGroup("Starta kl.", startDt));

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Lagra"]);
  const cancelBtn = el("button", { className: "btn btn-ghost" }, ["Avbryt"]);

  saveBtn.addEventListener("click", async () => {
    const start = new Date(startDt.getValue());
    if (isNaN(start.getTime())) {
      showToast("Ugyldig tid", "warning");
      return;
    }
    try {
      const result = await postEvents([
        {
          type: "sleep.updated",
          payload: { sleepId: activeSleep.id, startTime: start.toISOString() },
          clientId: getClientId(),
        },
      ]);
      setAppState(result.state);
      showToast("Starttid oppdatert", "success");
      close();
      renderDashboard(container);
    } catch {
      showToast("Klarte ikkje oppdatera", "error");
    }
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  modal.appendChild(el("div", { className: "btn-row" }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
}

function showTagSheet(sleepId: number, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal tag-sheet" });

  let selectedMood: string | null = null;
  let selectedMethod: string | null = null;
  let selectedFallAsleep: string | null = null;

  modal.appendChild(el("h2", null, ["Korleis gjekk legginga?"]));

  // Mood selection — specifically about going to sleep
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Humør ved legging"]),
      el(
        "div",
        { className: "tag-pills" },
        MOODS.map((m) => {
          const pill = el(
            "button",
            {
              className: "tag-pill",
              "data-mood": m.value,
              title: m.title,
            },
            [
              el("span", { className: "tag-emoji" }, [m.label]),
              el("span", { className: "tag-label" }, [m.title]),
            ],
          );
          pill.addEventListener("click", () => {
            selectedMood = selectedMood === m.value ? null : m.value;
            modal
              .querySelectorAll("[data-mood]")
              .forEach((p) =>
                p.classList.toggle("active", p.getAttribute("data-mood") === selectedMood),
              );
          });
          return pill;
        }),
      ),
    ]),
  );

  // Method selection
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Metode"]),
      el(
        "div",
        { className: "tag-pills" },
        METHODS.map((m) => {
          const pill = el(
            "button",
            {
              className: "tag-pill",
              "data-method": m.value,
              title: m.title,
            },
            [
              el("span", { className: "tag-emoji" }, [m.label]),
              el("span", { className: "tag-label" }, [m.title]),
            ],
          );
          pill.addEventListener("click", () => {
            selectedMethod = selectedMethod === m.value ? null : m.value;
            modal
              .querySelectorAll("[data-method]")
              .forEach((p) =>
                p.classList.toggle("active", p.getAttribute("data-method") === selectedMethod),
              );
          });
          return pill;
        }),
      ),
    ]),
  );

  // Fall-asleep time buckets
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Innsovningstid"]),
      el(
        "div",
        { className: "type-pills" },
        FALL_ASLEEP_BUCKETS.map((b) => {
          const pill = el("button", { className: "type-pill", "data-fall-asleep": b.value }, [
            b.label,
          ]);
          pill.addEventListener("click", () => {
            selectedFallAsleep = selectedFallAsleep === b.value ? null : b.value;
            modal
              .querySelectorAll("[data-fall-asleep]")
              .forEach((p) =>
                p.classList.toggle(
                  "active",
                  p.getAttribute("data-fall-asleep") === selectedFallAsleep,
                ),
              );
          });
          return pill;
        }),
      ),
    ]),
  );

  // Notes
  const noteInput = el("input", {
    type: "text",
    placeholder: "Valfritt notat...",
  }) as HTMLInputElement;
  modal.appendChild(
    el("div", { className: "form-group" }, [el("label", null, ["Notat"]), noteInput]),
  );

  const doneBtn = el("button", { className: "btn btn-primary" }, ["Ferdig"]);

  doneBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  // Diaper-before-bed nudge: remind if no diaper in the last 2 hours
  const appState = getAppState();
  const lastDiaper = appState?.lastDiaperTime;
  const twoHoursAgo = Date.now() - 2 * 3600000;
  if (!lastDiaper || new Date(lastDiaper).getTime() < twoHoursAgo) {
    const isPotty = appState?.baby?.potty_mode === 1;
    const nudge = el(
      "div",
      {
        className: "diaper-nudge",
        style: {
          display: "flex",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "8px",
          padding: "10px 12px",
          background: "var(--lavender)",
          borderRadius: "var(--radius-sm)",
          fontSize: "0.85rem",
          color: "var(--text-light)",
          marginBottom: "12px",
        },
      },
      [isPotty ? "🚽 Ikkje vore på do dei siste 2 timane" : "🧷 Inga bleie dei siste 2 timane"],
    );
    const logDiaperBtn = el(
      "button",
      { className: "btn btn-ghost", style: { fontSize: "0.8rem", padding: "2px 10px" } },
      [isPotty ? "Logg do" : "Logg bleie"],
    );
    logDiaperBtn.addEventListener("click", () => {
      close();
      const baby = appState?.baby;
      if (baby) {
        if (isPotty) showPottyModal(baby, container);
        else showDiaperModal(baby, container);
      }
    });
    nudge.appendChild(logDiaperBtn);
    modal.appendChild(nudge);
  }

  modal.appendChild(el("div", { style: { marginTop: "16px" } }, [doneBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Auto-save on any close — never lose entered data
  async function close() {
    overlay.remove();
    if (selectedMood || selectedMethod || selectedFallAsleep || noteInput.value.trim()) {
      try {
        const result = await postEvents([
          {
            type: "sleep.tagged",
            payload: {
              sleepId,
              mood: selectedMood,
              method: selectedMethod,
              fallAsleepTime: selectedFallAsleep,
              notes: noteInput.value.trim() || undefined,
            },
            clientId: getClientId(),
          },
        ]);
        setAppState(result.state);
      } catch (err) {
        console.error("Failed to save sleep tags:", err);
      }
    }
  }
}

function showWakeUpSheet(sleepId: number, sleepData: SleepLogRow, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal tag-sheet" });

  modal.appendChild(el("h2", null, ["Oppvakning"]));

  // Compact bedtime summary — show what was recorded at sleep start
  const hasBedtimeTags =
    sleepData?.mood || sleepData?.method || sleepData?.fall_asleep_time || sleepData?.notes;
  if (hasBedtimeTags) {
    const badges: (Node | string)[] = [];
    if (sleepData.mood && MOOD_EMOJI[sleepData.mood]) {
      const m = MOODS.find((x) => x.value === sleepData.mood);
      badges.push(
        el("span", { className: "tag-badge", title: m?.title || "" }, [MOOD_EMOJI[sleepData.mood]]),
      );
    }
    if (sleepData.method && METHOD_EMOJI[sleepData.method]) {
      const m = METHODS.find((x) => x.value === sleepData.method);
      badges.push(
        el("span", { className: "tag-badge", title: m?.title || "" }, [
          METHOD_EMOJI[sleepData.method],
        ]),
      );
    }

    const metaParts: (Node | string)[] = [];
    if (badges.length > 0)
      metaParts.push(el("span", { className: "tag-badges", style: { gap: "4px" } }, badges));
    if (sleepData.fall_asleep_time) {
      metaParts.push(
        el("span", { style: { color: "var(--text-light)", fontSize: "0.8rem" } }, [
          "⏱️ " + (FALL_ASLEEP_LABELS[sleepData.fall_asleep_time] || sleepData.fall_asleep_time),
        ]),
      );
    }

    const summaryChildren: (Node | string)[] = [];
    if (metaParts.length > 0) {
      summaryChildren.push(
        el(
          "div",
          { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          metaParts,
        ),
      );
    }
    if (sleepData.notes) {
      summaryChildren.push(
        el(
          "div",
          {
            style: {
              fontStyle: "italic",
              fontSize: "0.8rem",
              color: "var(--text-light)",
              marginTop: "4px",
            },
          },
          [`"${sleepData.notes}"`],
        ),
      );
    }

    const editLink = el(
      "span",
      { style: { fontSize: "0.75rem", color: "var(--primary)", cursor: "pointer" } },
      ["Endra →"],
    );

    const summaryCard = el(
      "div",
      {
        className: "bedtime-summary",
        "data-testid": "bedtime-summary",
        style: {
          padding: "10px 12px",
          background: "var(--lavender)",
          borderRadius: "var(--radius-sm)",
          marginBottom: "16px",
          cursor: "pointer",
        },
      },
      [
        el(
          "div",
          {
            style: {
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: summaryChildren.length ? "4px" : "0",
            },
          },
          [
            el(
              "span",
              {
                style: {
                  fontSize: "0.75rem",
                  fontWeight: "600",
                  color: "var(--text-light)",
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                },
              },
              ["Legging"],
            ),
            editLink,
          ],
        ),
        ...summaryChildren,
      ],
    );

    summaryCard.addEventListener("click", () => {
      close();
      // Find the sleep entry in todaySleeps for the full edit modal
      const state = getAppState();
      const entry = state?.todaySleeps?.find((s) => s.id === sleepId);
      if (entry) showEditModal(entry, container);
    });

    modal.appendChild(summaryCard);
  }

  // Woke self vs was woken
  let wokeBy: string | null = null;
  const WOKE_OPTIONS = [
    { value: "self", label: "Vakna sjølv" },
    { value: "woken", label: "Vekt av oss" },
  ];
  const wokePills = WOKE_OPTIONS.map((o) => {
    const pill = el("button", { className: "type-pill", "data-woke": o.value }, [o.label]);
    pill.addEventListener("click", () => {
      wokeBy = wokeBy === o.value ? null : o.value;
      wokePills.forEach(
        (p, i) => (p.className = `type-pill ${wokeBy === WOKE_OPTIONS[i].value ? "active" : ""}`),
      );
    });
    return pill;
  });
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Oppvakning"]),
      el("div", { className: "type-pills" }, wokePills),
    ]),
  );

  // Notes
  const noteInput = el("input", {
    type: "text",
    placeholder: "Valfritt notat...",
  }) as HTMLInputElement;
  modal.appendChild(
    el("div", { className: "form-group" }, [el("label", null, ["Notat"]), noteInput]),
  );

  const doneBtn = el("button", { className: "btn btn-primary" }, ["Ferdig"]);

  doneBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  modal.appendChild(el("div", { style: { marginTop: "16px" } }, [doneBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Auto-save on any close
  async function close() {
    overlay.remove();
    if (wokeBy || noteInput.value.trim()) {
      try {
        const payload: Record<string, unknown> = { sleepId };
        if (wokeBy) payload.wokeBy = wokeBy;
        if (noteInput.value.trim()) payload.wakeNotes = noteInput.value.trim();
        const result = await postEvents([
          {
            type: "sleep.updated",
            payload,
            clientId: getClientId(),
          },
        ]);
        setAppState(result.state);
      } catch (err) {
        console.error("Failed to save wake-up info:", err);
      }
    }
  }
}

function showDiaperModal(baby: Baby, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal" });

  let selectedType = "wet";
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
      updatePills();
    });
    return pill;
  });

  const updatePills = () => {
    typePills.forEach((pill, i) => {
      pill.className = `type-pill ${selectedType === types[i].value ? "active" : ""}`;
    });
  };

  let selectedAmount = "middels";
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

  const timeDt = makeDateTimeInputs(new Date().toISOString());
  const noteInput = el("input", {
    type: "text",
    placeholder: "Valfritt notat...",
  }) as HTMLInputElement;

  modal.appendChild(el("h2", null, ["Logg bleie"]));
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Type"]),
      el("div", { className: "type-pills diaper-type-pills" }, typePills),
    ]),
  );
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Mengd"]),
      el("div", { className: "type-pills" }, amountPills),
    ]),
  );
  modal.appendChild(dateTimeGroup("Tid", timeDt));
  modal.appendChild(
    el("div", { className: "form-group" }, [el("label", null, ["Notat"]), noteInput]),
  );

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Lagra"]);
  const cancelBtn = el("button", { className: "btn btn-ghost" }, ["Avbryt"]);

  saveBtn.addEventListener("click", async () => {
    const time = new Date(timeDt.getValue());
    if (isNaN(time.getTime())) {
      showToast("Ugyldig tid", "warning");
      return;
    }
    try {
      const result = await postEvents([
        {
          type: "diaper.logged",
          payload: {
            babyId: baby.id,
            time: time.toISOString(),
            type: selectedType,
            amount: selectedAmount,
            note: noteInput.value || undefined,
          },
          clientId: getClientId(),
        },
      ]);
      setAppState(result.state);
      showToast("Bleie logga", "success");
      close();
      renderDashboard(container);
    } catch {
      showToast("Klarte ikkje lagra", "error");
    }
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  modal.appendChild(el("div", { className: "btn-row" }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
}

function showPredictedNapSheet(
  predIndex: number,
  pred: { startTime: string; endTime: string },
  baby: Baby,
  container: HTMLElement,
): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal tag-sheet" });

  modal.appendChild(el("h2", null, ["Forventa lur"]));
  modal.appendChild(
    el("p", { style: { color: "var(--text-light)", marginBottom: "16px" } }, [
      `${formatTime(pred.startTime)} – ${formatTime(pred.endTime)}`,
    ]),
  );

  const startBtn = el("button", { className: "btn btn-primary" }, ["😴 Start no"]);
  const skipBtn = el("button", { className: "btn btn-ghost" }, ["Skjer ikkje"]);

  startBtn.addEventListener("click", async () => {
    close();
    await sendEvent("sleep.started", {
      babyId: baby.id,
      startTime: new Date().toISOString(),
      type: "nap",
    });
    renderDashboard(container);
    const newState = getAppState();
    if (newState?.activeSleep?.id) showTagSheet(newState.activeSleep.id, container);
  });

  skipBtn.addEventListener("click", () => {
    dismissPrediction(predIndex);
    close();
    renderDashboard(container);
  });

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  modal.appendChild(el("div", { className: "btn-row" }, [skipBtn, startBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
}

function showPottyModal(baby: Baby, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal" });

  let selectedResult = "potty_wet";
  const results = [
    { value: "potty_wet", label: "💧 Tiss" },
    { value: "potty_dirty", label: "💩 Bæsj" },
    { value: "potty_nothing", label: "∅ Ingenting" },
    { value: "diaper_only", label: "🧷 Ingen do" },
  ];
  const resultPills = results.map((r) => {
    const pill = el(
      "button",
      {
        className: `type-pill ${selectedResult === r.value ? "active" : ""}`,
        "data-potty": r.value,
      },
      [r.label],
    );
    pill.addEventListener("click", () => {
      selectedResult = r.value;
      resultPills.forEach(
        (p, i) =>
          (p.className = `type-pill ${selectedResult === results[i].value ? "active" : ""}`),
      );
      diaperStatusGroup.style.display = selectedResult === "diaper_only" ? "none" : "";
    });
    return pill;
  });

  let selectedDiaperStatus = "dry";
  const statuses = [
    { value: "dry", label: "Tørr ✨" },
    { value: "damp", label: "Litt 💧" },
    { value: "wet", label: "Våt 💧💧" },
  ];
  const statusPills = statuses.map((s) => {
    const pill = el(
      "button",
      { className: `type-pill ${selectedDiaperStatus === s.value ? "active" : ""}` },
      [s.label],
    );
    pill.addEventListener("click", () => {
      selectedDiaperStatus = s.value;
      statusPills.forEach(
        (p, i) =>
          (p.className = `type-pill ${selectedDiaperStatus === statuses[i].value ? "active" : ""}`),
      );
    });
    return pill;
  });

  const noteInput = el("input", {
    type: "text",
    placeholder: "Valfritt notat...",
  }) as HTMLInputElement;

  modal.appendChild(el("h2", null, ["Logg dobesøk"]));
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Resultat"]),
      el("div", { className: "type-pills diaper-type-pills" }, resultPills),
    ]),
  );

  const diaperStatusGroup = el("div", { className: "form-group" }, [
    el("label", null, ["Bleie"]),
    el("div", { className: "type-pills" }, statusPills),
  ]);
  modal.appendChild(diaperStatusGroup);
  modal.appendChild(
    el("div", { className: "form-group" }, [el("label", null, ["Notat"]), noteInput]),
  );

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Lagra"]);
  const cancelBtn = el("button", { className: "btn btn-ghost" }, ["Avbryt"]);

  saveBtn.addEventListener("click", async () => {
    try {
      const result = await postEvents([
        {
          type: "diaper.logged",
          payload: {
            babyId: baby.id,
            time: new Date().toISOString(),
            type: selectedResult,
            amount: selectedResult === "diaper_only" ? null : selectedDiaperStatus,
            note: noteInput.value || undefined,
          },
          clientId: getClientId(),
        },
      ]);
      setAppState(result.state);
      showToast("Dobesøk logga", "success");
      close();
      renderDashboard(container);
    } catch {
      showToast("Klarte ikkje lagra", "error");
    }
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  modal.appendChild(el("div", { className: "btn-row" }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
}

function showWakeUpPanel(baby: Baby, container: HTMLElement): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal" });

  const now = new Date();
  const wakeTimeDt = makeDateTimeInputs(now.toISOString());

  modal.appendChild(el("h2", null, ["☀️ God morgon!"]));
  modal.appendChild(
    el("p", { style: { color: "var(--text-light)", marginBottom: "16px", fontSize: "0.9rem" } }, [
      "Når vakna babyen?",
    ]),
  );
  modal.appendChild(dateTimeGroup("Vaknetid", wakeTimeDt));

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Lagra"]);
  const cancelBtn = el("button", { className: "btn btn-ghost" }, ["Avbryt"]);

  saveBtn.addEventListener("click", async () => {
    const wakeTime = new Date(wakeTimeDt.getValue());
    if (isNaN(wakeTime.getTime())) {
      showToast("Ugyldig tid", "warning");
      return;
    }
    try {
      const result = await postEvents([
        {
          type: "day.started",
          payload: { babyId: baby.id, wakeTime: wakeTime.toISOString() },
          clientId: getClientId(),
        },
      ]);
      setAppState(result.state);
      showToast("Vaknetid sett", "success");
      close();
      renderDashboard(container);
    } catch {
      queueEvent("day.started", { babyId: baby.id, wakeTime: wakeTime.toISOString() });
      showToast("Klarte ikkje lagra", "error");
    }
  });

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  modal.appendChild(el("div", { className: "btn-row" }, [cancelBtn, saveBtn]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.remove();
  }
}

function showMorningPrompt(baby: Baby, container: HTMLElement): void {
  const view = el("div", { className: "view morning-prompt-view" });

  const prompt = el("div", { className: "morning-prompt", "data-testid": "morning-prompt" }, [
    el("div", { className: "morning-icon", "data-testid": "morning-icon" }, ["🌅"]),
    el("h2", null, ["God morgon!"]),
    el("p", null, ["Når vakna babyen i dag?"]),
  ]);

  const now = new Date();
  const wakeTimeDt = makeDateTimeInputs(now.toISOString());

  prompt.appendChild(dateTimeGroup("Vaknetid", wakeTimeDt));

  const saveBtn = el("button", { className: "btn btn-primary" }, ["Sett vaknetid"]);
  const skipBtn = el("button", { className: "btn btn-ghost" }, ["Hopp over"]);

  saveBtn.addEventListener("click", async () => {
    const wakeTime = new Date(wakeTimeDt.getValue());
    if (isNaN(wakeTime.getTime())) {
      showToast("Ugyldig tid", "warning");
      return;
    }

    try {
      const result = await postEvents([
        {
          type: "day.started",
          payload: { babyId: baby.id, wakeTime: wakeTime.toISOString() },
          clientId: getClientId(),
        },
      ]);
      setAppState(result.state);
      showToast("Vaknetid sett", "success");
      renderDashboard(container);
    } catch {
      queueEvent("day.started", { babyId: baby.id, wakeTime: wakeTime.toISOString() });
      showToast("Klarte ikkje lagra vaknetid", "error");
    }
  });

  skipBtn.addEventListener("click", () => {
    // Bypass morning prompt by creating a default wake-up time (6am)
    const earlyMorning = new Date();
    earlyMorning.setHours(6, 0, 0, 0);
    postEvents([
      {
        type: "day.started",
        payload: { babyId: baby.id, wakeTime: earlyMorning.toISOString() },
        clientId: getClientId(),
      },
    ])
      .then((result) => {
        setAppState(result.state);
        renderDashboard(container);
      })
      .catch(() => {
        // If offline, just render dashboard anyway
        renderDashboard(container);
      });
  });

  prompt.appendChild(el("div", { className: "btn-row" }, [skipBtn, saveBtn]));
  view.appendChild(prompt);
  container.appendChild(view);
}
