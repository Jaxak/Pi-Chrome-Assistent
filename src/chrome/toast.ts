const TOAST_ROOT_ID = "pi-dom-picker-toast-root";
const TOAST_Z_INDEX = "2147483647";

type ToastKind = "success" | "error";

function getToastRoot(): HTMLDivElement {
  const existingRoot = document.getElementById(TOAST_ROOT_ID);

  if (existingRoot instanceof HTMLDivElement) {
    return existingRoot;
  }

  const root = document.createElement("div");
  root.id = TOAST_ROOT_ID;
  root.style.position = "fixed";
  root.style.top = "16px";
  root.style.right = "16px";
  root.style.display = "grid";
  root.style.gap = "8px";
  root.style.maxWidth = "320px";
  root.style.pointerEvents = "none";
  root.style.zIndex = TOAST_Z_INDEX;
  document.documentElement.append(root);
  return root;
}

export function showToast(message: string, kind: ToastKind = "success"): () => void {
  const root = getToastRoot();
  const toast = document.createElement("div");
  const background = kind === "success" ? "rgba(111, 127, 58, 0.96)" : "rgba(178, 86, 74, 0.96)";
  const border = kind === "success" ? "1px solid rgba(220, 227, 193, 0.88)" : "1px solid rgba(240, 204, 196, 0.88)";
  const shadow = kind === "success" ? "0 12px 30px rgba(78, 87, 39, 0.2)" : "0 12px 30px rgba(120, 56, 46, 0.2)";

  toast.textContent = message;
  toast.style.padding = "10px 12px";
  toast.style.borderRadius = "10px";
  toast.style.border = border;
  toast.style.background = background;
  toast.style.color = "#f8faf0";
  toast.style.font = "600 13px/1.4 Inter, system-ui, sans-serif";
  toast.style.boxShadow = shadow;
  toast.style.pointerEvents = "none";

  root.append(toast);

  const cleanup = () => {
    if (toast.isConnected) {
      toast.remove();
    }

    if (root.childElementCount === 0) {
      root.remove();
    }
  };

  window.setTimeout(cleanup, 2200);

  return cleanup;
}
