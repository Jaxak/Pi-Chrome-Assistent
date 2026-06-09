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
  const background = kind === "success" ? "rgba(8, 145, 105, 0.96)" : "rgba(185, 28, 28, 0.96)";

  toast.textContent = message;
  toast.style.padding = "10px 12px";
  toast.style.borderRadius = "10px";
  toast.style.background = background;
  toast.style.color = "#ffffff";
  toast.style.font = "600 13px/1.4 Inter, system-ui, sans-serif";
  toast.style.boxShadow = "0 12px 30px rgba(15, 23, 42, 0.25)";
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
