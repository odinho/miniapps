import { getAppState, setAppState } from "../main.js";
import { postEvents } from "../api.js";
import {
  queueEvent,
  getClientId,
  applyOptimisticEvent,
  hasPendingEvents,
  applyQueuedEvents,
  isServerOffline,
  getPendingCount,
} from "../sync.js";
import { generateSleepId, generateDiaperId } from "../identity.js";
import {
  classifySleepType,
  classifySleepTypeByHour,
  calcPauseMs,
} from "../engine/classification.js";
import {
  el,
  formatAge,
  formatDuration,
  renderTimerWithPauses,
  renderCountdown,
  formatTime,
  haptic,
} from "./components.js";
import { showToast, showUndoToast } from "./toast.js";
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

/** Send event optimistically — if offline, queue it, apply optimistic update, and show a toast. Returns true if online. */
async function sendEvent(type: string, payload: Record<string, unknown>): Promise<boolean> {
  try {
    const result = await postEvents([{ type, payload, clientId: getClientId() }]);
    // Server state may not include other queued offline events — reapply them
    const effective = hasPendingEvents() ? applyQueuedEvents(result.state) : result.state;
    setAppState(effective);
    return true;
  } catch {
    queueEvent(type, payload);
    // Apply optimistic update to local state so UI reflects the change immediately
    const state = getAppState();
    if (state) {
      setAppState(applyOptimisticEvent(state, type, payload));
    }
    showToast("Lagra offline — synkar snart", "warning");
    return false;
  }
}

let cleanups: (() => void)[] = [];

function buildSyncBadge(): HTMLElement {
  const pending = getPendingCount();
  const isOffline = isServerOffline();

  if (isOffline) {
    const badge = el(
      "span",
      {
        className: "sync-badge sync-badge-offline",
        "data-testid": "sync-badge",
      },
      ["offline"],
    );
    badge.addEventListener("click", () => {
      window.location.hash = "#/events";
    });
    return badge;
  }

  if (pending > 0) {
    const badge = el(
      "span",
      {
        className: "sync-badge sync-badge-pending",
        "data-testid": "sync-badge",
      },
      [`${pending} ventande`],
    );
    badge.addEventListener("click", () => {
      window.location.hash = "#/events";
    });
    return badge;
  }

  // Connected, no pending — small green dot
  const badge = el("span", {
    className: "sync-badge sync-badge-ok",
    "data-testid": "sync-badge",
  });
  return badge;
}

// Track dismissed predicted naps (resets daily)
const DISMISSED_KEY = "babysovelogg_dismissed_predictions";
const MORNING_DISMISSED_KEY = "babysovelogg_morning_dismissed";

function dismissMorning(): void {
  sessionStorage.setItem(MORNING_DISMISSED_KEY, new Date().toISOString().slice(0, 10));
}

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

  const { baby, activeSleep, todaySleeps, stats, prediction, ageMonths, diaperCount, todayWakeUp } =
    state;

  // Show morning prompt if no wake-up time set and no sleeps today
  // But only during morning hours (5-11), not in the middle of the night
  // Use sessionStorage flag to prevent re-showing after user has already set wake time
  const currentHourForPrompt = new Date().getHours();
  const isMorningTime = currentHourForPrompt >= 5 && currentHourForPrompt < 12;
  const morningDismissed = sessionStorage.getItem(MORNING_DISMISSED_KEY) === new Date().toISOString().slice(0, 10);
  if (!todayWakeUp && todaySleeps.length === 0 && !activeSleep && isMorningTime && !morningDismissed) {
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

  // Sync status badge
  const syncBadge = buildSyncBadge();

  dash.appendChild(
    el("div", { className: "header-row" }, [
      el("div", { className: "baby-info" }, [
        el("span", { className: "baby-name", "data-testid": "baby-name" }, [baby.name]),
        el("span", { className: "baby-age", "data-testid": "baby-age" }, [
          formatAge(baby.birthdate),
        ]),
        syncBadge,
      ]),
      btn,
    ]),
  );

  btn.addEventListener("click", async () => {
    haptic();
    if (isSleeping && activeSleep) {
      // End sleep — save immediately, then show optional wake-up sheet
      // Get fresh sleep data with any tags set after start (via tag sheet)
      const currentState = getAppState();
      const sleepSnapshot = currentState?.activeSleep
        ? { ...currentState.activeSleep }
        : { ...activeSleep };
      const endTimeIso = new Date().toISOString();
      await sendEvent("sleep.ended", {
        sleepDomainId: activeSleep.domain_id,
        endTime: endTimeIso,
      });
      renderDashboard(container);
      showWakeUpSheet(activeSleep.domain_id, sleepSnapshot, endTimeIso, container);
      const domainId = activeSleep.domain_id;
      showUndoToast("Søvn avslutta", async () => {
        await sendEvent("sleep.updated", { sleepDomainId: domainId, endTime: null });
        renderDashboard(container);
      });
    } else {
      // Start sleep — then show bedtime tag sheet
      const type = classifySleepType(todaySleeps, ageMonths, baby.custom_nap_count);
      const sleepDomainId = generateSleepId();
      const startTimeIso = new Date().toISOString();
      await sendEvent("sleep.started", {
        babyId: baby.id,
        startTime: startTimeIso,
        type,
        sleepDomainId,
      });
      renderDashboard(container);
      // Show tag sheet using the domain ID we just generated
      showTagSheet(sleepDomainId, startTimeIso, container);
      showUndoToast("Søvn starta", async () => {
        await sendEvent("sleep.deleted", { sleepDomainId });
        renderDashboard(container);
      });
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
        ? { sleepDomainId: activeSleep.domain_id, resumeTime: new Date().toISOString() }
        : { sleepDomainId: activeSleep.domain_id, pauseTime: new Date().toISOString() };
      await sendEvent(eventType, payload);
      renderDashboard(container);
    });
    dash.appendChild(pauseBtn);
  }

  // Callbacks invoked by the unified 60s dashboard tick (arc, awake timer, etc.)
  const tickCallbacks: (() => void)[] = [];

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
      ? { start_time: activeSleep.start_time, type: activeSleep.type as "nap" | "night", isPaused, pauseTime: isPaused ? pauses[pauses.length - 1]?.pause_time : undefined }
      : null,
    prediction: filteredPrediction,
    isNightMode,
    wakeUpTime: todayWakeUp?.wake_time,
    startTimeLabel: isNightMode
      ? activeSleep?.type === "night"
        ? formatTime(activeSleep.start_time)
        : prediction?.bedtime
          ? "~" + formatTime(prediction.bedtime)
          : null
      : todayWakeUp?.wake_time
        ? formatTime(todayWakeUp.wake_time)
        : null,
    endTimeLabel: isNightMode
      ? todayWakeUp?.wake_time
        ? "~" + formatTime(todayWakeUp.wake_time)
        : null
      : prediction?.bedtime
        ? "~" + formatTime(prediction.bedtime)
        : null,
    onSleepClick: (index: number) => {
      const sleep = todaySleeps[index];
      if (sleep) showEditModal(sleep, container);
    },
    onStartClick: () => {
      if (isNightMode) {
        // Night start = find the night sleep entry, or start bedtime
        const nightSleep = todaySleeps.find((s) => s.type === "night");
        if (nightSleep) {
          showEditModal(nightSleep, container);
        } else if (!activeSleep) {
          // No night sleep yet — start bedtime
          const sleepDomainId = generateSleepId();
          const startTimeIso = new Date().toISOString();
          sendEvent("sleep.started", {
            babyId: baby.id,
            startTime: startTimeIso,
            type: "night",
            sleepDomainId,
          }).then(() => renderDashboard(container));
        }
      } else {
        // Day start = wake-up time, allow editing
        showWakeUpPanel(baby, container);
      }
    },
    onEndClick: () => {
      if (isNightMode) {
        // Night end = morning wake-up, but only show in the small hours (B17)
        const endClickHour = new Date().getHours();
        if (endClickHour < 12) {
          showWakeUpPanel(baby, container);
        }
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

  // Refresh arc SVG (shows current time marker, growing sleep pill, etc.)
  const refreshArc = () => {
    const freshSvg = renderArc({
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
        ? activeSleep?.type === "night"
          ? formatTime(activeSleep.start_time)
          : prediction?.bedtime
            ? "~" + formatTime(prediction.bedtime)
            : null
        : todayWakeUp?.wake_time
          ? formatTime(todayWakeUp.wake_time)
          : null,
      endTimeLabel: isNightMode
        ? todayWakeUp?.wake_time
          ? "~" + formatTime(todayWakeUp.wake_time)
          : null
        : prediction?.bedtime
          ? "~" + formatTime(prediction.bedtime)
          : null,
    });
    const oldSvg = arcContainer.querySelector(".sleep-arc");
    if (oldSvg) oldSvg.replaceWith(freshSvg);
  };
  // Arc always updates on tick (shows current time marker even when awake)
  tickCallbacks.push(refreshArc);

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
      const showBedtime = prediction.napsAllDone || isEvening;

      if (showBedtime && prediction?.bedtime) {
        // Naps done, evening, or past nap time — show bedtime countdown
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
      } else {
        // B11: Nap time has passed but baby didn't sleep — show overtime
        const overtimeMs = now.getTime() - nextNapTime.getTime();
        arcCenter.appendChild(el("div", { className: "arc-center-label" }, ["Overtid"]));
        arcCenter.appendChild(
          el("span", { className: "countdown-value" }, [`+${formatDuration(overtimeMs)}`]),
        );
      }

      // Show "awake since" info (only if wake time is in the past)
      const lastSleep = todaySleeps.find((s) => s.end_time);
      const awakeSince = lastSleep?.end_time || todayWakeUp?.wake_time;
      if (awakeSince) {
        const awakeSinceMs = new Date(awakeSince).getTime();
        const awakeMs = now.getTime() - awakeSinceMs;
        if (awakeMs > 60000) {
          const awakeEl = el(
            "div",
            {
              className: "edit-start-link",
              style: { textDecoration: "none", cursor: "default", pointerEvents: "auto" },
            },
            [`Vaken ${formatDuration(awakeMs)}`],
          );
          // Updated by the unified dashboardTick below
          tickCallbacks.push(() => {
            awakeEl.textContent = `Vaken ${formatDuration(Date.now() - awakeSinceMs)}`;
          });
          arcCenter.appendChild(awakeEl);
        }
      }
    }
  }

  arcContainer.appendChild(arcCenter);

  // Action buttons in the arc gap
  const arcActions = el("div", { className: "arc-actions" });

  // Diaper/potty button — always available in all states
  const isPottyMode = baby.potty_mode === 1;
  const makeDiaperBtn = () => {
    const diaperBtn = el("button", { className: "arc-action-btn diaper" }, [
      isPottyMode ? "🚽 Do" : "🧷 Bleie",
    ]);
    diaperBtn.addEventListener("click", () =>
      isPottyMode ? showPottyModal(baby, container) : showDiaperModal(baby, container),
    );
    return diaperBtn;
  };

  if (isNightMode) {
    if (isSleeping) {
      // During active night sleep: pause + diaper
      const pauseActionBtn = el("button", { className: "arc-action-btn night" }, [
        isPaused ? "▶️ Fortset" : "⏸️ Pause",
      ]);
      pauseActionBtn.addEventListener("click", async () => {
        const eventType = isPaused ? "sleep.resumed" : "sleep.paused";
        const payload = isPaused
          ? { sleepDomainId: activeSleep!.domain_id, resumeTime: new Date().toISOString() }
          : { sleepDomainId: activeSleep!.domain_id, pauseTime: new Date().toISOString() };
        await sendEvent(eventType, payload);
        renderDashboard(container);
      });
      arcActions.appendChild(pauseActionBtn);
      arcActions.appendChild(makeDiaperBtn());
    } else {
      // Night, not sleeping: night waking + (maybe morning) + diaper
      const nightBtn = el("button", { className: "arc-action-btn night" }, ["🌙 Nattevaking"]);
      nightBtn.addEventListener("click", async () => {
        await sendEvent("sleep.started", {
          babyId: baby.id,
          startTime: new Date().toISOString(),
          type: "night",
          sleepDomainId: generateSleepId(),
        });
        renderDashboard(container);
      });
      arcActions.appendChild(nightBtn);
      // B17: Only show morning button in the small hours (midnight–12),
      // not right after bedtime (18–24) when it makes no sense
      const currentHourForMorning = new Date().getHours();
      if (currentHourForMorning < 12) {
        const morningBtn = el("button", { className: "arc-action-btn morning" }, ["☀️ Morgon"]);
        morningBtn.addEventListener("click", () => showWakeUpPanel(baby, container));
        arcActions.appendChild(morningBtn);
      }
      arcActions.appendChild(makeDiaperBtn());
    }
  } else {
    if (isSleeping) {
      // Sleeping during day: pause + diaper
      const pauseActionBtn = el("button", { className: "arc-action-btn nap" }, [
        isPaused ? "▶️ Fortset" : "⏸️ Pause",
      ]);
      pauseActionBtn.addEventListener("click", async () => {
        const eventType = isPaused ? "sleep.resumed" : "sleep.paused";
        const payload = isPaused
          ? { sleepDomainId: activeSleep!.domain_id, resumeTime: new Date().toISOString() }
          : { sleepDomainId: activeSleep!.domain_id, pauseTime: new Date().toISOString() };
        await sendEvent(eventType, payload);
        renderDashboard(container);
      });
      arcActions.appendChild(pauseActionBtn);
      arcActions.appendChild(makeDiaperBtn());
    } else {
      // Daytime, awake: nap + diaper
      const napBtn = el("button", { className: "arc-action-btn nap" }, ["😴 Lur"]);
      napBtn.addEventListener("click", async () => {
        const sleepDomainId = generateSleepId();
        const startTimeIso = new Date().toISOString();
        await sendEvent("sleep.started", {
          babyId: baby.id,
          startTime: startTimeIso,
          type: "nap",
          sleepDomainId,
        });
        renderDashboard(container);
        showTagSheet(sleepDomainId, startTimeIso, container);
      });
      arcActions.appendChild(napBtn);
      arcActions.appendChild(makeDiaperBtn());
    }
  }
  dash.appendChild(arcContainer);

  // Today's stats
  if (stats) {
    const napCountEl = el("div", { className: "stat-value" });
    const napTimeEl = el("div", { className: "stat-value" });
    const totalSleepEl = el("div", { className: "stat-value" });

    const totalSep = el("span", { className: "summary-sep" }, ["·"]);
    const totalSpan = el("span", null, [
      totalSleepEl,
      el("span", { className: "summary-label" }, [" totalt"]),
    ]);

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

      // Hide "totalt" when it matches nap time (no night sleep contributing)
      const showTotal = Math.round(totalMinutes) !== Math.round(napMinutes);
      totalSep.style.display = showTotal ? "" : "none";
      totalSpan.style.display = showTotal ? "" : "none";
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

    const summaryChildren: (Node | string)[] = [
      el("span", null, [napCountEl, napLabel]),
      el("span", { className: "summary-sep" }, ["·"]),
      el("span", null, [napTimeEl, el("span", { className: "summary-label" }, [" lurtid"])]),
      totalSep,
      totalSpan,
    ];

    // Diaper/potty count
    const dc = diaperCount ?? 0;
    if (dc > 0) {
      const diaperLabel = isPottyMode ? " dobesøk" : dc === 1 ? " bleie" : " bleier";
      const diaperCountEl = el("div", { className: "stat-value" }, [String(dc)]);
      summaryChildren.push(el("span", { className: "summary-sep" }, ["·"]));
      summaryChildren.push(el("span", null, [diaperCountEl, el("span", { className: "summary-label" }, [diaperLabel])]));
    }

    const summaryRow = el("div", { className: "summary-row" }, summaryChildren);
    dash.appendChild(summaryRow);
  }

  // Action buttons - below stats, in the big open space
  dash.appendChild(arcActions);

  // Unified 60s tick — drives all time-dependent UI (arc marker, awake timer, etc.)
  if (tickCallbacks.length > 0) {
    const dashTick = setInterval(() => {
      for (const cb of tickCallbacks) cb();
    }, 60000);
    cleanups.push(() => clearInterval(dashTick));
  }

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

export function showManualSleepModal(baby: Baby, container: HTMLElement): void {
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

    const online = await sendEvent("sleep.manual", {
      babyId: baby.id,
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      type: selectedType,
      sleepDomainId: generateSleepId(),
    });
    if (online) showToast("Søvn lagt til", "success");
    close();
    renderDashboard(container);
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
    const online = await sendEvent("sleep.updated", {
      sleepDomainId: activeSleep.domain_id,
      startTime: start.toISOString(),
    });
    if (online) showToast("Starttid oppdatert", "success");
    close();
    renderDashboard(container);
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

function showTagSheet(
  sleepDomainId: string,
  recordedStartTime: string,
  container: HTMLElement,
): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal tag-sheet" });

  let selectedMood: string | null = null;
  let selectedMethod: string | null = null;
  let selectedFallAsleep: string | null = null;

  modal.appendChild(el("h2", null, ["Korleis gjekk legginga?"]));

  // Quick-adjust start time with nudge buttons
  let adjustedStartTime = new Date(recordedStartTime);
  const startTimeDisplay = el("span", { className: "wake-time-display" }, [
    formatTime(adjustedStartTime),
  ]);

  function nudgeStart(minutes: number) {
    adjustedStartTime = new Date(adjustedStartTime.getTime() + minutes * 60000);
    startTimeDisplay.textContent = formatTime(adjustedStartTime);
  }

  const sm1Btn = el("button", { className: "btn btn-ghost nudge-btn" }, ["-1"]);
  const sm5Btn = el("button", { className: "btn btn-ghost nudge-btn" }, ["-5"]);
  sm1Btn.addEventListener("click", () => nudgeStart(-1));
  sm5Btn.addEventListener("click", () => nudgeStart(-5));

  const startFullDt = makeDateTimeInputs(recordedStartTime);
  const startFullWrap = el(
    "div",
    {
      className: "form-group",
      style: { display: "none", marginTop: "8px" },
    },
    [dateTimeGroup("", startFullDt)],
  );

  const startEditLink = el(
    "span",
    {
      className: "edit-start-link",
      style: { fontSize: "0.8rem", marginLeft: "8px" },
    },
    ["endra"],
  );
  const startTimeRow = el("div", { className: "wake-time-row" }, [
    el("span", { style: { color: "var(--text-light)", fontSize: "0.85rem" } }, ["La seg "]),
    startTimeDisplay,
    sm1Btn,
    sm5Btn,
    startEditLink,
  ]);
  startEditLink.addEventListener("click", () => {
    startFullDt.dateInput.value = toLocalDate(adjustedStartTime.toISOString());
    startFullDt.timeInput.value = toLocalTime(adjustedStartTime.toISOString());
    startFullWrap.style.display = "";
    startTimeRow.style.display = "none";
  });

  modal.appendChild(startTimeRow);
  modal.appendChild(startFullWrap);

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

  // Diaper/potty nudge: remind if no activity recently (1h potty, 2h diaper)
  const appState = getAppState();
  const lastDiaper = appState?.lastDiaperTime;
  const isPotty = appState?.baby?.potty_mode === 1;
  const nudgeMs = isPotty ? 1 * 3600000 : 2 * 3600000;
  const nudgeThreshold = Date.now() - nudgeMs;
  if (!lastDiaper || new Date(lastDiaper).getTime() < nudgeThreshold) {
    const nudgeHours = isPotty ? "1 time" : "2 timar";
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
      [
        isPotty
          ? `🚽 Ikkje vore på do den siste ${nudgeHours}`
          : `🧷 Inga bleie dei siste ${nudgeHours}`,
      ],
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

    // Check if start time was adjusted
    const fullPickerVisible = startFullWrap.style.display !== "none";
    const finalStartTime = fullPickerVisible ? new Date(startFullDt.getValue()) : adjustedStartTime;
    const startTimeChanged =
      !isNaN(finalStartTime.getTime()) &&
      Math.abs(finalStartTime.getTime() - new Date(recordedStartTime).getTime()) > 30000;

    if (startTimeChanged) {
      await sendEvent("sleep.updated", {
        sleepDomainId,
        startTime: finalStartTime.toISOString(),
      });
    }

    if (selectedMood || selectedMethod || selectedFallAsleep || noteInput.value.trim()) {
      await sendEvent("sleep.tagged", {
        sleepDomainId,
        mood: selectedMood,
        method: selectedMethod,
        fallAsleepTime: selectedFallAsleep,
        notes: noteInput.value.trim() || undefined,
      });
    }

    if (startTimeChanged) renderDashboard(container);
  }
}

function showWakeUpSheet(
  sleepDomainId: string,
  sleepData: SleepLogRow,
  recordedEndTime: string,
  container: HTMLElement,
): void {
  const overlay = el("div", { className: "modal-overlay", "data-testid": "modal-overlay" });
  const modal = el("div", { className: "modal tag-sheet" });

  modal.appendChild(el("h2", null, ["Oppvakning"]));

  // Quick-adjust end time — show time with -1/-5 nudge buttons
  let adjustedEndTime = new Date(recordedEndTime);
  const timeDisplay = el("span", { className: "wake-time-display" }, [formatTime(adjustedEndTime)]);

  function nudgeTime(minutes: number) {
    adjustedEndTime = new Date(adjustedEndTime.getTime() + minutes * 60000);
    timeDisplay.textContent = formatTime(adjustedEndTime);
  }

  const minus1Btn = el("button", { className: "btn btn-ghost nudge-btn" }, ["-1"]);
  const minus5Btn = el("button", { className: "btn btn-ghost nudge-btn" }, ["-5"]);
  minus1Btn.addEventListener("click", () => nudgeTime(-1));
  minus5Btn.addEventListener("click", () => nudgeTime(-5));

  // Expandable full date/time picker for bigger adjustments
  const endTimeDt = makeDateTimeInputs(recordedEndTime);
  const fullPickerWrap = el(
    "div",
    {
      className: "form-group",
      style: { display: "none", marginTop: "8px" },
    },
    [dateTimeGroup("", endTimeDt)],
  );

  const editLink = el(
    "span",
    {
      className: "edit-start-link",
      style: { fontSize: "0.8rem", marginLeft: "8px" },
    },
    ["endra"],
  );
  editLink.addEventListener("click", () => {
    // Sync the full picker with the nudged time
    endTimeDt.dateInput.value = toLocalDate(adjustedEndTime.toISOString());
    endTimeDt.timeInput.value = toLocalTime(adjustedEndTime.toISOString());
    fullPickerWrap.style.display = "";
    wakeTimeRow.style.display = "none";
  });

  const wakeTimeRow = el(
    "div",
    {
      className: "wake-time-row",
    },
    [
      el("span", { style: { color: "var(--text-light)", fontSize: "0.85rem" } }, ["Vakna "]),
      timeDisplay,
      minus1Btn,
      minus5Btn,
      editLink,
    ],
  );

  modal.appendChild(wakeTimeRow);
  modal.appendChild(fullPickerWrap);

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

    const editBedtimeLink = el(
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
            editBedtimeLink,
          ],
        ),
        ...summaryChildren,
      ],
    );

    summaryCard.addEventListener("click", () => {
      close();
      // Find the sleep entry in todaySleeps for the full edit modal
      const state = getAppState();
      const entry = state?.todaySleeps?.find((s) => s.domain_id === sleepDomainId);
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
    // Use full picker if expanded, otherwise use nudged time
    const fullPickerVisible = fullPickerWrap.style.display !== "none";
    const finalEndTime = fullPickerVisible ? new Date(endTimeDt.getValue()) : adjustedEndTime;
    const endTimeChanged =
      !isNaN(finalEndTime.getTime()) &&
      Math.abs(finalEndTime.getTime() - new Date(recordedEndTime).getTime()) > 30000;

    if (wokeBy || noteInput.value.trim() || endTimeChanged) {
      const payload: Record<string, unknown> = { sleepDomainId };
      if (wokeBy) payload.wokeBy = wokeBy;
      if (noteInput.value.trim()) payload.wakeNotes = noteInput.value.trim();
      if (endTimeChanged) payload.endTime = finalEndTime.toISOString();
      await sendEvent("sleep.updated", payload);
      if (endTimeChanged) renderDashboard(container);
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
    const diaperDomainId = generateDiaperId();
    const online = await sendEvent("diaper.logged", {
      babyId: baby.id,
      time: time.toISOString(),
      type: selectedType,
      amount: selectedAmount,
      note: noteInput.value || undefined,
      diaperDomainId,
    });
    close();
    renderDashboard(container);
    if (online) {
      showUndoToast("Bleie logga", async () => {
        await sendEvent("diaper.deleted", { diaperDomainId });
        renderDashboard(container);
      });
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
    const sleepDomainId = generateSleepId();
    const startTimeIso = new Date().toISOString();
    await sendEvent("sleep.started", {
      babyId: baby.id,
      startTime: startTimeIso,
      type: "nap",
      sleepDomainId,
    });
    renderDashboard(container);
    showTagSheet(sleepDomainId, startTimeIso, container);
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
    { value: "diaper_only", label: "🧷 Berre bleie" },
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
      updateDiaperStatusVisibility();
    });
    return pill;
  });

  let selectedDiaperStatus = "dry";
  const statuses = [
    { value: "dry", label: "Tørr ✨" },
    { value: "damp", label: "Litt våt 💧" },
    { value: "wet", label: "Våt 💧💧" },
    { value: "dirty", label: "Skitten 💩" },
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

  const timeDt = makeDateTimeInputs(new Date().toISOString());

  modal.appendChild(el("h2", null, ["Logg dobesøk"]));
  modal.appendChild(
    el("div", { className: "form-group" }, [
      el("label", null, ["Resultat"]),
      el("div", { className: "type-pills diaper-type-pills" }, resultPills),
    ]),
  );

  const diaperStatusLabel = el("label", null, ["Bleie"]);
  const diaperStatusGroup = el("div", { className: "form-group" }, [
    diaperStatusLabel,
    el("div", { className: "type-pills" }, statusPills),
  ]);
  function updateDiaperStatusVisibility() {
    if (selectedResult === "diaper_only") {
      diaperStatusLabel.textContent = "Innhald i bleie";
    } else {
      diaperStatusLabel.textContent = "Bleie";
    }
  }
  modal.appendChild(diaperStatusGroup);
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
    const diaperDomainId = generateDiaperId();
    const online = await sendEvent("diaper.logged", {
      babyId: baby.id,
      time: time.toISOString(),
      type: selectedResult,
      amount: selectedDiaperStatus,
      note: noteInput.value || undefined,
      diaperDomainId,
    });
    close();
    renderDashboard(container);
    if (online) {
      showUndoToast("Dobesøk logga", async () => {
        await sendEvent("diaper.deleted", { diaperDomainId });
        renderDashboard(container);
      });
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
    const online = await sendEvent("day.started", {
      babyId: baby.id,
      wakeTime: wakeTime.toISOString(),
    });
    if (online) showToast("Vaknetid sett", "success");
    close();
    renderDashboard(container);
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
    dismissMorning();
    const online = await sendEvent("day.started", {
      babyId: baby.id,
      wakeTime: wakeTime.toISOString(),
    });
    if (online) showToast("Vaknetid sett", "success");
    renderDashboard(container);
  });

  skipBtn.addEventListener("click", async () => {
    // Bypass morning prompt by creating a default wake-up time (6am)
    dismissMorning();
    const earlyMorning = new Date();
    earlyMorning.setHours(6, 0, 0, 0);
    await sendEvent("day.started", {
      babyId: baby.id,
      wakeTime: earlyMorning.toISOString(),
    });
    renderDashboard(container);
  });

  prompt.appendChild(el("div", { className: "btn-row" }, [skipBtn, saveBtn]));
  view.appendChild(prompt);
  container.appendChild(view);
}
