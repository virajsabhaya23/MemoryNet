document.documentElement.classList.add("js");
const revealTargets = document.querySelectorAll(
  ".workflow-section, .context-section, .readiness-section, .start-section, .requirements-bar",
);
revealTargets.forEach((el) => el.classList.add("reveal"));
if (
  "IntersectionObserver" in window &&
  !matchMedia("(prefers-reduced-motion: reduce)").matches
) {
  const revealObserver = new IntersectionObserver(
    (entries) =>
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          revealObserver.unobserve(entry.target);
        }
      }),
    { threshold: 0.12 },
  );
  revealTargets.forEach((el) => revealObserver.observe(el));
} else {
  revealTargets.forEach((el) => el.classList.add("is-visible"));
}

const screens = {
  network: {
    file: "./assets/product-network.webp",
    width: 2160,
    height: 1350,
    alt: "Actual MemoryNet network with synthetic example data: a pull request selected inside the Checkout project cell, with its evidence details and the memories that cite it.",
    caption:
      "Actual app with synthetic example data. A pull request inside its project cell.",
  },
  work: {
    file: "./assets/product-review.webp",
    width: 1816,
    height: 1136,
    alt: "Actual MemoryNet review queue: candidates imported from real Vercel pull requests wait for review, with the next one ready to read and decide.",
    caption:
      "Actual app. Real Vercel PR evidence. Candidates remain pending review.",
  },
  decision: {
    file: "./assets/product-source.webp",
    width: 1816,
    height: 1136,
    alt: "Actual source browser showing original Next.js files at a verified, pinned commit.",
    caption:
      "Actual app. Original Next.js source at a verified, pinned commit.",
  },
};

document.querySelectorAll("[data-screen]").forEach((button) => {
  button.addEventListener("click", () => {
    const screen = screens[button.dataset.screen];
    if (!screen) return;
    const image = document.querySelector("#screen-image");
    image.src = screen.file;
    image.width = screen.width;
    image.height = screen.height;
    image.alt = screen.alt;
    document.querySelector("#screen-caption").textContent = screen.caption;
    const expanded = document.querySelector("#expand-screen");
    expanded.href = screen.file;
    expanded.setAttribute(
      "aria-label",
      `Open full-size ${button.textContent.toLowerCase()} screenshot`,
    );
    document.querySelectorAll("[data-screen]").forEach((other) => {
      other.setAttribute("aria-pressed", String(other === button));
      other
        .closest(".screen-choice")
        ?.classList.toggle("is-active", other === button);
    });
  });
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const code = document.getElementById(button.dataset.copy);
    const feedback = button.parentElement.querySelector('[role="status"]');
    if (!code || !feedback) return;
    button.setAttribute("aria-busy", "true");
    try {
      await navigator.clipboard.writeText(code.textContent);
      feedback.textContent = "Copied.";
    } catch {
      feedback.textContent =
        "Copy unavailable. Select the commands below to copy them.";
    } finally {
      button.removeAttribute("aria-busy");
    }
  });
});

document.addEventListener("click", (event) => {
  const link = event.target.closest("[data-show-screen]");
  if (link && screens[link.dataset.showScreen])
    document
      .querySelector(`[data-screen="${link.dataset.showScreen}"]`)
      ?.click();
});

document.querySelectorAll("[data-tabs]").forEach((group) => {
  const buttons = [...group.querySelectorAll("[data-tab-btn]")];
  const panels = group.querySelectorAll("[data-tab-panel]");
  // Without script every panel stays visible; with it, one panel shows at a time.
  const select = (button, focus) => {
    buttons.forEach((other) => {
      other.setAttribute("aria-selected", String(other === button));
      other.tabIndex = other === button ? 0 : -1;
    });
    panels.forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== button.dataset.tabBtn;
    });
    if (focus) button.focus();
  };
  if (!buttons.length) return;
  select(
    buttons.find((button) => button.getAttribute("aria-selected") === "true") ||
      buttons[0],
    false,
  );
  buttons.forEach((button, index) => {
    button.addEventListener("click", () => select(button, false));
    button.addEventListener("keydown", (event) => {
      const target = {
        ArrowRight: index + 1,
        ArrowLeft: index - 1,
        Home: 0,
        End: buttons.length - 1,
      }[event.key];
      if (target === undefined) return;
      event.preventDefault();
      select(buttons[(target + buttons.length) % buttons.length], true);
    });
  });
});

const menuToggle = document.querySelector(".nav-toggle");
const mainNavigation = document.querySelector("#main-navigation");
if (menuToggle && mainNavigation) {
  menuToggle.hidden = false;
  menuToggle.closest("header").classList.add("nav-enhanced");
  const closeMenu = () => menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.addEventListener("click", () =>
    menuToggle.setAttribute(
      "aria-expanded",
      String(menuToggle.getAttribute("aria-expanded") !== "true"),
    ),
  );
  mainNavigation
    .querySelectorAll("a")
    .forEach((link) => link.addEventListener("click", closeMenu));
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      menuToggle.getAttribute("aria-expanded") === "true"
    ) {
      closeMenu();
      menuToggle.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!menuToggle.closest("header").contains(event.target)) closeMenu();
  });
}

window.hallmarkSlots = (replacements) => {
  for (const [name, value] of Object.entries(replacements)) {
    const slot = [...document.querySelectorAll("[data-slot]")].find(
      (item) => item.dataset.slot === name,
    );
    if (!slot) continue;
    const image = new Image();
    image.src = typeof value === "string" ? value : value.src;
    image.alt =
      (typeof value === "object" && value.alt) || slot.dataset.alt || "";
    slot
      .querySelectorAll(":scope > img")
      .forEach((previous) => previous.remove());
    slot.prepend(image);
  }
};
