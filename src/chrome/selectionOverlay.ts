import { createCrosshairHighlighter } from "./crosshairHighlighter";

const OVERLAY_ROOT_ID = "pi-dom-picker-overlay-root";
const MODAL_ROOT_ID = "pi-dom-picker-modal-root";
const UI_ATTRIBUTE = "data-pi-picker-ui";
const Z_INDEX = "2147483646";

export type CommentModalControls = {
  close(): void;
};

export type SelectionOverlayControls = {
  update(target: Element, selected?: boolean): void;
  updatePointer(x: number, y: number): void;
  showCommentModal(options: {
    onSubmit(comment: string): void;
    onCancel(): void;
  }): CommentModalControls;
  cleanup(): void;
};

function getOverlayHost(): HTMLElement {
  return document.body ?? document.documentElement;
}

function applyOverlayStyles(container: HTMLDivElement): void {
  container.id = OVERLAY_ROOT_ID;
  container.setAttribute(UI_ATTRIBUTE, "true");
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.pointerEvents = "none";
  container.style.zIndex = Z_INDEX;
}

function applyControlButtonStyles(button: HTMLButtonElement, variant: "primary" | "secondary"): void {
  button.type = "button";
  button.style.border = variant === "primary" ? "none" : "1px solid rgba(255, 255, 255, 0.12)";
  button.style.borderRadius = "8px";
  button.style.padding = "10px 16px";
  button.style.font = "500 13px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  button.style.cursor = "pointer";
  button.style.pointerEvents = "auto";
  button.style.background = variant === "primary" ? "#6f7f3a" : "rgba(255, 255, 255, 0.08)";
  button.style.color = variant === "primary" ? "#fff" : "#e0e0e0";
  button.style.boxShadow = "none";
  button.style.transition = "background 0.15s, opacity 0.15s";
}

function createModalRoot(): HTMLDivElement {
  const root = document.createElement("div");
  root.id = MODAL_ROOT_ID;
  root.setAttribute(UI_ATTRIBUTE, "true");
  root.style.position = "fixed";
  root.style.inset = "0";
  root.style.display = "grid";
  root.style.placeItems = "center";
  root.style.padding = "16px";
  root.style.background = "rgba(0, 0, 0, 0.4)";
  root.style.zIndex = "2147483647";
  return root;
}

export function createSelectionOverlay(): SelectionOverlayControls {
  const container = document.createElement("div");
  let modalRoot: HTMLDivElement | null = null;
  let modalCleanup: (() => void) | undefined;

  const highlighter = createCrosshairHighlighter({ animate: false });

  applyOverlayStyles(container);

  getOverlayHost().append(container);

  return {
    update(target, selected) {
      highlighter.updateTarget(target, { selected });
    },
    updatePointer(x, y) {
      highlighter.updatePointer(x, y);
    },
    showCommentModal(options) {
      modalCleanup?.();

      const originalOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";

      modalRoot = createModalRoot();
      const panel = document.createElement("div");
      const heading = document.createElement("h2");
      const description = document.createElement("p");
      const textarea = document.createElement("textarea");
      const actions = document.createElement("div");
      const cancelButton = document.createElement("button");
      const sendButton = document.createElement("button");

      panel.setAttribute(UI_ATTRIBUTE, "true");
      panel.style.display = "grid";
      panel.style.gap = "12px";
      panel.style.width = "min(420px, 100%)";
      panel.style.padding = "20px";
      panel.style.border = "1px solid rgba(255, 255, 255, 0.1)";
      panel.style.borderRadius = "12px";
      panel.style.background = "#1f1f1f";
      panel.style.color = "#e8e8e8";
      panel.style.boxShadow = "0 16px 48px rgba(0, 0, 0, 0.4)";
      panel.style.font = "14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

      heading.textContent = "Отправить в Pi";
      heading.style.margin = "0";
      heading.style.font = "600 16px/1.2 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      heading.style.color = "#e8e8e8";

      description.textContent = "Добавьте комментарий (необязательно)";
      description.style.margin = "0";
      description.style.color = "#a0a0a0";
      description.style.fontSize = "13px";

      textarea.rows = 4;
      textarea.placeholder = "Комментарий...";
      textarea.style.width = "100%";
      textarea.style.boxSizing = "border-box";
      textarea.style.padding = "10px 12px";
      textarea.style.border = "1px solid rgba(255, 255, 255, 0.12)";
      textarea.style.borderRadius = "8px";
      textarea.style.background = "#2a2a2a";
      textarea.style.color = "#e8e8e8";
      textarea.style.resize = "vertical";
      textarea.style.font = "14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
      textarea.style.outline = "none";

      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "8px";

      cancelButton.textContent = "Отмена";
      applyControlButtonStyles(cancelButton, "secondary");

      sendButton.textContent = "Отправить в Pi";
      applyControlButtonStyles(sendButton, "primary");

      const close = () => {
        modalCleanup?.();
      };

      const handleCancel = () => {
        close();
        options.onCancel();
      };

      const handleSubmit = () => {
        const comment = textarea.value;
        close();
        options.onSubmit(comment);
      };

      cancelButton.addEventListener("click", handleCancel);
      sendButton.addEventListener("click", handleSubmit);
      textarea.addEventListener("keydown", (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
          event.preventDefault();
          handleSubmit();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          handleCancel();
        }
      });

      // --- Focus trap: Tab / Shift+Tab cycle within modal ---
      panel.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;

        const focusableElements = [textarea, cancelButton, sendButton];
        const firstElement = focusableElements[0];
        const lastElement = focusableElements[focusableElements.length - 1];

        if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault();
          lastElement.focus();
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault();
          firstElement.focus();
        }
      });

      actions.append(cancelButton, sendButton);
      panel.append(heading, description, textarea, actions);
      modalRoot.append(panel);
      getOverlayHost().append(modalRoot);
      textarea.focus();

      modalCleanup = () => {
        if (modalRoot?.isConnected) {
          modalRoot.remove();
        }

        document.body.style.overflow = originalOverflow;

        modalRoot = null;
        modalCleanup = undefined;
      };

      return { close };
    },
    cleanup() {
      modalCleanup?.();

      highlighter.cleanup();

      if (container.isConnected) {
        container.remove();
      }
    },
  };
}

export function isPickerUiElement(target: EventTarget | null): target is Element {
  return target instanceof Element && target.closest(`[${UI_ATTRIBUTE}]`) !== null;
}
