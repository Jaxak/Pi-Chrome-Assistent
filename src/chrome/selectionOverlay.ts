const OVERLAY_ROOT_ID = "pi-dom-picker-overlay-root";
const MODAL_ROOT_ID = "pi-dom-picker-modal-root";
const UI_ATTRIBUTE = "data-pi-picker-ui";
const Z_INDEX = "2147483646";

export type CommentModalControls = {
  close(): void;
};

export type SelectionOverlayControls = {
  update(target: Element): void;
  showCommentModal(options: {
    onSubmit(comment: string): void;
    onCancel(): void;
  }): CommentModalControls;
  cleanup(): void;
};

function applyOverlayStyles(container: HTMLDivElement, box: HTMLDivElement, label: HTMLDivElement): void {
  container.id = OVERLAY_ROOT_ID;
  container.setAttribute(UI_ATTRIBUTE, "true");
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.pointerEvents = "none";
  container.style.zIndex = Z_INDEX;

  box.style.position = "fixed";
  box.style.border = "2px solid #22c55e";
  box.style.borderRadius = "8px";
  box.style.background = "rgba(34, 197, 94, 0.16)";
  box.style.boxShadow = "0 0 0 1px rgba(34, 197, 94, 0.28), 0 12px 30px rgba(6, 78, 59, 0.18)";
  box.style.pointerEvents = "none";

  label.style.position = "fixed";
  label.style.top = "16px";
  label.style.right = "16px";
  label.style.maxWidth = "320px";
  label.style.padding = "10px 12px";
  label.style.borderRadius = "999px";
  label.style.background = "rgba(15, 23, 42, 0.92)";
  label.style.color = "#f8fafc";
  label.style.font = "600 12px/1.4 Inter, system-ui, sans-serif";
  label.style.letterSpacing = "0.01em";
  label.textContent = "Pi picker active • hover to preview • click to send • Esc to cancel";
}

function setBoxFromRect(box: HTMLDivElement, rect: DOMRect): void {
  box.style.top = `${Math.max(0, rect.top)}px`;
  box.style.left = `${Math.max(0, rect.left)}px`;
  box.style.width = `${Math.max(0, rect.width)}px`;
  box.style.height = `${Math.max(0, rect.height)}px`;
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
  root.style.background = "rgba(15, 23, 42, 0.35)";
  root.style.zIndex = "2147483647";
  return root;
}

export function createSelectionOverlay(): SelectionOverlayControls {
  const container = document.createElement("div");
  const highlightBox = document.createElement("div");
  const label = document.createElement("div");
  let modalRoot: HTMLDivElement | null = null;
  let modalCleanup: (() => void) | undefined;

  applyOverlayStyles(container, highlightBox, label);
  container.append(highlightBox, label);
  document.documentElement.append(container);

  return {
    update(target) {
      const rect = target.getBoundingClientRect();
      setBoxFromRect(highlightBox, rect);
    },
    showCommentModal(options) {
      modalCleanup?.();

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
      panel.style.padding = "18px";
      panel.style.border = "1px solid #2c3444";
      panel.style.borderRadius = "14px";
      panel.style.background = "#111827";
      panel.style.color = "#f8fafc";
      panel.style.boxShadow = "0 24px 60px rgba(2, 6, 23, 0.35)";
      panel.style.font = "14px/1.45 Inter, system-ui, sans-serif";

      heading.textContent = "Send element to Pi";
      heading.style.margin = "0";
      heading.style.font = "700 18px/1.2 Inter, system-ui, sans-serif";

      description.textContent = "Add an optional comment for Pi before sending this page fragment.";
      description.style.margin = "0";
      description.style.color = "#cbd5e1";

      textarea.rows = 5;
      textarea.placeholder = "Optional comment";
      textarea.style.width = "100%";
      textarea.style.boxSizing = "border-box";
      textarea.style.padding = "10px 12px";
      textarea.style.border = "1px solid #334155";
      textarea.style.borderRadius = "10px";
      textarea.style.background = "#0f172a";
      textarea.style.color = "#f8fafc";
      textarea.style.resize = "vertical";

      actions.style.display = "flex";
      actions.style.justifyContent = "flex-end";
      actions.style.gap = "8px";

      cancelButton.type = "button";
      cancelButton.textContent = "Cancel";
      cancelButton.style.border = "0";
      cancelButton.style.borderRadius = "10px";
      cancelButton.style.padding = "10px 14px";
      cancelButton.style.background = "#334155";
      cancelButton.style.color = "#f8fafc";
      cancelButton.style.cursor = "pointer";

      sendButton.type = "button";
      sendButton.textContent = "Send";
      sendButton.style.border = "0";
      sendButton.style.borderRadius = "10px";
      sendButton.style.padding = "10px 14px";
      sendButton.style.background = "#5a7cff";
      sendButton.style.color = "#ffffff";
      sendButton.style.cursor = "pointer";

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
      });

      actions.append(cancelButton, sendButton);
      panel.append(heading, description, textarea, actions);
      modalRoot.append(panel);
      document.documentElement.append(modalRoot);
      textarea.focus();

      modalCleanup = () => {
        if (modalRoot?.isConnected) {
          modalRoot.remove();
        }

        modalRoot = null;
        modalCleanup = undefined;
      };

      return { close };
    },
    cleanup() {
      modalCleanup?.();

      if (container.isConnected) {
        container.remove();
      }
    },
  };
}

export function isPickerUiElement(target: EventTarget | null): target is Element {
  return target instanceof Element && target.closest(`[${UI_ATTRIBUTE}]`) !== null;
}
