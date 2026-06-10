const OVERLAY_ROOT_ID = "pi-dom-picker-overlay-root";
const MODAL_ROOT_ID = "pi-dom-picker-modal-root";
const UI_ATTRIBUTE = "data-pi-picker-ui";
const Z_INDEX = "2147483646";

export type CommentModalControls = {
  close(): void;
};

export type SelectionOverlayControls = {
  update(target: Element): void;
  setNavigationState(state: { canNarrow: boolean; canWiden: boolean }): void;
  showCommentModal(options: {
    onSubmit(comment: string): void;
    onCancel(): void;
  }): CommentModalControls;
  cleanup(): void;
};

function getOverlayHost(): HTMLElement {
  return document.body ?? document.documentElement;
}

function applyOverlayStyles(
  container: HTMLDivElement,
  box: HTMLDivElement,
  panel: HTMLDivElement,
  label: HTMLHeadingElement,
  description: HTMLParagraphElement,
): void {
  container.id = OVERLAY_ROOT_ID;
  container.setAttribute(UI_ATTRIBUTE, "true");
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.pointerEvents = "none";
  container.style.zIndex = Z_INDEX;

  box.style.position = "fixed";
  box.style.border = "2px solid #6f7f3a";
  box.style.borderRadius = "8px";
  box.style.background = "rgba(111, 127, 58, 0.18)";
  box.style.boxShadow = "0 0 0 1px rgba(111, 127, 58, 0.28), 0 12px 30px rgba(78, 87, 39, 0.18)";
  box.style.pointerEvents = "none";

  panel.setAttribute(UI_ATTRIBUTE, "true");
  panel.style.position = "fixed";
  panel.style.top = "16px";
  panel.style.right = "16px";
  panel.style.display = "grid";
  panel.style.gap = "10px";
  panel.style.width = "min(320px, calc(100vw - 32px))";
  panel.style.padding = "12px";
  panel.style.borderRadius = "14px";
  panel.style.border = "1px solid #c4cca8";
  panel.style.background = "rgba(248, 250, 240, 0.96)";
  panel.style.color = "#2f361c";
  panel.style.boxShadow = "0 20px 48px rgba(78, 87, 39, 0.18)";
  panel.style.pointerEvents = "auto";
  panel.style.font = "13px/1.45 Inter, system-ui, sans-serif";

  label.style.margin = "0";
  label.style.font = "700 14px/1.2 Inter, system-ui, sans-serif";
  label.textContent = "Выбор блока";

  description.style.margin = "0";
  description.style.color = "#5e6740";
  description.textContent = "Наведите курсор, при необходимости уточните уровень блока и отправьте фрагмент в Pi.";
}

function applyControlButtonStyles(button: HTMLButtonElement, variant: "primary" | "secondary"): void {
  button.type = "button";
  button.style.border = variant === "primary" ? "1px solid #6f7f3a" : "1px solid #c4cca8";
  button.style.borderRadius = "10px";
  button.style.padding = "9px 12px";
  button.style.font = "600 13px/1.2 Inter, system-ui, sans-serif";
  button.style.cursor = "pointer";
  button.style.pointerEvents = "auto";
  button.style.background = variant === "primary" ? "#6f7f3a" : "#eef2de";
  button.style.color = variant === "primary" ? "#f8faf0" : "#3a4123";
  button.style.boxShadow = variant === "primary" ? "0 8px 18px rgba(78, 87, 39, 0.18)" : "none";
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
  root.style.background = "rgba(67, 78, 34, 0.18)";
  root.style.zIndex = "2147483647";
  return root;
}

export function createSelectionOverlay(callbacks: {
  onNarrow(): void;
  onWiden(): void;
  onConfirm(): void;
  onCancel(): void;
}): SelectionOverlayControls {
  const container = document.createElement("div");
  const highlightBox = document.createElement("div");
  const panel = document.createElement("div");
  const title = document.createElement("h2");
  const description = document.createElement("p");
  const actions = document.createElement("div");
  const narrowButton = document.createElement("button");
  const widenButton = document.createElement("button");
  const confirmButton = document.createElement("button");
  const cancelButton = document.createElement("button");
  let modalRoot: HTMLDivElement | null = null;
  let modalCleanup: (() => void) | undefined;

  applyOverlayStyles(container, highlightBox, panel, title, description);

  actions.style.display = "grid";
  actions.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
  actions.style.gap = "8px";
  actions.setAttribute(UI_ATTRIBUTE, "true");

  narrowButton.dataset.testid = "picker-narrow";
  narrowButton.textContent = "Мельче";
  narrowButton.addEventListener("click", callbacks.onNarrow);
  applyControlButtonStyles(narrowButton, "secondary");

  widenButton.dataset.testid = "picker-widen";
  widenButton.textContent = "Крупнее";
  widenButton.addEventListener("click", callbacks.onWiden);
  applyControlButtonStyles(widenButton, "secondary");

  confirmButton.textContent = "Отправить в Pi";
  confirmButton.addEventListener("click", callbacks.onConfirm);
  applyControlButtonStyles(confirmButton, "primary");

  cancelButton.textContent = "Отмена";
  cancelButton.addEventListener("click", callbacks.onCancel);
  applyControlButtonStyles(cancelButton, "secondary");

  actions.append(narrowButton, widenButton, confirmButton, cancelButton);
  panel.append(title, description, actions);
  container.append(highlightBox, panel);
  getOverlayHost().append(container);

  return {
    update(target) {
      const rect = target.getBoundingClientRect();
      setBoxFromRect(highlightBox, rect);
    },
    setNavigationState(state) {
      narrowButton.disabled = !state.canNarrow;
      widenButton.disabled = !state.canWiden;
      narrowButton.setAttribute("aria-disabled", String(!state.canNarrow));
      widenButton.setAttribute("aria-disabled", String(!state.canWiden));
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
      panel.style.border = "1px solid #d1d8b6";
      panel.style.borderRadius = "14px";
      panel.style.background = "#faf9f2";
      panel.style.color = "#2f361c";
      panel.style.boxShadow = "0 24px 60px rgba(78, 87, 39, 0.18)";
      panel.style.font = "14px/1.45 Inter, system-ui, sans-serif";

      heading.textContent = "Отправить в Pi";
      heading.style.margin = "0";
      heading.style.font = "700 18px/1.2 Inter, system-ui, sans-serif";

      description.textContent = "Добавьте комментарий (необязательно)";
      description.style.margin = "0";
      description.style.color = "#5e6740";

      textarea.rows = 5;
      textarea.placeholder = "Добавьте комментарий (необязательно)";
      textarea.style.width = "100%";
      textarea.style.boxSizing = "border-box";
      textarea.style.padding = "10px 12px";
      textarea.style.border = "1px solid #c4cca8";
      textarea.style.borderRadius = "10px";
      textarea.style.background = "#fffffa";
      textarea.style.color = "#2f361c";
      textarea.style.resize = "vertical";

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
