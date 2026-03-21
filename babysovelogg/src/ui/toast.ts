const TOAST_STYLES = `
.toast-container {
  position: fixed;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  padding: 12px 20px;
  border-radius: 12px;
  font-size: 0.9rem;
  font-weight: 500;
  color: white;
  animation: toast-in 0.3s ease, toast-out 0.3s ease 2.7s forwards;
  pointer-events: auto;
  max-width: 90vw;
  text-align: center;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
.toast.error { background: #e74c3c; }
.toast.warning { background: #f39c12; }
.toast.success { background: #27ae60; }
.toast.info { background: #3498db; }
@keyframes toast-in { from { opacity: 0; transform: translateY(-12px); } to { opacity: 1; transform: translateY(0); } }
@keyframes toast-out { from { opacity: 1; } to { opacity: 0; } }
`;

let container: HTMLElement | null = null;
let stylesInjected = false;

function ensureContainer(): HTMLElement {
  if (!stylesInjected) {
    const style = document.createElement("style");
    style.textContent = TOAST_STYLES;
    document.head.appendChild(style);
    stylesInjected = true;
  }
  if (!container || !document.body.contains(container)) {
    container = document.createElement("div");
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(
  message: string,
  type: "error" | "warning" | "success" | "info" = "info",
): void {
  const c = ensureContainer();
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  c.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

/** Styled confirm dialog replacement for native confirm(). Returns a Promise<boolean>. */
export function showConfirm(
  message: string,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.alignItems = "center";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.style.borderRadius = "16px";
    modal.style.maxWidth = "340px";
    modal.style.textAlign = "center";

    const msg = document.createElement("p");
    msg.textContent = message;
    msg.style.fontSize = "1rem";
    msg.style.marginBottom = "20px";
    msg.style.lineHeight = "1.5";
    modal.appendChild(msg);

    const btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "btn btn-ghost";
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.flex = "1";

    const confirmBtn = document.createElement("button");
    confirmBtn.className = "btn btn-danger";
    confirmBtn.textContent = confirmLabel;
    confirmBtn.style.flex = "1";

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    modal.appendChild(btnRow);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function close(result: boolean) {
      overlay.remove();
      resolve(result);
    }
    cancelBtn.addEventListener("click", () => close(false));
    confirmBtn.addEventListener("click", () => close(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) close(false);
    });
    document.addEventListener("keydown", function handler(e) {
      if (e.key === "Escape") {
        close(false);
        document.removeEventListener("keydown", handler);
      }
    });
  });
}
