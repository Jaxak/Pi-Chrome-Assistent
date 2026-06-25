const STYLE_ATTRIBUTE = "data-pi-crosshair-style";
const ROOT_ATTRIBUTE = "data-pi-crosshair-root";
const DOT_ATTRIBUTE = "data-pi-crosshair-dot";
const OUTLINE_ATTRIBUTE = "data-pi-crosshair-outline";
const CORNER_ATTRIBUTE = "data-pi-crosshair-corner";
const Z_INDEX = "2147483645";

type CrosshairOptions = {
  enabled?: boolean;
  animate?: boolean;
  dotSize?: number;
  outlineSpace?: number;
  dotColor?: string;
  outlineColor?: string;
  hoverPadding?: { x: number; y: number };
  useBlend?: boolean;
  outlineSize?: number;
};

export type CrosshairHighlighterControls = {
  updatePointer(x: number, y: number): void;
  updateTarget(target: Element, options?: { selected?: boolean }): void;
  clearTarget(): void;
  cleanup(): void;
};

type CrosshairState = {
  mouseX: number;
  mouseY: number;
  outlineX: number;
  outlineY: number;
  width: number;
  height: number;
  rotation: number;
  target: { x: number; y: number; width: number; height: number } | null;
};

function getHost(): HTMLElement {
  return document.body ?? document.documentElement;
}

function createStyle(options: Required<CrosshairOptions>): HTMLStyleElement {
  const style = document.createElement("style");
  style.setAttribute(STYLE_ATTRIBUTE, "true");
  style.textContent = `
    [${ROOT_ATTRIBUTE}] {
      position: fixed !important;
      inset: 0 !important;
      pointer-events: none !important;
      z-index: ${Z_INDEX} !important;
    }

    [${DOT_ATTRIBUTE}] {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: ${options.dotSize}px !important;
      height: ${options.dotSize}px !important;
      background-color: ${options.dotColor} !important;
      border-radius: 50% !important;
      pointer-events: none !important;
      z-index: ${Z_INDEX} !important;
      transform: translate(-50%, -50%) !important;
      transition: opacity 0.2s ease !important;
      display: block !important;
    }

    [${OUTLINE_ATTRIBUTE}] {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      pointer-events: none !important;
      z-index: ${Z_INDEX} !important;
      width: ${options.outlineSpace}px;
      height: ${options.outlineSpace}px;
      box-sizing: border-box !important;
      display: block !important;
      border: ${options.outlineSize}px solid ${options.outlineColor} !important;
      background: rgba(255, 0, 0, 0.14) !important;
      box-shadow: 0 0 0 1px rgba(255, 0, 0, 0.42), 0 0 18px rgba(255, 0, 0, 0.28) !important;
      ${options.useBlend ? "mix-blend-mode: difference !important;" : ""}
    }

    [${OUTLINE_ATTRIBUTE}][data-pi-crosshair-selected="true"] {
      filter: drop-shadow(0 0 10px rgba(255, 0, 0, 0.85));
    }

    [${CORNER_ATTRIBUTE}] {
      position: absolute !important;
      width: 10px !important;
      height: 10px !important;
      box-sizing: border-box !important;
      display: block !important;
      transition: all 0.2s ease !important;
    }

    [${CORNER_ATTRIBUTE}="top-left"] {
      top: 0 !important;
      left: 0 !important;
      border-top: ${options.outlineSize}px solid ${options.outlineColor} !important;
      border-left: ${options.outlineSize}px solid ${options.outlineColor} !important;
    }

    [${CORNER_ATTRIBUTE}="top-right"] {
      top: 0 !important;
      right: 0 !important;
      border-top: ${options.outlineSize}px solid ${options.outlineColor} !important;
      border-right: ${options.outlineSize}px solid ${options.outlineColor} !important;
    }

    [${CORNER_ATTRIBUTE}="bottom-left"] {
      bottom: 0 !important;
      left: 0 !important;
      border-bottom: ${options.outlineSize}px solid ${options.outlineColor} !important;
      border-left: ${options.outlineSize}px solid ${options.outlineColor} !important;
    }

    [${CORNER_ATTRIBUTE}="bottom-right"] {
      right: 0 !important;
      bottom: 0 !important;
      border-right: ${options.outlineSize}px solid ${options.outlineColor} !important;
      border-bottom: ${options.outlineSize}px solid ${options.outlineColor} !important;
    }
  `;
  return style;
}

function createCorner(position: string): HTMLDivElement {
  const corner = document.createElement("div");
  corner.setAttribute(CORNER_ATTRIBUTE, position);
  return corner;
}

function applyOutline(outline: HTMLDivElement, state: CrosshairState): void {
  outline.style.width = `${state.width}px`;
  outline.style.height = `${state.height}px`;
  outline.style.transform = `translate(${state.outlineX}px, ${state.outlineY}px) translate(-50%, -50%) rotate(${state.rotation}deg)`;
}

function normalizeOptions(options: CrosshairOptions = {}): Required<CrosshairOptions> {
  return {
    enabled: options.enabled ?? true,
    animate: options.animate ?? true,
    dotSize: options.dotSize ?? 6,
    outlineSpace: options.outlineSpace ?? 30,
    dotColor: options.dotColor ?? "#ffffff",
    outlineColor: options.outlineColor ?? "#ff0000",
    hoverPadding: options.hoverPadding ?? { x: 15, y: 10 },
    useBlend: options.useBlend ?? false,
    outlineSize: options.outlineSize ?? 2,
  };
}

export function createCrosshairHighlighter(options: CrosshairOptions = {}): CrosshairHighlighterControls {
  const resolved = normalizeOptions(options);
  let cleanedUp = false;
  let animationFrame: number | undefined;

  if (!resolved.enabled) {
    return {
      updatePointer() {},
      updateTarget() {},
      clearTarget() {},
      cleanup() {},
    };
  }

  const style = createStyle(resolved);
  const root = document.createElement("div");
  const dot = document.createElement("div");
  const outline = document.createElement("div");
  const state: CrosshairState = {
    mouseX: window.innerWidth / 2,
    mouseY: window.innerHeight / 2,
    outlineX: window.innerWidth / 2,
    outlineY: window.innerHeight / 2,
    width: resolved.outlineSpace,
    height: resolved.outlineSpace,
    rotation: 0,
    target: null,
  };

  root.setAttribute(ROOT_ATTRIBUTE, "true");
  root.setAttribute("data-pi-picker-ui", "true");
  dot.setAttribute(DOT_ATTRIBUTE, "true");
  outline.setAttribute(OUTLINE_ATTRIBUTE, "true");
  outline.dataset.piCrosshairHovering = "false";
  outline.dataset.piCrosshairSelected = "false";
  outline.append(
    createCorner("top-left"),
    createCorner("top-right"),
    createCorner("bottom-left"),
    createCorner("bottom-right"),
  );
  root.append(dot, outline);
  document.head.append(style);
  getHost().append(root);
  applyOutline(outline, state);

  function tick(): void {
    if (cleanedUp) {
      return;
    }

    if (state.target) {
      state.outlineX += (state.target.x - state.outlineX) * 0.15;
      state.outlineY += (state.target.y - state.outlineY) * 0.15;
      state.width += (state.target.width - state.width) * 0.15;
      state.height += (state.target.height - state.height) * 0.15;
      state.rotation += (Math.round(state.rotation / 180) * 180 - state.rotation) * 0.15;
    } else {
      state.outlineX += (state.mouseX - state.outlineX) * 0.15;
      state.outlineY += (state.mouseY - state.outlineY) * 0.15;
      state.width += (resolved.outlineSpace - state.width) * 0.15;
      state.height += (resolved.outlineSpace - state.height) * 0.15;
      state.rotation += 1.5;
    }

    applyOutline(outline, state);
    animationFrame = window.requestAnimationFrame(tick);
  }

  if (resolved.animate) {
    animationFrame = window.requestAnimationFrame(tick);
  }

  return {
    updatePointer(x, y) {
      state.mouseX = x;
      state.mouseY = y;
      dot.style.transform = `translate(calc(${x}px - 50%), calc(${y}px - 50%))`;

      if (!state.target && !resolved.animate) {
        state.outlineX = x;
        state.outlineY = y;
        applyOutline(outline, state);
      }
    },
    updateTarget(target, targetOptions) {
      const rect = target.getBoundingClientRect();
      state.target = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        width: Math.max(0, rect.width + resolved.hoverPadding.x),
        height: Math.max(0, rect.height + resolved.hoverPadding.y),
      };
      outline.dataset.piCrosshairHovering = "true";
      outline.dataset.piCrosshairSelected = String(targetOptions?.selected ?? false);

      if (!resolved.animate) {
        state.outlineX = state.target.x;
        state.outlineY = state.target.y;
        state.width = state.target.width;
        state.height = state.target.height;
        state.rotation = 0;
        applyOutline(outline, state);
      }
    },
    clearTarget() {
      state.target = null;
      outline.dataset.piCrosshairHovering = "false";
      outline.dataset.piCrosshairSelected = "false";

      if (!resolved.animate) {
        state.width = resolved.outlineSpace;
        state.height = resolved.outlineSpace;
        applyOutline(outline, state);
      }
    },
    cleanup() {
      cleanedUp = true;

      if (animationFrame !== undefined) {
        window.cancelAnimationFrame(animationFrame);
      }

      if (root.isConnected) {
        root.remove();
      }

      if (style.isConnected) {
        style.remove();
      }
    },
  };
}
