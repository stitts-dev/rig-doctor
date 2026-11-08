// Side panels float over a full-window globe. Collapsed, the left shows only its toggle and the
// right keeps the selected route's summary; each toggle opens the rest.
// Open state is remembered per panel.
type Side = "left" | "right";

const KEY = "rd.dock";

function load(): Record<Side, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { left: v.left === true, right: v.right === true };
  } catch {
    return { left: false, right: false };
  }
}

function save(s: Record<Side, boolean>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable: state just isn't remembered */
  }
}

export function mountDock(): void {
  const app = document.getElementById("app");
  if (!app) return;
  const open = load();
  const toggles: Record<Side, HTMLButtonElement | null> = {
    left: document.getElementById("dockLeft") as HTMLButtonElement | null,
    right: document.getElementById("dockRight") as HTMLButtonElement | null,
  };
  const apply = (): void => {
    for (const side of ["left", "right"] as Side[]) {
      app.classList.toggle(`${side}-open`, open[side]);
      toggles[side]?.setAttribute("aria-expanded", String(open[side]));
    }
  };
  for (const side of ["left", "right"] as Side[]) {
    toggles[side]?.addEventListener("click", () => {
      open[side] = !open[side];
      apply();
      save(open);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || (!open.left && !open.right)) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA")) return;
    open.left = open.right = false;
    apply();
    save(open);
  });
  apply();
}
